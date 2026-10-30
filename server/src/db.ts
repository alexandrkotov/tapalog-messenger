import { Database } from "bun:sqlite";
import { join } from "node:path";
import m0001 from "./migrations/0001_init.sql" with { type: "text" };
import m0002 from "./migrations/0002_core.sql" with { type: "text" };
import m0003 from "./migrations/0003_media.sql" with { type: "text" };
import m0004 from "./migrations/0004_polish.sql" with { type: "text" };
import m0005 from "./migrations/0005_calls.sql" with { type: "text" };

/**
 * Numbered schema migrations, embedded in the binary as text. Migration N
 * moves the schema from version N-1 to N; the current version is SQLite's
 * own PRAGMA user_version, so no bookkeeping table is needed. Append only:
 * never edit a migration that has shipped.
 */
export const MIGRATIONS: readonly string[] = [m0001, m0002, m0003, m0004, m0005];

export const DB_FILE_NAME = "messenger.db";

export function schemaVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/**
 * Applies every migration past the database's current version, each in its
 * own transaction. Foreign keys are off meanwhile, as SQLite's guide to
 * rebuilding a table asks: otherwise dropping the old table would cascade
 * into the tables that point at it. Each migration must leave every key
 * valid, which is checked before it commits.
 */
export function migrate(db: Database, migrations: readonly string[] = MIGRATIONS): number {
  const current = schemaVersion(db);
  if (current > migrations.length) {
    throw new Error(`Database schema ${current} is newer than this build knows (${migrations.length}). Run a newer version of the messenger.`);
  }
  if (current === migrations.length) return current;
  const keysWereOn = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys === 1;
  // A no-op inside a transaction, so it is switched here, between them.
  db.run("PRAGMA foreign_keys = OFF");
  try {
    for (let version = current + 1; version <= migrations.length; version++) {
      const sql = migrations[version - 1]!;
      db.transaction(() => {
        db.run(sql);
        const broken = db.query("PRAGMA foreign_key_check").all();
        if (broken.length) throw new Error(`Migration ${version} left ${broken.length} broken references, e.g. ${JSON.stringify(broken[0])}`);
        // PRAGMA takes no bound parameters; version is our own integer.
        db.run(`PRAGMA user_version = ${version}`);
      })();
    }
  } finally {
    if (keysWereOn) db.run("PRAGMA foreign_keys = ON");
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
