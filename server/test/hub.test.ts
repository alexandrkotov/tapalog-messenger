import { afterAll, describe, expect, it } from "bun:test";
import { Client, Socket, testServer } from "./helpers";

const t = testServer();
afterAll(() => t.server.stop());
let n = 0;
const newUser = (name: string) => new Client(t.base).register(t.invite(), `${name}${++n}`);

async function directChat(a: Client, b: Client): Promise<number> {
  return (await a.call("POST", "/api/chats", { kind: "direct", user: b.id })).data.id;
}

const msg = (chat: number, body: string, client_id: string = crypto.randomUUID()) => ({ t: "msg.send", chat, client_id, kind: "text", body });

describe("connecting", () => {
  it("needs a session and our Origin", async () => {
    const alice = await newUser("alice");
    await expect(Socket.open(`${t.base.replace("http", "ws")}/ws`, { Origin: t.base })).rejects.toThrow();
    await expect(Socket.open(`${t.base.replace("http", "ws")}/ws`, { Origin: "https://evil.example", Cookie: alice.cookie })).rejects.toThrow();
    const ws = await alice.connect();
    ws.send({ t: "ping" });
    await ws.next("pong");
    ws.close();
  });

  it("answers junk with bad_request and keeps the connection", async () => {
    const ws = await (await newUser("alice")).connect();
    for (const junk of ["not json", { t: "nope" }, { t: "msg.send", chat: 1, client_id: "not-a-uuid", kind: "text", body: "x" }, { t: "msg.send", chat: 1, client_id: crypto.randomUUID(), kind: "text", body: "   " }]) {
      ws.send(junk);
      await ws.next("error", (f) => f.code === "bad_request");
    }
    ws.send({ t: "ping" });
    await ws.next("pong");
    ws.close();
  });

  it("closes a connection that sends a frame over the size limit", async () => {
    const ws = await (await newUser("alice")).connect();
    ws.send(msg(1, "x".repeat(70_000)));
    for (let i = 0; i < 20 && !ws.closed; i++) await Bun.sleep(50);
    expect(ws.closed).not.toBeNull();
  });
});

describe("messages", () => {
  it("Alice writes, Bob gets it at once, Alice gets her ack and the read receipt", async () => {
    const [alice, bob] = [await newUser("alice"), await newUser("bob")];
    const chat = await directChat(alice, bob);
    const [wa, wb] = [await alice.connect(), await bob.connect()];
    const id = crypto.randomUUID();
    wa.send(msg(chat, "Привет", id));

    const ack = await wa.next("msg.ack");
    expect(ack).toMatchObject({ client_id: id, chat, seq: 1 });
    const got = await wb.next("msg.new");
    expect(got.msg).toMatchObject({ chat, seq: 1, from: alice.id, body: "Привет", client_id: id });

    wb.send({ t: "receipt", chat, delivered: 1 });
    expect(await wa.next("receipt")).toEqual({ t: "receipt", chat, user: bob.id, delivered: 1, read: 0 });
    wb.send({ t: "receipt", chat, read: 1 });
    expect(await wa.next("receipt", (f) => f.read === 1)).toEqual({ t: "receipt", chat, user: bob.id, delivered: 1, read: 1 });
    wa.close();
    wb.close();
  });

  it("a resend after a lost ack is acked again with the same seq and not shown twice", async () => {
    const [alice, bob] = [await newUser("alice"), await newUser("bob")];
    const chat = await directChat(alice, bob);
    const [wa, wb] = [await alice.connect(), await bob.connect()];
    const id = crypto.randomUUID();
    wa.send(msg(chat, "once", id));
    await wa.next("msg.ack");
    await wb.next("msg.new");
    wa.send(msg(chat, "once", id));
    expect(await wa.next("msg.ack")).toMatchObject({ client_id: id, seq: 1 });
    expect(await wb.got("msg.new")).toBe(false);
    wa.close();
    wb.close();
  });

  it("a group gets every message in one order", async () => {
    const [a, b, c] = [await newUser("alice"), await newUser("bob"), await newUser("carol")];
    const g = (await a.call("POST", "/api/chats", { kind: "group", title: "Three", members: [b.id, c.id] })).data.id;
    const sockets = [await a.connect(), await b.connect(), await c.connect()];
    sockets[0]!.send(msg(g, "a1"));
    sockets[1]!.send(msg(g, "b1"));
    sockets[2]!.send(msg(g, "c1"));
    sockets[0]!.send(msg(g, "a2"));
    const orders = await Promise.all(
      sockets.map(async (ws) => {
        const got: [number, string][] = [];
        for (let i = 0; i < 4; i++) {
          const f = await ws.next("msg.new");
          got.push([f.msg.seq, f.msg.body]);
        }
        return got.sort((x, y) => x[0] - y[0]);
      }),
    );
    expect(orders[1]).toEqual(orders[0]!);
    expect(orders[2]).toEqual(orders[0]!);
    expect(orders[0]!.map(([seq]) => seq)).toEqual([1, 2, 3, 4]);
    for (const ws of sockets) ws.close();
  });

  it("an outsider can neither write to nor type in a chat", async () => {
    const [alice, bob, eve] = [await newUser("alice"), await newUser("bob"), await newUser("eve")];
    const chat = await directChat(alice, bob);
    const we = await eve.connect();
    const id = crypto.randomUUID();
    we.send(msg(chat, "hi", id));
    expect(await we.next("error")).toEqual({ t: "error", code: "forbidden", ref: id });
    we.send({ t: "typing", chat });
    expect(await we.next("error")).toMatchObject({ code: "forbidden" });
    we.close();
  });

  it("edits, deletes and reactions reach every member", async () => {
    const [alice, bob] = [await newUser("alice"), await newUser("bob")];
    const chat = await directChat(alice, bob);
    const [wa, wb] = [await alice.connect(), await bob.connect()];
    wa.send(msg(chat, "typo"));
    await wb.next("msg.new");
    wa.send({ t: "msg.edit", chat, seq: 1, body: "fixed" });
    expect((await wb.next("msg.update")).msg).toMatchObject({ body: "fixed", edited_at: expect.any(Number) });
    wb.send({ t: "react", chat, seq: 1, emoji: "👍" });
    expect((await wa.next("msg.update", (f) => Object.keys(f.msg.reactions).length > 0)).msg.reactions).toEqual({ "👍": [bob.id] });
    wb.send({ t: "msg.delete", chat, seq: 1 });
    expect(await wb.next("error")).toMatchObject({ code: "forbidden" });
    wa.send({ t: "msg.delete", chat, seq: 1 });
    expect((await wb.next("msg.update", (f) => f.msg.deleted)).msg).toMatchObject({ body: "", deleted: true, reactions: {} });
    wa.close();
    wb.close();
  });

  it("limits how fast one person can send", async () => {
    const [alice, bob] = [await newUser("alice"), await newUser("bob")];
    const chat = await directChat(alice, bob);
    const wa = await alice.connect();
    for (let i = 0; i < 31; i++) wa.send(msg(chat, `m${i}`));
    expect(await wa.next("error")).toMatchObject({ code: "rate_limited", ref: expect.any(String) });
    wa.close();
  });
});

