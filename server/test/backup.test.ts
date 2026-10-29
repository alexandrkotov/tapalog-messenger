import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ID } from "@tapalog-messenger/shared";
import { backupsDirFor, KEEP_BACKUPS, listBackups, makeBackup } from "../src/backup";
import { MIGRATIONS, openDatabase, schemaVersion } from "../src/db";
import { startServer } from "../src/server";
import * as accounts from "../src/store/accounts";
import * as chats from "../src/store/chats";
import { blobPath, createMedia, saveBlob } from "../src/store/media";
import { Client } from "./helpers";

let root: string;
let dataDir: string;
let db: Database;

const stream = (s: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });

/** A data folder with two people, a chat with a photo in it, and the side files a real one has. */
async function seed() {
  const hash = await Bun.password.hash("password123");
  const alice = accounts.createUser(db, { username: "alice", displayName: "Alice", passwordHash: hash, isAdmin: true, now: Date.now() }).id;
  const bob = accounts.createUser(db, { username: "bob", displayName: "Bob", passwordHash: hash, isAdmin: false, now: Date.now() }).id;
  const { chatId } = chats.findOrCreateDirect(db, alice, bob, Date.now());
  const saved = await saveBlob(join(dataDir, "media"), stream("jpeg bytes of a sunset"), 1000);
  if (typeof saved === "string") throw new Error(saved);
  const photo = createMedia(db, { ownerId: alice, ...saved, mime: "image/jpeg", name: "sunset.jpg", now: Date.now() });
  chats.sendMessage(db, { chatId, sender: alice, clientId: crypto.randomUUID(), kind: "image", body: "Sunset", mediaId: photo.id, now: Date.now() });
  chats.sendMessage(db, { chatId, sender: bob, clientId: crypto.randomUUID(), kind: "text", body: "Красиво!", now: Date.now() });
  writeFileSync(join(dataDir, "vapid.json"), '{"keys":1}');
  writeFileSync(join(dataDir, "config.json"), '{"tunnel_token":"eyJ..."}');
  writeFileSync(join(dataDir, "admin.key"), "secret");
  return { chatId, photo };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tm-backup-"));
  dataDir = join(root, "messenger-data");
  mkdirSync(dataDir);
  db = openDatabase(dataDir);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("backups", () => {
  it("hold a whole database, every file and the side files, beside the data folder", async () => {
    const { photo } = await seed();
    const b = makeBackup(db, dataDir, { now: new Date(2026, 9, 28, 19, 0) });

    expect(backupsDirFor(dataDir)).toBe(join(root, "messenger-backups"));
    expect(b.dir).toBe(join(root, "messenger-backups", "2026-10-28_19-00"));
    expect(readdirSync(b.dir).sort()).toEqual(["BACKUP.txt", "config.json", "media", "messenger.db", "vapid.json"]);
    // admin.key is made anew on every start; it has no place in a backup.
    expect(existsSync(join(b.dir, "admin.key"))).toBe(false);

    const copy = new Database(join(b.dir, "messenger.db"), { readonly: true });
    expect(schemaVersion(copy)).toBe(MIGRATIONS.length);
    expect(copy.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(copy.query("SELECT body FROM messages ORDER BY seq").all()).toEqual([{ body: "Sunset" }, { body: "Красиво!" }]);
    copy.close();

    const linked = blobPath(join(b.dir, "media"), photo.sha256);
    expect(readFileSync(linked, "utf-8")).toBe("jpeg bytes of a sunset");
    // The same file, not a second copy of it.
    expect(statSync(linked).ino).toBe(statSync(blobPath(join(dataDir, "media"), photo.sha256)).ino);
    expect(b.files).toBe(5);
  });

  it("keep the newest seven, and two in one minute both", async () => {
    await seed();
    for (let day = 1; day <= KEEP_BACKUPS + 2; day++) makeBackup(db, dataDir, { now: new Date(2026, 9, day, 3, 0) });
    makeBackup(db, dataDir, { now: new Date(2026, 9, 9, 3, 0) });
    const names = listBackups(backupsDirFor(dataDir)).map((b) => b.name);
    expect(names).toEqual(["2026-10-04_03-00", "2026-10-05_03-00", "2026-10-06_03-00", "2026-10-07_03-00", "2026-10-08_03-00", "2026-10-09_03-00", "2026-10-09_03-00-2"]);
  });

  it("restore into a server that shows the same conversation and photo", async () => {
    const { chatId, photo } = await seed();
    const b = makeBackup(db, dataDir);

    // What the README says: the backup folder put in place of messenger-data.
    const restored = openDatabase(b.dir);
    const server = startServer({
      port: 0,
      adminKey: "k".repeat(64),
      db: restored,
      mediaDir: join(b.dir, "media"),
      assets: {},
      backup: { dataDir: b.dir, dir: join(root, "more-backups") },
      health: { app: APP_ID, ok: true, version: "0", schema: MIGRATIONS.length },
      status: () => ({ version: "0", schema: 4, localUrl: "", publicUrl: null, setupInviteUrl: null, tunnel: null, addressChangedFrom: null, dataDir: b.dir, startedAt: "" }),
    });
    try {
      const base = `http://localhost:${server.port}`;
      const bob = new Client(base, "bob");
      expect((await bob.call("POST", "/api/auth/login", { username: "bob", password: "password123" })).status).toBe(200);
      const history = (await bob.call("GET", `/api/chats/${chatId}/messages`)).data;
      expect(history.map((m: { body: string }) => m.body)).toEqual(["Sunset", "Красиво!"]);
      const file = await fetch(`${base}/media/${photo.id}`, { headers: { Cookie: bob.cookie } });
      expect(await file.text()).toBe("jpeg bytes of a sunset");

      // The status page's button.
      expect((await fetch(`${base}/admin/backup`, { method: "POST" })).status).toBe(403);
      const made = await fetch(`${base}/admin/backup`, { method: "POST", headers: { "X-Admin-Key": "k".repeat(64) } });
      expect(made.status).toBe(201);
      expect(listBackups(join(root, "more-backups"))).toHaveLength(1);
    } finally {
      await server.stop();
      restored.close();
    }
  });
});
