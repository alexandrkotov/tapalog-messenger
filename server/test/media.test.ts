import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate } from "../src/db";
import * as accounts from "../src/store/accounts";
import * as chats from "../src/store/chats";
import { blobPath, canRead, collectGarbage, createMedia, saveBlob, UNUSED_KEEP_MS } from "../src/store/media";

let db: Database;
let dir: string;
let now = 1_000_000_000;
const tick = () => ++now;

function user(name: string): number {
  return accounts.createUser(db, { username: name, displayName: name, passwordHash: "x", isAdmin: false, now: tick() }).id;
}

const streamOf = (...chunks: (string | Uint8Array)[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      c.close();
    },
  });

async function upload(owner: number, content: string, mime = "image/jpeg") {
  const saved = await saveBlob(dir, streamOf(content), 1000);
  if (typeof saved === "string") throw new Error(saved);
  return createMedia(db, { ownerId: owner, ...saved, mime, name: "photo.jpg", now: tick() });
}

function send(chatId: number, sender: number, kind: "text" | "image" | "file" | "voice", mediaId?: string) {
  return chats.sendMessage(db, { chatId, sender, clientId: crypto.randomUUID(), kind, body: "", mediaId, now: tick() });
}

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

beforeEach(() => {
  db = new Database(":memory:", { strict: true });
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  dir = mkdtempSync(join(tmpdir(), "tm-media-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("storing files", () => {
  it("keeps the bytes under their SHA-256, whatever the chunking", async () => {
    const saved = await saveBlob(dir, streamOf("hello ", "world"), 1000);
    expect(saved).toEqual({ sha256: sha256("hello world"), size: 11 });
    expect(await Bun.file(blobPath(dir, sha256("hello world"))).text()).toBe("hello world");
  });

  it("stores the same content once", async () => {
    await saveBlob(dir, streamOf("same"), 1000);
    await saveBlob(dir, streamOf("sa", "me"), 1000);
    expect(readdirSync(join(dir, sha256("same").slice(0, 2)))).toEqual([sha256("same")]);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });

  it("stops at the size limit and leaves nothing behind", async () => {
    expect(await saveBlob(dir, streamOf("x".repeat(600), "y".repeat(600)), 1000)).toBe("too_large");
    expect(await saveBlob(dir, streamOf("x".repeat(1000)), 1000)).toMatchObject({ size: 1000 });
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
    expect(await saveBlob(dir, streamOf(), 1000)).toBe("empty");
    expect(await saveBlob(dir, null, 1000)).toBe("empty");
  });
});

describe("files in messages", () => {
  it("a photo must be a picture the sender uploaded", async () => {
    const [alice, bob] = [user("alice"), user("bob")];
    const { chatId } = chats.findOrCreateDirect(db, alice, bob, tick());
    const photo = await upload(alice, "jpeg bytes");
    const page = await upload(alice, "<html>", "text/html");

    expect(send(chatId, bob, "image", photo.id)).toBe("bad_request"); // Alice's upload
    expect(send(chatId, alice, "image", page.id)).toBe("bad_request"); // not a picture
    expect(send(chatId, alice, "voice", photo.id)).toBe("bad_request"); // not a sound
    expect(send(chatId, alice, "image", "AAAAAAAAAAAAAAAAAAAAAA")).toBe("bad_request"); // no such upload
    expect(send(chatId, alice, "text", photo.id)).toBe("bad_request");

    const sent = send(chatId, alice, "image", photo.id);
    if (typeof sent === "string") throw new Error(sent);
    expect(sent.msg).toMatchObject({ kind: "image", body: "", media: { id: photo.id, mime: "image/jpeg", size: 10, name: "photo.jpg", thumb: false } });
    expect(send(chatId, alice, "file", page.id)).toMatchObject({ msg: { kind: "file", media: { mime: "text/html" } } });
    expect(chats.history(db, chatId, null, 10).map((m) => m.media?.id)).toEqual([photo.id, page.id]);
  });

  it("only the uploader and the chat's members may download", async () => {
    const [alice, bob, eve] = [user("alice"), user("bob"), user("eve")];
    const { chatId } = chats.findOrCreateDirect(db, alice, bob, tick());
    const photo = await upload(alice, "jpeg");
    expect([canRead(db, photo.id, alice), canRead(db, photo.id, bob)]).toEqual([true, false]); // not sent yet

    send(chatId, alice, "image", photo.id);
    expect([canRead(db, photo.id, alice), canRead(db, photo.id, bob), canRead(db, photo.id, eve)]).toEqual([true, true, false]);

    chats.deleteMessage(db, chatId, 1, alice, tick());
    expect(canRead(db, photo.id, bob)).toBe(false);
    expect(chats.history(db, chatId, null, 10)[0]).toMatchObject({ deleted: true, media: null });
  });
});

describe("collecting garbage", () => {
  const old = (path: string) => utimesSync(path, new Date(0), new Date(0));

  it("drops a day-old upload no message uses, and its file", async () => {
    const [alice, bob] = [user("alice"), user("bob")];
    const { chatId } = chats.findOrCreateDirect(db, alice, bob, tick());
    const unused = await upload(alice, "unused");
    const used = await upload(alice, "used");
    send(chatId, alice, "image", used.id);
    for (const sha of [unused.sha256, used.sha256]) old(blobPath(dir, sha));

    expect(collectGarbage(db, dir, now)).toEqual({ rows: 0, files: 0 }); // too new to drop
    now += UNUSED_KEEP_MS + 1;
    expect(collectGarbage(db, dir, now)).toEqual({ rows: 1, files: 1 });
    expect(existsSync(blobPath(dir, unused.sha256))).toBe(false);
    expect(existsSync(blobPath(dir, used.sha256))).toBe(true);
  });

  it("keeps profile and group photos in use, and drops one replaced", async () => {
    const alice = user("alice");
    const group = chats.createGroup(db, alice, "Family", [], tick()) as number;
    const first = await upload(alice, "first face");
    const second = await upload(alice, "second face");
    const family = await upload(alice, "family");
    accounts.setAvatar(db, alice, first.id);
    chats.setGroupAvatar(db, group, alice, family.id);
    accounts.setAvatar(db, alice, second.id);
    for (const m of [first, second, family]) old(blobPath(dir, m.sha256));

    now += UNUSED_KEEP_MS + 1;
    expect(collectGarbage(db, dir, now)).toEqual({ rows: 1, files: 1 });
    expect(existsSync(blobPath(dir, first.sha256))).toBe(false);
    expect(existsSync(blobPath(dir, second.sha256))).toBe(true);
    expect(existsSync(blobPath(dir, family.sha256))).toBe(true);
  });

  it("frees a deleted message's file unless another upload has the same bytes", async () => {
    const [alice, bob] = [user("alice"), user("bob")];
    const { chatId } = chats.findOrCreateDirect(db, alice, bob, tick());
    const first = await upload(alice, "twin");
    const second = await upload(bob, "twin");
    send(chatId, alice, "image", first.id);
    send(chatId, bob, "image", second.id);
    old(blobPath(dir, first.sha256));
    chats.deleteMessage(db, chatId, 1, alice, tick());
    now += UNUSED_KEEP_MS + 1;

    expect(collectGarbage(db, dir, now)).toEqual({ rows: 1, files: 0 });
    chats.deleteMessage(db, chatId, 2, bob, tick());
    expect(collectGarbage(db, dir, now)).toEqual({ rows: 1, files: 1 });
  });

  it("leaves fresh files alone and clears stale half-uploads", async () => {
    writeFileSync(join(dir, "ab-orphan"), "not a bucket"); // not ours: untouched
    const fresh = await saveBlob(dir, streamOf("in flight"), 1000);
    if (typeof fresh === "string") throw new Error(fresh);
    const stale = join(dir, "tmp", "123-dead");
    writeFileSync(stale, "half");
    old(stale);

    expect(collectGarbage(db, dir, Date.now())).toEqual({ rows: 0, files: 1 });
    expect(existsSync(blobPath(dir, fresh.sha256))).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(dir, "ab-orphan"))).toBe(true);
  });
});

