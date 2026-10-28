import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { MIGRATIONS, migrate } from "../src/db";
import * as accounts from "../src/store/accounts";
import * as chats from "../src/store/chats";

let db: Database;
let now = 1_000_000;
const tick = () => ++now;
const offline = () => false;

function user(name: string, isAdmin = false): number {
  return accounts.createUser(db, { username: name, displayName: name.toUpperCase(), passwordHash: "x", isAdmin, now: tick() }).id;
}

function send(chatId: number, sender: number, body: string, clientId: string = crypto.randomUUID()) {
  const res = chats.sendMessage(db, { chatId, sender, clientId, body, now: tick() });
  if (typeof res === "string") throw new Error(res);
  return res;
}

beforeEach(() => {
  db = new Database(":memory:", { strict: true });
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
});

describe("migrations", () => {
  it("upgrades a schema-1 database that already has data", () => {
    const old = new Database(":memory:", { strict: true });
    migrate(old, MIGRATIONS.slice(0, 1));
    const instance = old.query("SELECT value FROM meta WHERE key = 'instance_id'").get();
    expect(migrate(old)).toBe(MIGRATIONS.length);
    expect(old.query("SELECT value FROM meta WHERE key = 'instance_id'").get()).toEqual(instance);
    expect(old.query("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
  });
});

describe("accounts", () => {
  it("usernames are unique regardless of case", () => {
    user("alice");
    expect(() => user("ALICE")).toThrow();
    expect(accounts.findUserByName(db, "Alice")?.username).toBe("alice");
  });

  it("finds a session by its token and keeps only the token's hash", () => {
    const alice = user("alice");
    const { token, deviceId } = accounts.createDevice(db, alice, "Laptop", tick());
    expect(accounts.sessionByToken(db, token)).toMatchObject({ deviceId, user: { id: alice } });
    expect(accounts.sessionByToken(db, token + "x")).toBeNull();
    expect(JSON.stringify(db.query("SELECT * FROM devices").all())).not.toContain(token);
  });

  it("signing one device out leaves the others signed in", () => {
    const alice = user("alice");
    const bob = user("bob");
    const phone = accounts.createDevice(db, alice, "Phone", tick());
    const laptop = accounts.createDevice(db, alice, "Laptop", tick());
    expect(accounts.deleteDevice(db, bob, phone.deviceId)).toBe(false);
    expect(accounts.deleteDevice(db, alice, phone.deviceId)).toBe(true);
    expect(accounts.sessionByToken(db, phone.token)).toBeNull();
    expect(accounts.sessionByToken(db, laptop.token)).not.toBeNull();
  });

  it("an invite works up to max_uses and not after it expires", () => {
    const multi = accounts.createInvite(db, { createdBy: null, grantsAdmin: false, maxUses: 2, expiresAt: null, now: tick() });
    expect(accounts.consumeInvite(db, multi.code, tick())).not.toBeNull();
    expect(accounts.consumeInvite(db, multi.code, tick())).not.toBeNull();
    expect(accounts.consumeInvite(db, multi.code, tick())).toBeNull();

    const expiring = accounts.createInvite(db, { createdBy: null, grantsAdmin: false, maxUses: 5, expiresAt: now + 10, now: tick() });
    expect(accounts.listInvites(db, now).map((i) => i.code)).toEqual([expiring.code]);
    expect(accounts.consumeInvite(db, expiring.code, now + 10)).toBeNull();
    expect(accounts.consumeInvite(db, "nope", tick())).toBeNull();
  });

  it("keeps one setup invite while there are no users, and none after", () => {
    const first = accounts.ensureSetupInvite(db, tick());
    expect(first?.grants_admin).toBe(1);
    expect(accounts.ensureSetupInvite(db, tick())?.code).toBe(first!.code);
    user("alice", true);
    expect(accounts.ensureSetupInvite(db, tick())).toBeNull();
  });

  it("searches by username or display name, without the searcher, treating % and _ literally", () => {
    const alice = user("alice");
    user("bob");
    user("bo_b");
    expect(accounts.searchUsers(db, "bo", alice).map((u) => u.username).sort()).toEqual(["bo_b", "bob"]);
    expect(accounts.searchUsers(db, "o_", alice).map((u) => u.username)).toEqual(["bo_b"]);
    expect(accounts.searchUsers(db, "%", alice)).toEqual([]);
    expect(accounts.searchUsers(db, "ALI", alice)).toEqual([]);
  });
});

describe("chats", () => {
  it("two people share one direct chat whoever starts it", () => {
    const [a, b] = [user("alice"), user("bob")];
    const first = chats.findOrCreateDirect(db, a, b, tick());
    expect(first.created).toBe(true);
    expect(chats.findOrCreateDirect(db, b, a, tick())).toEqual({ chatId: first.chatId, created: false });
    expect(chats.memberIds(db, first.chatId).sort()).toEqual([a, b].sort());
  });

  it("numbers messages 1, 2, 3 … per chat, with no gaps", () => {
    const [a, b, c] = [user("alice"), user("bob"), user("carol")];
    const ab = chats.findOrCreateDirect(db, a, b, tick()).chatId;
    const ac = chats.findOrCreateDirect(db, a, c, tick()).chatId;
    expect([send(ab, a, "1"), send(ab, b, "2"), send(ac, a, "x"), send(ab, a, "3")].map((r) => [r.msg.chat, r.msg.seq])).toEqual([
      [ab, 1],
      [ab, 2],
      [ac, 1],
      [ab, 3],
    ]);
  });

  it("a resend with the same client_id returns the first message instead of a second one", () => {
    const [a, b] = [user("alice"), user("bob")];
    const chat = chats.findOrCreateDirect(db, a, b, tick()).chatId;
    const id = crypto.randomUUID();
    const first = send(chat, a, "hi", id);
    const again = send(chat, a, "hi", id);
    expect(first.duplicate).toBe(false);
    expect(again).toEqual({ msg: first.msg, duplicate: true });
    expect(chats.history(db, chat, null, 50)).toHaveLength(1);
    // Someone else reusing that id is refused rather than shown the other message.
    expect(chats.sendMessage(db, { chatId: chat, sender: b, clientId: id, body: "x", now: tick() })).toBe("bad_request");
  });

  it("only members can write", () => {
    const [a, b, c] = [user("alice"), user("bob"), user("carol")];
    const chat = chats.findOrCreateDirect(db, a, b, tick()).chatId;
    expect(chats.sendMessage(db, { chatId: chat, sender: c, clientId: crypto.randomUUID(), body: "x", now: tick() })).toBe("forbidden");
    expect(chats.getChat(db, chat, c, offline)).toBeNull();
  });

  it("a reply must point at an existing message, and a refused one leaves no trace", () => {
    const [a, b] = [user("alice"), user("bob")];
    const chat = chats.findOrCreateDirect(db, a, b, tick()).chatId;
    send(chat, a, "first");
    expect(chats.sendMessage(db, { chatId: chat, sender: b, clientId: crypto.randomUUID(), body: "x", replyTo: 5, now: tick() })).toBe(
      "bad_request",
    );
    const ok = chats.sendMessage(db, { chatId: chat, sender: b, clientId: crypto.randomUUID(), body: "re", replyTo: 1, now: tick() });
    expect(ok).toMatchObject({ msg: { seq: 2, reply_to: 1 } });
  });

  it("edits and deletes reach a reconnecting client through the version, not the seq", () => {
    const [a, b] = [user("alice"), user("bob")];
    const chat = chats.findOrCreateDirect(db, a, b, tick()).chatId;
    send(chat, a, "one");
    send(chat, a, "two");
    const seen = chats.getChat(db, chat, b, offline)!.version;

    expect(chats.editMessage(db, chat, 1, b, "hack", tick())).toBe("forbidden");
    expect(chats.editMessage(db, chat, 1, a, "one!", tick())).toMatchObject({ body: "one!", edited_at: expect.any(Number) });
    expect(chats.deleteMessage(db, chat, 2, a, tick())).toMatchObject({ body: "", deleted: true });
    send(chat, b, "three");

    const { messages, more } = chats.changedSince(db, chat, seen, 50);
    expect(more).toBe(false);
    expect(messages.map((m) => [m.seq, m.body])).toEqual([
      [1, "one!"],
      [2, ""],
      [3, "three"],
    ]);
    expect(chats.editMessage(db, chat, 2, a, "back", tick())).toBe("not_found");
    expect(chats.changedSince(db, chat, 0, 2).more).toBe(true);
  });

  it("one reaction per person, replaced or removed", () => {
    const [a, b] = [user("alice"), user("bob")];
    const chat = chats.findOrCreateDirect(db, a, b, tick()).chatId;
    send(chat, a, "hi");
    chats.setReaction(db, chat, 1, a, "👍");
    chats.setReaction(db, chat, 1, b, "👍");
    expect(chats.setReaction(db, chat, 1, b, "❤️")).toMatchObject({ reactions: { "👍": [a], "❤️": [b] } });
    expect(chats.setReaction(db, chat, 1, a, "")).toMatchObject({ reactions: { "❤️": [b] } });
    expect(chats.deleteMessage(db, chat, 1, a, tick())).toMatchObject({ reactions: {} });
  });

  it("receipts only move forward, stop at the last message, and read implies delivered", () => {
    const [a, b] = [user("alice"), user("bob")];
    const chat = chats.findOrCreateDirect(db, a, b, tick()).chatId;
    send(chat, a, "1");
    send(chat, a, "2");
    expect(chats.markReceipt(db, chat, b, { delivered: 1 })).toEqual({ delivered: 1, read: 0 });
    expect(chats.markReceipt(db, chat, b, { read: 9 })).toEqual({ delivered: 2, read: 2 });
    expect(chats.markReceipt(db, chat, b, { delivered: 1, read: 1 })).toBeNull();
    // The sender's own marks moved with their message.
    expect(chats.getChat(db, chat, a, offline)!.members.find((m) => m.id === a)).toMatchObject({ delivered_seq: 2, read_seq: 2 });
  });

  it("unread counts other people's messages after the read mark", () => {
    const [a, b] = [user("alice"), user("bob")];
    const chat = chats.findOrCreateDirect(db, a, b, tick()).chatId;
    send(chat, a, "1");
    send(chat, a, "2");
    expect(chats.getChat(db, chat, b, offline)!.unread).toBe(2);
    chats.markReceipt(db, chat, b, { read: 1 });
    expect(chats.getChat(db, chat, b, offline)!.unread).toBe(1);
    // Answering marks everything before it read.
    send(chat, b, "3");
    expect(chats.getChat(db, chat, b, offline)!.unread).toBe(0);
    expect(chats.getChat(db, chat, a, offline)!.unread).toBe(1);
  });

  describe("groups", () => {
    it("only admins add, remove and rename; anyone can leave", () => {
      const [a, b, c, d] = [user("alice"), user("bob"), user("carol"), user("dave")];
      const g = chats.createGroup(db, a, "Team", [b, c], tick()) as number;
      expect(chats.memberRole(db, g, a)).toBe("admin");
      expect(chats.addMember(db, g, b, d, tick())).toBe("forbidden");
      expect(chats.removeMember(db, g, b, c)).toBe("forbidden");
      expect(chats.renameGroup(db, g, b, "Mine")).toBe("forbidden");
      expect(chats.addMember(db, g, a, d, tick())).toBe(true);
      expect(chats.removeMember(db, g, a, c)).toBe(true);
      expect(chats.removeMember(db, g, d, d)).toBe(true);
      expect(chats.memberIds(db, g).sort()).toEqual([a, b].sort());
    });

    it("the longest-standing member becomes admin when the last admin leaves; an empty group is gone", () => {
      const [a, b, c] = [user("alice"), user("bob"), user("carol")];
      const g = chats.createGroup(db, a, "Team", [b, c], tick()) as number;
      chats.removeMember(db, g, a, a);
      expect(chats.memberRole(db, g, b)).toBe("admin");
      expect(chats.setRole(db, g, b, b, "member")).toBe("bad_request");
      chats.removeMember(db, g, b, b);
      chats.removeMember(db, g, c, c);
      expect(db.query("SELECT count(*) AS n FROM chats").get()).toEqual({ n: 0 });
    });

    it("admins can delete anyone's message in a group, members only their own", () => {
      const [a, b, c] = [user("alice"), user("bob"), user("carol")];
      const g = chats.createGroup(db, a, "Team", [b, c], tick()) as number;
      send(g, b, "spam");
      send(g, c, "mine");
      expect(chats.deleteMessage(db, g, 1, c, tick())).toBe("forbidden");
      expect(chats.deleteMessage(db, g, 1, a, tick())).toMatchObject({ deleted: true });
      expect(chats.deleteMessage(db, g, 2, c, tick())).toMatchObject({ deleted: true });
    });

    it("refuses more than the member limit", () => {
      const a = user("alice");
      const many = Array.from({ length: 256 }, (_, i) => user(`u${i}`));
      expect(chats.createGroup(db, a, "Big", many, tick())).toBe("chat_full");
      const g = chats.createGroup(db, a, "Big", many.slice(0, 255), tick()) as number;
      expect(chats.memberIds(db, g)).toHaveLength(256);
      expect(chats.addMember(db, g, a, many[255]!, tick())).toBe("chat_full");
    });

    it("contacts are everyone who shares a chat", () => {
      const [a, b, c, d] = [user("alice"), user("bob"), user("carol"), user("dave")];
      chats.createGroup(db, a, "Team", [b], tick());
      chats.findOrCreateDirect(db, a, c, tick());
      expect(chats.contactIds(db, a).sort()).toEqual([b, c].sort());
      expect(chats.contactIds(db, d)).toEqual([]);
    });
  });

  it("lists a user's chats with the most recent activity first", () => {
    const [a, b, c] = [user("alice"), user("bob"), user("carol")];
    const ab = chats.findOrCreateDirect(db, a, b, tick()).chatId;
    const ac = chats.findOrCreateDirect(db, a, c, tick()).chatId;
    send(ab, b, "hi");
    expect(chats.chatsOfUser(db, a, (id) => id === b).map((c) => c.id)).toEqual([ab, ac]);
    const first = chats.chatsOfUser(db, a, (id) => id === b)[0]!;
    expect(first.last_message?.body).toBe("hi");
    expect(first.members.find((m) => m.id === b)?.online).toBe(true);
  });

  it("history pages go backwards from before_seq, oldest first within a page", () => {
    const [a, b] = [user("alice"), user("bob")];
    const chat = chats.findOrCreateDirect(db, a, b, tick()).chatId;
    for (let i = 1; i <= 5; i++) send(chat, a, String(i));
    expect(chats.history(db, chat, null, 2).map((m) => m.seq)).toEqual([4, 5]);
    expect(chats.history(db, chat, 4, 2).map((m) => m.seq)).toEqual([2, 3]);
    expect(chats.history(db, chat, 2, 5).map((m) => m.seq)).toEqual([1]);
  });
});
