import { accessSync, constants, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DATA_DIR_NAME = "messenger-data";

/** Fallback when the binary's own folder is read-only: a .deb puts it in /usr/bin, a Snap in a read-only mount. */
export const HOME_DATA_DIR_NAME = ".tapalog-messenger";

/**
 * True inside a `bun build --compile` executable: its entry module lives in
 * Bun's virtual filesystem, "/$bunfs/…" on POSIX and "B:\~BUN\…" on Windows.
 */
export function isCompiled(mainPath: string = Bun.main): boolean {
  return mainPath.includes("$bunfs") || mainPath.includes("~BUN");
}

export interface DataDirInput {
  /** Value of --data, if given. */
  flag: string | null;
  /** process.execPath — the binary itself when compiled. */
  execPath: string;
  compiled: boolean;
  cwd: string;
  home: string;
  /** Whether a folder can be written to; injectable for tests. */
  isWritable?: (dir: string) => boolean;
}

function defaultIsWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where messenger-data/ lives. --data always wins. A compiled binary keeps
 * its data next to itself, so moving the binary and its folder together
 * moves the whole server; if that folder is read-only, the data goes to the
 * user's home instead. `bun server/src/main.ts` in development keeps it in
 * the current directory, out of the source tree's way via .gitignore.
 */
export function resolveDataDir(input: DataDirInput): string {
  if (input.flag) return resolve(input.cwd, input.flag);
  if (!input.compiled) return join(input.cwd, DATA_DIR_NAME);
  const binaryDir = dirname(input.execPath);
  const isWritable = input.isWritable ?? defaultIsWritable;
  if (isWritable(binaryDir)) return join(binaryDir, DATA_DIR_NAME);
  return join(input.home, HOME_DATA_DIR_NAME);
}

export function ensureDataDir(dir: string): void {
  mkdirSync(join(dir, "media"), { recursive: true });
}
