/**
 * Puts the pinned cloudflared for one platform into vendor/, for the
 * matching server/src/main.compiled.<platform>.ts to embed. The version and
 * the SHA-256 of every download are fixed in cloudflared.lock.json, so a
 * build is the same on any day and a tampered download fails the build.
 * To move to a newer cloudflared, change the lock file (version and sums).
 *
 * Usage: bun scripts/fetch-cloudflared.ts <linux-x64|linux-arm64|macos-x64|macos-arm64|windows-x64>
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lock from "./cloudflared.lock.json";

type Platform = keyof typeof lock.assets;

export function vendorName(platform: string): string {
  return platform === "windows-x64" ? "cloudflared-windows-x64.exe" : `cloudflared-${platform}`;
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Throws unless `data` hashes to `expected`. */
export function verify(data: Uint8Array, expected: string, what: string): void {
  const actual = sha256(data);
  if (actual !== expected) throw new Error(`${what}: SHA-256 is ${actual}, expected ${expected}. Not using it.`);
}

async function main() {
  const platform = process.argv[2] as Platform | undefined;
  const spec = platform ? lock.assets[platform] : undefined;
  if (!platform || !spec) {
    console.error(`Usage: bun scripts/fetch-cloudflared.ts <${Object.keys(lock.assets).join("|")}>`);
    process.exit(1);
  }
  const vendorDir = join(import.meta.dir, "..", "vendor");
  mkdirSync(vendorDir, { recursive: true });
  const out = join(vendorDir, vendorName(platform));
  // The download's hash, written next to the binary: the cache key for CI and repeated local builds.
  const stamp = `${out}.sha256`;
  if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, "utf-8").trim() === spec.sha256) {
    console.log(`cloudflared ${lock.version} for ${platform} already in vendor/`);
    return;
  }

  const url = `https://github.com/cloudflare/cloudflared/releases/download/${lock.version}/${spec.file}`;
  const download = join(vendorDir, `_${spec.file}`);
  console.log(`Fetching ${url} …`);
  // curl rather than fetch(): Bun's fetch has been seen to hang on this exact download (found in ECM).
  await Bun.$`curl -fsSL --retry 3 --retry-delay 2 -o ${download} ${url}`;
  verify(readFileSync(download), spec.sha256, spec.file);

  if (spec.file.endsWith(".tgz")) {
    // The archive holds one file named "cloudflared".
    const unpack = join(vendorDir, `_unpack-${platform}`);
    rmSync(unpack, { recursive: true, force: true });
    mkdirSync(unpack);
    await Bun.$`tar -xzf ${download} -C ${unpack}`;
    renameSync(join(unpack, "cloudflared"), out);
    rmSync(unpack, { recursive: true, force: true });
    rmSync(download);
  } else {
    renameSync(download, out);
  }
  await Bun.$`chmod +x ${out}`.nothrow();
  writeFileSync(stamp, spec.sha256 + "\n");
  console.log(`Wrote ${out}`);
}

if (import.meta.main) await main();