describe("migration to schema 3", () => {
  it("keeps messages, edits, deletions and reactions", () => {
    const old = new Database(":memory:", { strict: true });
    old.run("PRAGMA foreign_keys = ON");
    migrate(old, MIGRATIONS.slice(0, 2));
    const ins = (sql: string) => old.run(sql);
    ins("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (1, 'a', 'A', 'x', 1), (2, 'b', 'B', 'x', 1)");
    ins("INSERT INTO chats (id, kind, direct_key, created_at, last_seq, version) VALUES (1, 'direct', '1:2', 1, 3, 5)");
    ins("INSERT INTO chat_members (chat_id, user_id, joined_at, read_seq) VALUES (1, 1, 1, 3), (1, 2, 1, 2)");
    ins(`INSERT INTO messages (chat_id, seq, client_id, sender_id, kind, body, reply_to_seq, created_at, edited_at, deleted_at, version) VALUES
         (1, 1, 'c1', 1, 'text', 'hello', NULL, 10, NULL, NULL, 1),
         (1, 2, 'c2', 2, 'text', 'edited', 1, 11, 20, NULL, 4),
         (1, 3, 'c3', 1, 'text', '', NULL, 12, NULL, 30, 5)`);
    ins("INSERT INTO reactions (chat_id, seq, user_id, emoji) VALUES (1, 1, 2, '👍')");

    expect(migrate(old)).toBe(MIGRATIONS.length);
    const all = chats.history(old, 1, null, 10);
    expect(all.map((m) => [m.seq, m.kind, m.body, m.reply_to, m.edited_at, m.deleted, m.version, m.media])).toEqual([
      [1, "text", "hello", null, null, false, 1, null],
      [2, "text", "edited", 1, 20, false, 4, null],
      [3, "text", "", null, null, true, 5, null],
    ]);
    expect(all[0]!.reactions).toEqual({ "👍": [2] });
    expect((old.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    // The rebuilt table still enforces its keys and uniqueness.
    expect(() => old.run("INSERT INTO messages (chat_id, seq, client_id, kind, body, created_at, version) VALUES (9, 1, 'x', 'text', 'x', 1, 1)")).toThrow();
    expect(() => old.run("INSERT INTO messages (chat_id, seq, client_id, kind, body, created_at, version) VALUES (1, 4, 'c1', 'text', 'x', 1, 6)")).toThrow();
  });
});
