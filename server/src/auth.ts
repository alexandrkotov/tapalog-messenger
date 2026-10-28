import type { Database } from "bun:sqlite";
import { sessionByToken, touchDevice, type UserRow } from "./store/accounts";

/**
 * Sessions live in a cookie. Over HTTPS (the tunnel) it is `__Host-session`
 * with `Secure`, which also keeps sibling subdomains from planting one. On
 * plain http://localhost it is `session` without `Secure`, because Safari
 * drops Secure cookies on http even for localhost.
 */
export const SECURE_COOKIE = "__Host-session";
export const PLAIN_COOKIE = "session";
const YEAR_S = 365 * 24 * 3600;

export interface Session {
  user: UserRow;
  deviceId: number;
}

export interface Origins {
  /** Origins a browser may call the API and open the WebSocket from. */
  allowed: Set<string>;
  /** Host of the public HTTPS address, if any; requests for it get Secure cookies. */
  publicHost: string | null;
}

export function originsFor(port: number, publicUrl: string | null): Origins {
  const allowed = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  if (publicUrl) allowed.add(new URL(publicUrl).origin);
  return { allowed, publicHost: publicUrl ? new URL(publicUrl).host : null };
}

/**
 * A browser always sends Origin on a WebSocket handshake and on POST, PATCH
 * and DELETE; when it does, it must be ours. (No Origin means not a browser,
 * and then there is no ambient cookie to abuse.)
 */
export function originAllowed(req: Request, origins: Origins): boolean {
  const origin = req.headers.get("Origin");
  return origin === null || origins.allowed.has(origin);
}

function isSecureRequest(req: Request, origins: Origins): boolean {
  return origins.publicHost !== null && req.headers.get("Host") === origins.publicHost;
}

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

export function sessionCookie(req: Request, origins: Origins, token: string): string {
  return isSecureRequest(req, origins)
    ? `${SECURE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${YEAR_S}`
    : `${PLAIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${YEAR_S}`;
}

export function clearSessionCookie(req: Request, origins: Origins): string {
  return isSecureRequest(req, origins)
    ? `${SECURE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`
    : `${PLAIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

const TOUCH_EVERY_MS = 60_000;

/** The signed-in user behind this request, if any. Keeps the device's last-active time roughly current. */
export function authenticate(db: Database, req: Request, now: number): Session | null {
  const cookies = parseCookies(req.headers.get("Cookie"));
  const token = cookies.get(SECURE_COOKIE) || cookies.get(PLAIN_COOKIE);
  if (!token) return null;
  const found = sessionByToken(db, token);
  if (!found) return null;
  if (now - found.lastActiveAt > TOUCH_EVERY_MS) touchDevice(db, found.deviceId, now);
  return { user: found.user, deviceId: found.deviceId };
}
