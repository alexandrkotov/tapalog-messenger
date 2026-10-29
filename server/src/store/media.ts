import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { MEDIA_ID_RE, type MediaDto } from "@tapalog-messenger/shared";

/**
 * Uploaded files. The bytes are stored once per content under
 * media/<first two hex digits>/<sha256>, whoever uploaded them and however
 * often; each upload gets its own row with its own random id, name and type.
 * Nothing here decodes a picture or a sound: sizes, durations and previews
 * come from the client.
 */

export interface MediaRow {
  id: string;
  owner_id: number | null;
  sha256: string;
  mime: string;
  size: number;
  name: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  waveform: string | null;
  thumb_sha256: string | null;
  thumb_mime: string | null;
  created_at: number;
}

/** An upload that no message uses is kept this long, so the client can still send it. */
export const UNUSED_KEEP_MS = 24 * 3600 * 1000;
/** Files on disk younger than this are never collected: their row may be about to be written. */
const FRESH_FILE_MS = 3600 * 1000;
const TMP = "tmp";
const AVATAR_TYPES = ["image/webp", "image/jpeg", "image/png"];

export const newMediaId = () => randomBytes(16).toString("base64url");

export function blobPath(mediaDir: string, sha256: string): string {
  return join(mediaDir, sha256.slice(0, 2), sha256);
}

export type SaveResult = { sha256: string; size: number } | "too_large" | "empty";

/**
 * Streams a request body to disk, hashing as it goes, and stops at `maxBytes`
 * without keeping the rest. Lands in media/tmp first and moves into place
 * once complete, so a half-written file never sits under a real hash.
 */
export async function saveBlob(mediaDir: string, body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<SaveResult> {
  if (!body) return "empty";
  mkdirSync(join(mediaDir, TMP), { recursive: true });
  const tmp = join(mediaDir, TMP, `${process.pid}-${randomBytes(8).toString("hex")}`);
  const sink = Bun.file(tmp).writer();
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  let ok = false;
  try {
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > maxBytes) return "too_large";
      hasher.update(chunk);
      sink.write(chunk);
    }
    if (size === 0) return "empty";
    await sink.end();
    const sha256 = hasher.digest("hex");
    const dest = blobPath(mediaDir, sha256);
    if (Bun.file(dest).size === size) rmSync(tmp, { force: true });
    else {
      mkdirSync(join(mediaDir, sha256.slice(0, 2)), { recursive: true });
      renameSync(tmp, dest);
    }
    ok = true;
    return { sha256, size };
  } finally {
    if (!ok) {
      await Promise.resolve(sink.end()).catch(() => {});
      rmSync(tmp, { force: true });
    }
  }
}

export function createMedia(
  db: Database,
  m: { ownerId: number; sha256: string; mime: string; size: number; name: string; width?: number; height?: number; durationMs?: number; waveform?: number[]; now: number },
): MediaRow {
  return db
    .query(
      `INSERT INTO media (id, owner_id, sha256, mime, size, name, width, height, duration_ms, waveform, created_at)
       VALUES ($id, $owner, $sha256, $mime, $size, $name, $width, $height, $duration, $waveform, $now) RETURNING *`,
    )
    .get({
      id: newMediaId(),
      owner: m.ownerId,
      sha256: m.sha256,
      mime: m.mime,
      size: m.size,
      name: m.name,
      width: m.width ?? null,
      height: m.height ?? null,
      duration: m.durationMs ?? null,
      waveform: m.waveform ? m.waveform.join(",") : null,
      now: m.now,
    }) as MediaRow;
}

export function getMedia(db: Database, id: string): MediaRow | null {
  return db.query("SELECT * FROM media WHERE id = $id").get({ id }) as MediaRow | null;
}

export function setThumb(db: Database, id: string, sha256: string, mime: string): void {
  db.query("UPDATE media SET thumb_sha256 = $sha256, thumb_mime = $mime WHERE id = $id").run({ id, sha256, mime });
}

/** Uploads in use as a profile or group photo. */
const AVATARS = "SELECT avatar_media_id FROM users WHERE avatar_media_id IS NOT NULL UNION ALL SELECT avatar_media_id FROM chats WHERE avatar_media_id IS NOT NULL";

/** Whether a message or a profile uses this file already: then it no longer changes. */
export function isAttached(db: Database, id: string): boolean {
  return db.query(`SELECT 1 FROM messages WHERE media_id = $id UNION ALL SELECT 1 FROM (${AVATARS}) WHERE avatar_media_id = $id LIMIT 1`).get({ id }) !== null;
}

/**
 * Who may download a file: whoever uploaded it, the members of every chat
 * where a message that is not deleted carries it, and, for a profile or
 * group photo, everyone signed in.
 */
export function canRead(db: Database, id: string, userId: number): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM media WHERE id = $id AND owner_id = $userId
         UNION ALL
         SELECT 1 FROM messages m JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $userId
         WHERE m.media_id = $id AND m.deleted_at IS NULL
         UNION ALL
         SELECT 1 FROM (${AVATARS}) WHERE avatar_media_id = $id
         LIMIT 1`,
      )
      .get({ id, userId }) !== null
  );
}

/** Whether `userId` may make this upload a profile or group photo: their own picture, not used anywhere yet. */
export function fitsAvatar(db: Database, id: unknown, userId: number): id is string {
  if (typeof id !== "string" || !MEDIA_ID_RE.test(id)) return false;
  const row = getMedia(db, id);
  return !!row && row.owner_id === userId && AVATAR_TYPES.includes(row.mime) && !isAttached(db, id);
}

export function mediaDto(row: MediaRow): MediaDto {
  return {
    id: row.id,
    mime: row.mime,
    size: row.size,
    name: row.name,
    width: row.width,
    height: row.height,
    duration_ms: row.duration_ms,
    waveform: row.waveform ? row.waveform.split(",").map(Number) : null,
    thumb: row.thumb_sha256 !== null,
  };
}

/**
 * Deletes uploads no message or profile uses (once they are a day old; a replaced photo goes the same way) and then every
 * file on disk that no upload points at any more. Run at start and hourly.
 */
export function collectGarbage(db: Database, mediaDir: string, now: number): { rows: number; files: number } {
  const rows = db
    .query(
      `DELETE FROM media WHERE created_at < $cutoff
       AND id NOT IN (SELECT media_id FROM messages WHERE media_id IS NOT NULL) AND id NOT IN (${AVATARS})`,
    )
    .run({ cutoff: now - UNUSED_KEEP_MS }).changes;
  const used = new Set(
    (db.query("SELECT sha256 AS h FROM media UNION SELECT thumb_sha256 FROM media WHERE thumb_sha256 IS NOT NULL").all() as { h: string }[]).map((r) => r.h),
  );
  let files = 0;
  let entries: string[];
  try {
    entries = readdirSync(mediaDir);
  } catch {
    return { rows, files };
  }
  for (const dir of entries) {
    const isBucket = /^[0-9a-f]{2}$/.test(dir);
    if (!isBucket && dir !== TMP) continue;
    for (const name of readdirSync(join(mediaDir, dir))) {
      const path = join(mediaDir, dir, name);
      if (isBucket && used.has(name)) continue;
      // Too fresh: an upload may be writing it, or its row may be about to be inserted.
      if (now - statSync(path).mtimeMs < FRESH_FILE_MS) continue;
      rmSync(path, { force: true });
      files++;
    }
  }
  return { rows, files };
}
