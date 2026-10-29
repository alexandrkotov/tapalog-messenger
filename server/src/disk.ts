import { readdirSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DiskUsageDto } from "@tapalog-messenger/shared";

/**
 * How much room the data takes: the database (with its write-ahead log),
 * the stored files, and what is left on the disk under the data folder.
 */
export function diskUsage(dbPath: string, mediaDir: string): DiskUsageDto {
  const size = (path: string) => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  };
  let mediaBytes = 0;
  let mediaFiles = 0;
  let buckets: string[] = [];
  try {
    buckets = readdirSync(mediaDir).filter((d) => /^[0-9a-f]{2}$/.test(d));
  } catch {
    // No uploads yet.
  }
  for (const dir of buckets) {
    for (const name of readdirSync(join(mediaDir, dir))) {
      mediaBytes += size(join(mediaDir, dir, name));
      mediaFiles++;
    }
  }
  let free: number | null = null;
  let total: number | null = null;
  try {
    const fs = statfsSync(mediaDir);
    free = fs.bavail * fs.bsize;
    total = fs.blocks * fs.bsize;
  } catch {
    // Not every file system answers.
  }
  return {
    db_bytes: size(dbPath) + size(`${dbPath}-wal`),
    media_bytes: mediaBytes,
    media_files: mediaFiles,
    free_bytes: free,
    total_bytes: total,
  };
}
