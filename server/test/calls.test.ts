import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { MessageDto, ServerFrame } from "@tapalog-messenger/shared";
import { Calls } from "../src/calls";
import { migrate } from "../src/db";
import * as accounts from "../src/store/accounts";
import * as chats from "../src/store/chats";

/** A stand-in for a tab's WebSocket: keeps what the server sends it. */
class Tab {
  frames: ServerFrame[] = [];
  constructor(public data: { userId: number; deviceId: number; ip: string }) {}
  send(raw: string) {
    this.frames.push(JSON.parse(raw));
  }
  /** Takes the frames received so far. */
  take(): ServerFrame[] {
    return this.frames.splice(0);
  }
}

let db: Database;
let now: number;
let tabs: Tab[];
let messages: MessageDto[];
let rings: { id: string; to: number }[];
let calls: Calls;

const RING = 80;
const RESUME = 80;

function user(name: string): number {
  return accounts.createUser(db, { username: name, displayName: name, passwordHash: "x", isAdmin: false, now }).id;
}

let devices = 0;
function tab(userId: number, deviceId = ++devices): Tab {
  const t = new Tab({ userId, deviceId, ip: "127.0.0.1" });
  tabs.push(t);
  return t;
}

const send = (t: Tab) => (frame: ServerFrame) => t.send(JSON.stringify(frame));
const act = (t: Tab, frame: Parameters<Calls["handle"]>[1]) => calls.handle(t as never, frame, send(t));

beforeEach(() => {
  db = new Database(":memory:", { strict: true });
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  now = 1_000_000;
  tabs = [];
  messages = [];
  rings = [];
  calls = new Calls(
    db,
    {
      publish: (ids, frame) => tabs.filter((t) => ids.includes(t.data.userId)).forEach((t) => t.send(JSON.stringify(frame))),
      publishExcept: (id, except, frame) => tabs.filter((t) => t.data.userId === id && t !== (except as never)).forEach((t) => t.send(JSON.stringify(frame))),
      newMessage: (msg) => messages.push(msg),
      ring: (c) => rings.push({ id: c.id, to: c.to }),
    },
    { now: () => now, ringMs: RING, resumeMs: RESUME },
  );
});

afterEach(() => calls.clear());

function setup() {
  const [alice, bob] = [user("alice"), user("bob")];
  const chat = chats.findOrCreateDirect(db, alice, bob, now).chatId;
  return { alice, bob, chat, a: tab(alice), b: tab(bob) };
}

