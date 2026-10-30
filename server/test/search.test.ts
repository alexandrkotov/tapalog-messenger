import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS, migrate } from "../src/db";
import { createUser } from "../src/store/accounts";
import * as chats from "../src/store/chats";
import { createMedia } from "../src/store/media";
import { searchMessages } from "../src/store/search";
import { Client, testServer } from "./helpers";

function setup() {
  const db = new Database(":memory:", { strict: true });
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  const user = (name: string) => createUser(db, { username: name, displayName: name, passwordHash: "x", isAdmin: false, now: 1 }).id;
  const a = user("a");
  const b = user("b");
  const c = user("c");
  const ab = chats.findOrCreateDirect(db, a, b, 1).chatId;
  const bc = chats.findOrCreateDirect(db, b, c, 1).chatId;
  let n = 0;
  const say = (chatId: number, sender: number, body: string, extra: { kind?: "file"; mediaId?: string } = {}) => {
    const res = chats.sendMessage(db, { chatId, sender, clientId: `c${++n}`, body, now: 1000 + n, ...extra });
    if (typeof res === "string") throw new Error(res);
    return res.msg.seq;
  };
  const find = (who: number, q: string, opts: { chat?: number } = {}) => {
    const hits = searchMessages(db, who, q, { limit: 50, ...opts });
    return hits === "too_short" ? hits : hits.map((h) => h.snippet);
  };
  return { db, a, b, c, ab, bc, say, find };
}

