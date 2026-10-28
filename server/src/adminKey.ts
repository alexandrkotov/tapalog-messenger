import { timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the status page and /shutdown. Unlike ECM's collab-server, this
 * server is reachable from the internet through the tunnel, and cloudflared
 * connects from 127.0.0.1 — so "the request came from localhost" proves
 * nothing. A fresh random key per start, written into the data folder, lets
 * the host's own browser (opened with the key in the URL) and a second launch
 * of the binary (which reads the file) in, and nobody else.
 */
export const ADMIN_KEY_FILE = "admin.key";

export function generateAdminKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

/** Written only once the server is listening, so a second launch never overwrites the running instance's key. */
export function writeAdminKey(dataDir: string, key: string): void {
  const path = join(dataDir, ADMIN_KEY_FILE);
  writeFileSync(path, key);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX modes; the file inherits the folder's ACL.
  }
}

export function readAdminKey(dataDir: string): string | null {
  try {
    return readFileSync(join(dataDir, ADMIN_KEY_FILE), "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export function keyMatches(expected: string, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
