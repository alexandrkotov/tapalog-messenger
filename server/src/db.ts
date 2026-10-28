import { Database } from "bun:sqlite";
import { join } from "node:path";
import m0001 from "./migrations/0001_init.sql" with { type: "text" };
import m0002 from "./migrations/0002_core.sql" with { type: "text" };

/**
 * Numbered schema migrations, embedded in the binary as text. Migration N
 * moves the schema from version N-1 to N; the current version is SQLite's
 * own PRAGMA user_version, so no bookkeeping table is needed. Append only:
 * never edit a migration that has shipped.
 */
export const MIGRATIONS: readonly string[] = [m0001, m0002];

export const DB_FILE_NAME = "messenger.db";

export function schemaVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/** Applies every migration past the database's current version, each in its own transaction. */
export function migrate(db: Database, migrations: readonly string[] = MIGRATIONS): number {
  const current = schemaVersion(db);
  if (current > migrations.length) {
    throw new Error(`Database schema ${current} is newer than this build knows (${migrations.length}). Run a newer version of the messenger.`);
  }
  for (let version = current + 1; version <= migrations.length; version++) {
    const sql = migrations[version - 1]!;
    db.transaction(() => {
      db.run(sql);
      // PRAGMA takes no bound parameters; version is our own integer.
      db.run(`PRAGMA user_version = ${version}`);
    })();
  }
  return schemaVersion(db);
}

export function openDatabase(dataDir: string): Database {
  const db = new Database(join(dataDir, DB_FILE_NAME), { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}
