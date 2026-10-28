import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate, openDatabase, schemaVersion } from "../src/db";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tm-db-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("database", () => {
  it("creates a fresh database in WAL mode at the latest schema", () => {
    const db = openDatabase(tempDir());
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect(db.query("SELECT value FROM meta WHERE key = 'instance_id'").get()).toEqual({ value: expect.stringMatching(/^[0-9a-f]{32}$/) });
    db.close();
  });

  it("reopening an existing database changes nothing", () => {
    const dir = tempDir();
    const first = openDatabase(dir);
    const id = first.query("SELECT value FROM meta WHERE key = 'instance_id'").get();
    first.close();
    const second = openDatabase(dir);
    expect(schemaVersion(second)).toBe(MIGRATIONS.length);
    expect(second.query("SELECT value FROM meta WHERE key = 'instance_id'").get()).toEqual(id);
    second.close();
  });

  it("applies only the migrations past the current version", () => {
    const db = new Database(":memory:");
    expect(migrate(db, ["CREATE TABLE a (x)"])).toBe(1);
    expect(migrate(db, ["CREATE TABLE a (x)", "CREATE TABLE b (y)"])).toBe(2);
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("rolls a failed migration back and keeps the old version", () => {
    const db = new Database(":memory:");
    migrate(db, ["CREATE TABLE a (x)"]);
    expect(() => migrate(db, ["CREATE TABLE a (x)", "CREATE TABLE b (y); INSERT INTO nope VALUES (1)"])).toThrow();
    expect(schemaVersion(db)).toBe(1);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'b'").get()).toBeNull();
  });

  it("refuses a database from a newer build", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA user_version = 99");
    expect(() => migrate(db)).toThrow(/newer than this build/);
  });
});
