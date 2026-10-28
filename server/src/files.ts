import type { Database } from "bun:sqlite";
import { INLINE_IMAGE_TYPES, LIMITS, MEDIA_ID_RE } from "@tapalog-messenger/shared";
import type { Session } from "./auth";
import { error, json, withHeaders } from "./http";
import * as media from "./store/media";

/**
 * Uploads (POST /api/media, PUT /api/media/{id}/thumb) and downloads
 * (GET /media/{id}, GET /media/{id}/thumb). A body is the raw file, not a
 * multipart form, so it streams to disk and 50 MB never sit in memory.
 */

const HOUR_MS = 3600 * 1000;
const THUMB_TYPES = ["image/webp", "image/jpeg", "image/png"];

/** Counts bytes per person in a sliding hour. */
export class ByteBudget {
  private spent = new Map<number, { at: number; bytes: number }[]>();

  constructor(private readonly limit: number) {}

  left(userId: number, now: number): number {
    const recent = (this.spent.get(userId) ?? []).filter((e) => e.at > now - HOUR_MS);
    this.spent.set(userId, recent);
    return this.limit - recent.reduce((sum, e) => sum + e.bytes, 0);
  }

  spend(userId: number, bytes: number, now: number): void {
    this.spent.set(userId, [...(this.spent.get(userId) ?? []), { at: now, bytes }]);
  }
}

/** `type/subtype` from a Content-Type header, parameters dropped; anything odd becomes a plain download type. */
export function cleanMime(header: string | null): string {
  const mime = (header ?? "").split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(mime) ? mime : "application/octet-stream";
}

/** A file name safe to store and to send back in a header: no folders, no control characters. */
export function cleanName(raw: string | null): string {
  const name = (raw ?? "")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "")
    .trim()
    .slice(0, LIMITS.fileName);
  return name || "file";
}

const posInt = (v: string | null, max: number): number | undefined => {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : NaN;
};

function parseWaveform(v: string | null): number[] | undefined | null {
  if (v === null) return undefined;
  const levels = v.split(",").map(Number);
  return levels.length <= LIMITS.waveformPoints && levels.every((n) => Number.isInteger(n) && n >= 0 && n <= 100) ? levels : null;
}

/** Only for a browser's own previews: pictures and sound play in place, everything else downloads. */
function isInline(mime: string): boolean {
  return (INLINE_IMAGE_TYPES as readonly string[]).includes(mime) || mime.startsWith("audio/") || mime.startsWith("video/");
}

/** `Range: bytes=…` → the one span asked for, "bad" if it cannot be served, null to send everything. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "bad" | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null; // absent, or several ranges: the whole file is a valid answer
  const [, a, b] = m;
  if (a === "" && b === "") return "bad";
  let start: number;
  let end: number;
  if (a === "") {
    start = Math.max(0, size - Number(b));
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  return start > end || start >= size ? "bad" : { start, end };
}

export function createFiles(ctx: { db: Database; mediaDir: string; now: () => number }) {
  const { db, mediaDir } = ctx;
  const budget = new ByteBudget(LIMITS.uploadBytesPerHour);

  /** Refuses up front what Content-Length already says will not fit. */
  const declaredTooBig = (req: Request, max: number) => Number(req.headers.get("Content-Length") ?? 0) > max;

  async function upload(req: Request, url: URL, s: Session): Promise<Response> {
    const q = url.searchParams;
    const width = posInt(q.get("width"), 50_000);
    const height = posInt(q.get("height"), 50_000);
    const durationMs = posInt(q.get("duration_ms"), LIMITS.voiceMs * 4);
    const waveform = parseWaveform(q.get("waveform"));
    if ([width, height, durationMs].some((n) => Number.isNaN(n)) || waveform === null) return error("bad_request");
    if (declaredTooBig(req, LIMITS.fileBytes)) return error("too_large");
    const room = budget.left(s.user.id, ctx.now());
    if (room <= 0) return error("rate_limited");

    const saved = await media.saveBlob(mediaDir, req.body, Math.min(LIMITS.fileBytes, room));
    if (saved === "empty") return error("bad_request");
    if (saved === "too_large") return error(room < LIMITS.fileBytes ? "rate_limited" : "too_large");
    budget.spend(s.user.id, saved.size, ctx.now());
    const row = media.createMedia(db, {
      ownerId: s.user.id,
      ...saved,
      mime: cleanMime(req.headers.get("Content-Type")),
      name: cleanName(q.get("name")),
      width,
      height,
      durationMs,
      waveform,
      now: ctx.now(),
    });
    return json(media.mediaDto(row), 201);
  }

  /** The uploader adds a photo's preview, until the photo has been sent. */
  async function putThumb(req: Request, id: string, s: Session): Promise<Response> {
    const row = MEDIA_ID_RE.test(id) ? media.getMedia(db, id) : null;
    if (!row || row.owner_id !== s.user.id) return error("not_found");
    if (media.isAttached(db, id)) return error("forbidden");
    const mime = cleanMime(req.headers.get("Content-Type"));
    if (!THUMB_TYPES.includes(mime)) return error("bad_request");
    if (declaredTooBig(req, LIMITS.thumbBytes)) return error("too_large");
    const saved = await media.saveBlob(mediaDir, req.body, LIMITS.thumbBytes);
    if (typeof saved === "string") return error(saved === "empty" ? "bad_request" : "too_large");
    media.setThumb(db, id, saved.sha256, mime);
    return json(media.mediaDto(media.getMedia(db, id)!));
  }

  /** GET /media/{id}[/thumb]: only for those who may see it, with Range so voice and long files can seek. */
  async function serve(req: Request, url: URL, s: Session | null): Promise<Response> {
    const [, , id = "", variant, extra] = url.pathname.split("/");
    if (!s) return error("unauthorized");
    if (!MEDIA_ID_RE.test(id) || extra !== undefined || (variant !== undefined && variant !== "thumb")) return error("not_found");
    const row = media.getMedia(db, id);
    // Not yours and not shared with you looks the same as not there: ids are not confirmed to strangers.
    if (!row || !media.canRead(db, id, s.user.id)) return error("not_found");
    const thumb = variant === "thumb";
    const sha = thumb ? row.thumb_sha256 : row.sha256;
    const mime = thumb ? row.thumb_mime! : row.mime;
    if (!sha) return error("not_found");
    const file = Bun.file(media.blobPath(mediaDir, sha));
    if (!(await file.exists())) return error("not_found");

    const size = file.size;
    const download = url.searchParams.has("download") || !isInline(mime);
    const name = thumb ? `preview-${row.name}` : row.name;
    const headers = {
      "Content-Type": mime,
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      // The bytes behind an id never change. Private: no shared cache between here and the browser keeps a copy.
      "Cache-Control": "private, max-age=31536000, immutable",
      // Even if a browser tried to render it as a page, it gets no scripts and no same-origin rights.
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Accept-Ranges": "bytes",
    };
    const range = parseRange(req.headers.get("Range"), size);
    if (range === "bad") return withHeaders(new Response(null, { status: 416 }), { ...headers, "Content-Range": `bytes */${size}` });
    if (range) {
      const part = file.slice(range.start, range.end + 1);
      return withHeaders(new Response(req.method === "HEAD" ? null : part, { status: 206 }), {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(range.end - range.start + 1),
      });
    }
    return withHeaders(new Response(req.method === "HEAD" ? null : file), { ...headers, "Content-Length": String(size) });
  }

  return { upload, putThumb, serve };
}
