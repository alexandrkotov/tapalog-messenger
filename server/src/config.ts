import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTurnUrl, readTurnSecret, type TurnConfig } from "./turn";

/**
 * Settings that outlive one run, in messenger-data/config.json: give a flag
 * once, then plain double-clicks keep it. The tunnel token is a secret, so
 * the file is readable by its owner only.
 */
export interface Config {
  public_url?: string;
  tunnel_token?: string;
  /** The calls relay; its secret is why this file is owner-only. */
  turn?: TurnConfig;
}

export const CONFIG_FILE = "config.json";

export function readConfig(dataDir: string): Config {
  const path = join(dataDir, CONFIG_FILE);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw !== "object" || raw === null) return {};
    const { public_url, tunnel_token, turn } = raw as Record<string, unknown>;
    return {
      ...(typeof public_url === "string" && { public_url }),
      ...(typeof tunnel_token === "string" && { tunnel_token }),
      ...(isTurnConfig(turn) && { turn: { urls: turn.urls, secret: turn.secret } }),
    };
  } catch {
    throw new Error(`${path} is not valid JSON. Fix or delete it, then start again.`);
  }
}

function isTurnConfig(v: unknown): v is TurnConfig {
  if (typeof v !== "object" || v === null) return false;
  const { urls, secret } = v as Record<string, unknown>;
  return Array.isArray(urls) && urls.length > 0 && urls.every((u) => typeof u === "string" && isTurnUrl(u)) && typeof secret === "string" && secret.length > 0;
}

/**
 * --turn-url and --turn-secret-file: given once, kept in the config. Either
 * may be given alone later to change just that part.
 */
export function withTurnFlags(config: Config, urls: string[], secretFile: string | null): Config {
  if (urls.length === 0 && !secretFile) return config;
  const turn = {
    urls: urls.length > 0 ? urls : config.turn?.urls,
    secret: secretFile ? readTurnSecret(secretFile) : config.turn?.secret,
  };
  if (!turn.urls || !turn.secret) throw new Error("TURN needs both --turn-url and --turn-secret-file the first time.");
  return { ...config, turn: { urls: turn.urls, secret: turn.secret } };
}

export function writeConfig(dataDir: string, config: Config): void {
  const path = join(dataDir, CONFIG_FILE);
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX modes; the file sits in the user's own folder.
  }
}
