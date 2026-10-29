import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TurnDto } from "@tapalog-messenger/shared";

/**
 * A TURN relay (coturn) for calls that cannot go directly. It shares a
 * secret with this server (coturn's `use-auth-secret`), and the server hands
 * a signed-in user a password that works for a few hours: username
 * `<expiry in s>:<user id>`, credential base64(HMAC-SHA1(secret, username)).
 * The secret itself never leaves the server.
 */
export interface TurnConfig {
  urls: string[];
  secret: string;
}

export const TURN_TTL_S = 6 * 3600;
const MIN_SECRET_LENGTH = 16;

export function turnCredentials(turn: TurnConfig, userId: number, nowMs: number): TurnDto {
  const expires = Math.floor(nowMs / 1000) + TURN_TTL_S;
  const username = `${expires}:${userId}`;
  const credential = createHmac("sha1", turn.secret).update(username).digest("base64");
  return { ice_servers: [{ urls: turn.urls, username, credential }], expires_at: expires * 1000 };
}

/** `turn:host:3478`, `turn:host:3478?transport=tcp`, `turns:host:5349`. */
export function isTurnUrl(raw: string): boolean {
  return /^turns?:[^\s/?#@]+(:\d{1,5})?(\?transport=(udp|tcp))?$/.test(raw);
}

export function readTurnSecret(path: string): string {
  let secret: string;
  try {
    secret = readFileSync(path, "utf-8").trim();
  } catch (err) {
    throw new Error(`Cannot read the TURN secret from ${path}: ${err instanceof Error ? err.message : err}`);
  }
  if (secret.length < MIN_SECRET_LENGTH || /\s/.test(secret)) {
    throw new Error(`${path} must hold one secret of at least ${MIN_SECRET_LENGTH} characters, the same as coturn's static-auth-secret`);
  }
  return secret;
}