describe("search", () => {
  it("finds any part of a word, ignoring case and ё, newest first", () => {
    const { a, ab, say, find } = setup();
    say(ab, a, "Встретимся у фонтана в шесть");
    say(ab, a, "Котик спит. ЁЖИК тоже");
    say(ab, a, "kitten and КОТ");
    expect(find(a, "фонт")).toEqual(["Встретимся у фонтана в шесть"]);
    expect(find(a, "кот")).toEqual(["kitten and КОТ", "Котик спит. ЁЖИК тоже"]);
    expect(find(a, "ежик")).toEqual(["Котик спит. ЁЖИК тоже"]);
    expect(find(a, "ёжик")).toEqual(["Котик спит. ЁЖИК тоже"]);
    expect(find(a, "KITT")).toEqual(["kitten and КОТ"]);
  });

  it("needs every word, short ones included", () => {
    const { a, ab, say, find } = setup();
    say(ab, a, "мы у фонтана");
    say(ab, a, "вы у фонтана");
    expect(find(a, "фонтан мы")).toEqual(["мы у фонтана"]);
    expect(find(a, "фонтан")).toHaveLength(2);
  });

  it("looks up short words only inside one chat", () => {
    const { a, ab, say, find } = setup();
    say(ab, a, "ок");
    say(ab, a, "да");
    expect(find(a, "ок")).toBe("too_short");
    expect(find(a, "ок", { chat: ab })).toEqual(["ок"]);
    expect(find(a, "   ")).toBe("too_short");
  });

  it("finds only the person's own chats", () => {
    const { a, c, ab, bc, b, say, find } = setup();
    say(ab, a, "секретный пароль от вайфая");
    say(bc, b, "секретный рецепт");
    expect(find(a, "секрет")).toEqual(["секретный пароль от вайфая"]);
    expect(find(c, "секрет")).toEqual(["секретный рецепт"]);
    expect(find(c, "секрет", { chat: ab })).toEqual([]);
  });

  it("follows edits and deletions", () => {
    const { db, a, ab, say, find } = setup();
    const seq = say(ab, a, "старый текст");
    chats.editMessage(db, ab, seq, a, "новый текст", 5000);
    expect(find(a, "старый")).toEqual([]);
    expect(find(a, "новый")).toEqual(["новый текст"]);
    chats.deleteMessage(db, ab, seq, a, 6000);
    expect(find(a, "текст")).toEqual([]);
  });

  it("finds a file by its name, and a photo by its caption", () => {
    const { db, a, ab, say, find } = setup();
    const media = createMedia(db, { ownerId: a, sha256: "0".repeat(64), mime: "application/pdf", size: 1, name: "Отчёт за май.pdf", now: 1 });
    say(ab, a, "", { kind: "file", mediaId: media.id });
    expect(find(a, "отчет")).toEqual(["Отчёт за май.pdf"]);
    expect(find(a, ".pdf")).toEqual(["Отчёт за май.pdf"]);
  });

  it("cuts a long message around the word found", () => {
    const { a, ab, say, find } = setup();
    say(ab, a, `${"начало ".repeat(30)}НАЙДИ\nменя ${"конец ".repeat(30)}`);
    const [snippet] = find(a, "найди") as string[];
    expect(snippet).toStartWith("…");
    expect(snippet).toEndWith("…");
    expect(snippet).toContain("НАЙДИ меня");
    expect(snippet!.length).toBeLessThan(150);
  });

  it("goes page by page without repeats", () => {
    const { db, a, ab, say } = setup();
    for (let i = 0; i < 120; i++) say(ab, a, `заметка номер ${i}`);
    const seen: number[] = [];
    let before;
    for (;;) {
      const page = searchMessages(db, a, "заметка", { limit: 50, before }) as { at: number; chat: number; seq: number }[];
      seen.push(...page.map((h) => h.seq));
      if (page.length < 50) break;
      const last = page[page.length - 1]!;
      before = { at: last.at, chat: last.chat, seq: last.seq };
    }
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    expect(seen[0]).toBeGreaterThan(seen[119]!);
  });

  it("answers quickly over 100 000 messages", { timeout: 30_000 }, () => {
    const { db, a, ab, say, find } = setup();
    // Written straight into the table (the triggers still index it): sending 100 000 one by one would take a while.
    db.run(
      `INSERT INTO messages (chat_id, seq, client_id, sender_id, kind, body, created_at, version)
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
       SELECT ${ab}, i, 'x' || i, ${a}, 'text', 'сообщение ' || i || ' про погоду, дачу и котов', i, i FROM n`,
    );
    db.run(`UPDATE chats SET last_seq = 100000, version = 100000 WHERE id = ${ab}`);
    say(ab, a, "единственный фонтан");
    const started = performance.now();
    expect(find(a, "фонтан")).toEqual(["единственный фонтан"]);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("migration to schema 4", () => {
  it("indexes the history already written", () => {
    const old = new Database(":memory:", { strict: true });
    old.run("PRAGMA foreign_keys = ON");
    migrate(old, MIGRATIONS.slice(0, 3));
    old.run("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (1, 'a', 'A', 'x', 1), (2, 'b', 'B', 'x', 1)");
    old.run("INSERT INTO chats (id, kind, direct_key, created_at, last_seq, version) VALUES (1, 'direct', '1:2', 1, 2, 2)");
    old.run("INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (1, 1, 1), (1, 2, 1)");
    old.run(`INSERT INTO messages (chat_id, seq, client_id, sender_id, kind, body, created_at, deleted_at, version) VALUES
             (1, 1, 'c1', 1, 'text', 'Поедем на дачу?', 10, NULL, 1),
             (1, 2, 'c2', 2, 'text', 'удалённая дача', 11, 20, 2)`);
    expect(migrate(old, MIGRATIONS.slice(0, 4))).toBe(4);
    expect((searchMessages(old, 2, "дач", { limit: 10 }) as { seq: number }[]).map((h) => h.seq)).toEqual([1]);
  });
});

describe("migration to schema 5", () => {
  it("keeps the search index pointing at the same messages, and leaves call records out of it", () => {
    const old = new Database(":memory:", { strict: true });
    old.run("PRAGMA foreign_keys = ON");
    migrate(old, MIGRATIONS.slice(0, 4));
    old.run("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (1, 'a', 'A', 'x', 1), (2, 'b', 'B', 'x', 1)");
    old.run("INSERT INTO chats (id, kind, direct_key, created_at, last_seq, version) VALUES (1, 'direct', '1:2', 1, 3, 3)");
    old.run("INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (1, 1, 1), (1, 2, 1)");
    old.run(`INSERT INTO messages (chat_id, seq, client_id, sender_id, kind, body, created_at, version) VALUES
             (1, 1, 'c1', 1, 'text', 'первое', 10, 1), (1, 2, 'c2', 1, 'text', 'второе', 11, 2), (1, 3, 'c3', 2, 'text', 'третье про дачу', 12, 3)`);
    // A gap in the rowids, so a rebuild that numbered them afresh would point the index at the wrong rows.
    old.run("DELETE FROM messages WHERE seq = 2");
    expect(migrate(old)).toBe(5);
    const seqs = (q: string) => (searchMessages(old, 2, q, { limit: 10 }) as { seq: number }[]).map((h) => h.seq);
    expect(seqs("дач")).toEqual([3]);
    expect(seqs("перв")).toEqual([1]);

    const record = JSON.stringify({ outcome: "missed", video: false, duration: 0 });
    old.run(`INSERT INTO messages (chat_id, seq, client_id, sender_id, kind, body, created_at, version) VALUES (1, 4, 'c4', 1, 'call', ?, 13, 4)`, [record]);
    expect(seqs("missed")).toEqual([]);
    old.run("UPDATE messages SET body = 'про первую дачу' WHERE seq = 1");
    expect(seqs("дач")).toEqual([3, 1]);
  });
});

describe("search over HTTP", () => {
  const t = testServer();
  afterAll(() => t.server.stop());

  it("answers for the person's chats, and opens history around a hit", async () => {
    const alice = await new Client(t.base).register(t.invite(), "alice");
    const bob = await new Client(t.base).register(t.invite(), "bob");
    const chat = (await alice.call("POST", "/api/chats", { kind: "direct", user: bob.id })).data.id as number;
    const ws = await alice.connect();
    for (let i = 1; i <= 30; i++) {
      ws.send({ t: "msg.send", chat, client_id: crypto.randomUUID(), kind: "text", body: i === 10 ? "у фонтана в шесть" : `сообщение ${i}` });
      await ws.next("msg.new");
    }
    ws.close();

    const found = await bob.call("GET", `/api/search?q=${encodeURIComponent("Фонтан")}`);
    expect(found.data).toEqual([{ chat, seq: 10, from: alice.id, at: expect.any(Number), kind: "text", snippet: "у фонтана в шесть" }]);
    expect((await bob.call("GET", "/api/search?q=ok")).data).toEqual({ error: "too_short" });
    expect((await bob.call("GET", `/api/search?q=${encodeURIComponent("ще")}&chat=${chat}`)).data).toHaveLength(29);

    const stranger = await new Client(t.base).register(t.invite(), "carol");
    expect((await stranger.call("GET", `/api/search?q=${encodeURIComponent("фонтан")}`)).data).toEqual([]);
    expect((await stranger.call("GET", `/api/search?q=x&chat=${chat}`)).status).toBe(404);

    const around = await bob.call("GET", `/api/chats/${chat}/messages?around=10&limit=6`);
    expect(around.data.map((m: { seq: number }) => m.seq)).toEqual([7, 8, 9, 10, 11, 12]);
    const start = await bob.call("GET", `/api/chats/${chat}/messages?around=1&limit=6`);
    expect(start.data.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3]);
    const later = await bob.call("GET", `/api/chats/${chat}/messages?after_seq=12&limit=3`);
    expect(later.data.map((m: { seq: number }) => m.seq)).toEqual([13, 14, 15]);
  });
});
