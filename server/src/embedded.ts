import { chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Helper programs built into the executable. A main.compiled.<platform>.ts
 * entry registers the embedded cloudflared here before main runs; plain
 * `bun server/src/main.ts` registers nothing and falls back to a cloudflared
 * on PATH (or TM_CLOUDFLARED).
 */

let embeddedCloudflared: string | null = null;
let extracted: string | null = null;

export function registerEmbeddedCloudflared(path: string) {
  embeddedCloudflared = path;
}

/**
 * An embedded file is a virtual `$bunfs/...` path: Bun can read it, but the
 * OS cannot run it. So it is copied to a real temp file on first use (not on
 * every start: it is 40–55 MB). The pid in the name keeps a second running
 * instance from colliding with a file the first one is still executing
 * (ETXTBSY, seen in ECM).
 */
async function extractEmbedded(embeddedPath: string, name: string): Promise<string> {
  const exe = process.platform === "win32" ? ".exe" : "";
  const realPath = join(tmpdir(), `${name}-${process.pid}${exe}`);
  await Bun.write(realPath, Bun.file(embeddedPath));
  chmodSync(realPath, 0o755);
  return realPath;
}

/** A path the OS can execute, or "cloudflared" to look it up on PATH. */
export async function cloudflaredPath(): Promise<string> {
  if (process.env.TM_CLOUDFLARED) return process.env.TM_CLOUDFLARED;
  if (!embeddedCloudflared) return "cloudflared";
  extracted ??= await extractEmbedded(embeddedCloudflared, "tapalog-messenger-cloudflared");
  return extracted;
}

/** Deletes the temp copy on the way out. Best effort: Windows may still hold it for a moment. */
export function cleanUpExtracted() {
  if (!extracted) return;
  try {
    rmSync(extracted, { force: true });
  } catch {
    // left for the OS temp cleaner
  }
  extracted = null;
}
