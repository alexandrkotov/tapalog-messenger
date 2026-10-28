import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Settings that outlive one run, in messenger-data/config.json: give a flag
 * once, then plain double-clicks keep it. The tunnel token is a secret, so
 * the file is readable by its owner only.
 */
export interface Config {
  public_url?: string;
  tunnel_token?: string;
}

export const CONFIG_FILE = "config.json";

export function readConfig(dataDir: string): Config {
  const path = join(dataDir, CONFIG_FILE);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw !== "object" || raw === null) return {};
    const { public_url, tunnel_token } = raw as Record<string, unknown>;
    return {
      ...(typeof public_url === "string" && { public_url }),
      ...(typeof tunnel_token === "string" && { tunnel_token }),
    };
  } catch {
    throw new Error(`${path} is not valid JSON. Fix or delete it, then start again.`);
  }
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