describe("catching up after a reconnect", () => {
  it("hello with the last version seen returns what changed, then synced", async () => {
    const [alice, bob] = [await newUser("alice"), await newUser("bob")];
    const chat = await directChat(alice, bob);
    const wa = await alice.connect();
    wa.send(msg(chat, "one"));
    await wa.next("msg.ack");
    const version = (await bob.call("GET", `/api/chats/${chat}`)).data.version;

    // Bob is away: a new message and an edit of the old one.
    wa.send(msg(chat, "two"));
    await wa.next("msg.ack");
    wa.send({ t: "msg.edit", chat, seq: 1, body: "one, edited" });
    await wa.next("msg.update");

    const wb = await bob.connect();
    wb.send({ t: "hello", sync: { [chat]: version } });
    const got = [(await wb.next("msg.update")).msg, (await wb.next("msg.update")).msg];
    await wb.next("synced");
    expect(got.map((m) => [m.seq, m.body]).sort()).toEqual([
      [1, "one, edited"],
      [2, "two"],
    ]);
    wa.close();
    wb.close();
  });

  it("a chat the user was removed from is reported as removed", async () => {
    const [a, b] = [await newUser("alice"), await newUser("bob")];
    const g = (await a.call("POST", "/api/chats", { kind: "group", title: "G", members: [b.id] })).data.id;
    await a.call("DELETE", `/api/chats/${g}/members/${b.id}`);
    const wb = await b.connect();
    wb.send({ t: "hello", sync: { [g]: 0 } });
    expect(await wb.next("chat.removed")).toEqual({ t: "chat.removed", chat: g });
    await wb.next("synced");
    wb.close();
  });
});

describe("presence, typing and chat changes", () => {
  it("contacts see someone come online and go offline with a last-seen time", async () => {
    const [alice, bob] = [await newUser("alice"), await newUser("bob")];
    await directChat(alice, bob);
    const wa = await alice.connect();
    const wb = await bob.connect();
    expect(await wa.next("presence")).toEqual({ t: "presence", user: bob.id, online: true, last_seen: null });
    // A second tab is not news.
    const wb2 = await bob.connect();
    expect(await wa.got("presence")).toBe(false);
    wb.close();
    expect(await wa.got("presence")).toBe(false);
    wb2.close();
    expect(await wa.next("presence")).toMatchObject({ user: bob.id, online: false, last_seen: expect.any(Number) });
    expect((await alice.call("GET", "/api/chats")).data[0].members.find((m: { id: number }) => m.id === bob.id)).toMatchObject({
      online: false,
      last_seen_at: expect.any(Number),
    });
    wa.close();
  });

  it("typing goes to the other members only", async () => {
    const [alice, bob] = [await newUser("alice"), await newUser("bob")];
    const chat = await directChat(alice, bob);
    const [wa, wb] = [await alice.connect(), await bob.connect()];
    wa.send({ t: "typing", chat });
    expect(await wb.next("typing")).toEqual({ t: "typing", chat, user: alice.id });
    expect(await wa.got("typing")).toBe(false);
    wa.close();
    wb.close();
  });

  it("a new chat, a rename and a removal are pushed to the people concerned", async () => {
    const [a, b] = [await newUser("alice"), await newUser("bob")];
    const wb = await b.connect();
    const g = (await a.call("POST", "/api/chats", { kind: "group", title: "New", members: [b.id] })).data.id;
    expect((await wb.next("chat.update")).chat).toMatchObject({ id: g, title: "New" });
    await a.call("PATCH", `/api/chats/${g}`, { title: "Renamed" });
    expect((await wb.next("chat.update")).chat.title).toBe("Renamed");
    await a.call("DELETE", `/api/chats/${g}/members/${b.id}`);
    expect(await wb.next("chat.removed")).toEqual({ t: "chat.removed", chat: g });
    wb.close();
  });

  it("signing a device out closes its open tabs", async () => {
    const alice = await newUser("alice");
    const ws = await alice.connect();
    await alice.call("POST", "/api/auth/logout");
    for (let i = 0; i < 20 && !ws.closed; i++) await Bun.sleep(25);
    expect(ws.closed?.code).toBe(4001);
  });
});
