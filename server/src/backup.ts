import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DB_FILE_NAME } from "./db";

/**
 * Backups of the data folder, into messenger-backups/<YYYY-MM-DD_HH-MM>/ next
 * to it. The database is copied with VACUUM INTO, which gives a consistent
 * snapshot while the server keeps writing. Files in media/ are named by
 * their SHA-256 and never change, so after the snapshot they are hard-linked
 * (no extra space) or, across disks, copied. vapid.json and config.json go
 * too, so a restored server keeps its notification keys and its tunnel;
 * admin.key does not, it is made anew on every start. The newest seven are
 * kept.
 */

export const BACKUPS_DIR_NAME = "messenger-backups";
export const KEEP_BACKUPS = 7;
/** Copied as they are, when present. */
const SIDE_FILES = ["vapid.json", "config.json"];
const NAME_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(-\d+)?$/;
const PARTIAL = ".partial";

export interface BackupInfo {
  name: string;
  dir: string;
  /** Total size of what the backup holds; hard-linked files take no new room on disk. */
  bytes: number;
  files: number;
  at: number;
}

/** messenger-backups beside the data folder. */
export function backupsDirFor(dataDir: string): string {
  return join(dirname(resolve(dataDir)), BACKUPS_DIR_NAME);
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;

/** A hard link where the disk allows it, a copy where it does not. */
function linkOrCopy(from: string, to: string): void {
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

function sizeOf(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = sizeOf(path);
      bytes += inner.bytes;
      files += inner.files;
    } else {
      bytes += statSync(path).size;
      files++;
    }
  }
  return { bytes, files };
}

/** Finished backups, oldest first. */
export function listBackups(backupsDir: string): BackupInfo[] {
  let names: string[];
  try {
    names = readdirSync(backupsDir).filter((n) => NAME_RE.test(n));
  } catch {
    return [];
  }
  return names.sort().map((name) => {
    const dir = join(backupsDir, name);
    return { name, dir, ...sizeOf(dir), at: statSync(dir).mtimeMs };
  });
}

/** Makes one backup now and drops all but the newest `keep`. */
export function makeBackup(db: Database, dataDir: string, opts: { backupsDir?: string; now?: Date; keep?: number } = {}): BackupInfo {
  const backupsDir = opts.backupsDir ?? backupsDirFor(dataDir);
  const now = opts.now ?? new Date();
  mkdirSync(backupsDir, { recursive: true });
  // Leftovers of a backup cut short (the server stopped in the middle).
  for (const n of readdirSync(backupsDir)) if (n.endsWith(PARTIAL)) rmSync(join(backupsDir, n), { recursive: true, force: true });

  let name = stamp(now);
  for (let i = 2; existsSync(join(backupsDir, name)); i++) name = `${stamp(now)}-${i}`;
  const partial = join(backupsDir, name + PARTIAL);
  mkdirSync(partial);
  try {
    db.query("VACUUM INTO $path").run({ path: join(partial, DB_FILE_NAME) });

    // Taken after the snapshot, so every file it refers to is there.
    const media = join(dataDir, "media");
    let buckets: string[] = [];
    try {
      buckets = readdirSync(media).filter((d) => /^[0-9a-f]{2}$/.test(d));
    } catch {
      // No uploads yet.
    }
    for (const bucket of buckets) {
      mkdirSync(join(partial, "media", bucket), { recursive: true });
      for (const file of readdirSync(join(media, bucket))) {
        try {
          linkOrCopy(join(media, bucket, file), join(partial, "media", bucket, file));
        } catch {
          // Deleted by the cleanup in the meantime: then the snapshot does not use it either.
        }
      }
    }
    for (const file of SIDE_FILES) if (existsSync(join(dataDir, file))) copyFileSync(join(dataDir, file), join(partial, file));
    writeFileSync(
      join(partial, "BACKUP.txt"),
      `Tapalog Messenger backup, ${now.toISOString()}.\n` +
        "To restore: stop the server, rename the data folder (messenger-data) to keep it aside,\n" +
        "copy this folder in its place under the name messenger-data, and start the server.\n" +
        "This folder holds every message and the tunnel token: keep it as private as the data folder.\n",
    );
    renameSync(partial, join(backupsDir, name));
  } catch (err) {
    rmSync(partial, { recursive: true, force: true });
    throw err;
  }

  const all = listBackups(backupsDir);
  for (const old of all.slice(0, Math.max(0, all.length - (opts.keep ?? KEEP_BACKUPS)))) rmSync(old.dir, { recursive: true, force: true });
  return listBackups(backupsDir).find((b) => b.name === name)!;
}