describe("calls", () => {
  it("rings every tab of the person called; one answers, the other stops; offers go only between the two that talk", () => {
    const { alice, bob, chat, a, b } = setup();
    const b2 = tab(bob);
    const call = crypto.randomUUID();
    act(a, { t: "call.invite", call, chat, video: true });
    expect(b.take()).toEqual([{ t: "call.ring", call, chat, from: alice, video: true }]);
    expect(b2.take()).toEqual([{ t: "call.ring", call, chat, from: alice, video: true }]);
    expect(rings).toEqual([{ id: call, to: bob }]);
    expect(calls.busy(alice) && calls.busy(bob)).toBe(true);

    act(b, { t: "call.accept", call });
    expect(a.take()).toEqual([{ t: "call.accepted", call }]);
    expect(b2.take()).toEqual([{ t: "call.taken", call }]);

    const offer = { gen: 0, description: { type: "offer" as const, sdp: "v=0" } };
    act(a, { t: "call.signal", call, data: offer });
    expect(b.take()).toEqual([{ t: "call.signal", call, data: offer }]);
    act(b2, { t: "call.signal", call, data: { gen: 0, candidate: null } });
    expect(a.take()).toEqual([]);

    now += 95_400;
    act(a, { t: "call.end", call });
    for (const t of [a, b, b2]) expect(t.take()).toEqual([{ t: "call.ended", call, reason: "ended" }]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ chat, from: alice, kind: "call", body: "", client_id: call, call: { outcome: "answered", video: true, duration: 95 } });
    expect(calls.busy(alice) || calls.busy(bob)).toBe(false);
  });

  it("a call nobody answers is missed after the ring time", async () => {
    const { chat, a, b } = setup();
    const call = crypto.randomUUID();
    act(a, { t: "call.invite", call, chat, video: false });
    await Bun.sleep(RING + 40);
    expect(a.take()).toEqual([{ t: "call.ended", call, reason: "missed" }]);
    expect(b.take().at(-1)).toEqual({ t: "call.ended", call, reason: "missed" });
    expect(messages[0]!.call).toEqual({ outcome: "missed", video: false, duration: 0 });
  });

  it("saying no, or the caller giving up, ends it for both and is written down", () => {
    const { chat, a, b } = setup();
    const first = crypto.randomUUID();
    act(a, { t: "call.invite", call: first, chat, video: false });
    act(b, { t: "call.reject", call: first });
    expect(a.take()).toEqual([{ t: "call.ended", call: first, reason: "rejected" }]);

    const second = crypto.randomUUID();
    act(a, { t: "call.invite", call: second, chat, video: false });
    act(a, { t: "call.end", call: second });
    expect(b.take().at(-1)).toEqual({ t: "call.ended", call: second, reason: "cancelled" });
    expect(messages.map((m) => m.call!.outcome)).toEqual(["rejected", "missed"]);
  });

  it("someone already in a call is busy", () => {
    const { bob, chat, a } = setup();
    const carol = user("carol");
    const c = tab(carol);
    const other = chats.findOrCreateDirect(db, carol, bob, now).chatId;
    act(c, { t: "call.invite", call: crypto.randomUUID(), chat: other, video: false });

    const call = crypto.randomUUID();
    act(a, { t: "call.invite", call, chat, video: false });
    expect(a.take()).toEqual([{ t: "call.ended", call, reason: "busy" }]);
    expect(messages.at(-1)).toMatchObject({ chat, call: { outcome: "busy" } });

    // And the one ringing cannot start another call meanwhile.
    const again = crypto.randomUUID();
    act(c, { t: "call.invite", call: again, chat: chats.findOrCreateDirect(db, carol, user("dave"), now).chatId, video: false });
    expect(c.take()).toEqual([{ t: "call.ended", call: again, reason: "busy" }]);
  });

  it("only the two people of a direct chat can call; a stranger cannot touch the call", () => {
    const { alice, bob, chat, a } = setup();
    const carol = user("carol");
    const group = chats.createGroup(db, alice, "family", [bob, carol], now) as number;
    const self = chats.findOrCreateDirect(db, alice, alice, now).chatId;
    for (const target of [group, self, 9999]) {
      const call = crypto.randomUUID();
      act(a, { t: "call.invite", call, chat: target, video: false });
      expect(a.take()).toEqual([{ t: "error", code: "forbidden", ref: call }]);
    }
    const c = tab(carol);
    act(c, { t: "call.invite", call: crypto.randomUUID(), chat, video: false });
    expect(c.take()[0]).toMatchObject({ t: "error", code: "forbidden" });

    const call = crypto.randomUUID();
    act(a, { t: "call.invite", call, chat, video: false });
    act(c, { t: "call.accept", call });
    expect(c.take()).toEqual([{ t: "call.ended", call, reason: "ended" }]);
    expect(a.take()).toEqual([]);
  });

  it("a tab that drops mid-call can come back; one that does not ends the call", async () => {
    const { chat, a, b } = setup();
    const call = crypto.randomUUID();
    act(a, { t: "call.invite", call, chat, video: false });
    act(b, { t: "call.accept", call });
    a.take();

    calls.socketClosed(b as never);
    const back = tab(b.data.userId, b.data.deviceId);
    act(back, { t: "call.resume", call });
    await Bun.sleep(RESUME + 40);
    act(a, { t: "call.signal", call, data: { gen: 0, candidate: null } });
    expect(back.take()).toEqual([{ t: "call.signal", call, data: { gen: 0, candidate: null } }]);
    expect(messages).toHaveLength(0);

    calls.socketClosed(a as never);
    await Bun.sleep(RESUME + 40);
    expect(back.take()).toEqual([{ t: "call.ended", call, reason: "failed" }]);
    expect(messages[0]!.call!.outcome).toBe("answered");
  });

  it("a caller whose tab was away when the call was answered hears of it on coming back", () => {
    const { chat, a, b } = setup();
    const call = crypto.randomUUID();
    act(a, { t: "call.invite", call, chat, video: false });
    calls.socketClosed(a as never);
    act(b, { t: "call.accept", call });
    const back = tab(a.data.userId, a.data.deviceId);
    act(back, { t: "call.resume", call });
    expect(back.take()).toEqual([{ t: "call.accepted", call }]);
  });

    it("another device of the same person cannot take over a call by resuming it", () => {
    const { bob, chat, a, b } = setup();
    const call = crypto.randomUUID();
    act(a, { t: "call.invite", call, chat, video: false });
    act(b, { t: "call.accept", call });
    const phone = tab(bob);
    phone.take();
    act(phone, { t: "call.resume", call });
    expect(phone.take()).toEqual([{ t: "call.ended", call, reason: "ended" }]);
    act(phone, { t: "call.end", call });
    expect(calls.busy(bob)).toBe(true);
  });

  it("limits how often one person can start calls", () => {
    const { chat, a, b } = setup();
    for (let i = 0; i < 10; i++) {
      const call = crypto.randomUUID();
      act(a, { t: "call.invite", call, chat, video: false });
      act(b, { t: "call.reject", call });
    }
    const call = crypto.randomUUID();
    a.take();
    act(a, { t: "call.invite", call, chat, video: false });
    expect(a.take()).toEqual([{ t: "error", code: "rate_limited", ref: call }]);
  });

  it("no record goes into a chat whose other person was deleted meanwhile", () => {
    const { alice, bob, chat, a } = setup();
    const call = crypto.randomUUID();
    act(a, { t: "call.invite", call, chat, video: false });
    accounts.deleteUser(db, bob);
    act(a, { t: "call.end", call });
    expect(messages).toHaveLength(0);
    const record = { chatId: chat, callId: call, caller: alice, callee: bob, record: { outcome: "missed" as const, video: false, duration: 0 }, now };
    expect(chats.recordCall(db, record)).toBeNull();
  });
});
