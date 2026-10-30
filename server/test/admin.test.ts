import { afterAll, describe, expect, it } from "bun:test";
import { Client, testServer } from "./helpers";

const t = testServer();
afterAll(() => t.server.stop());
let n = 0;
const newUser = (name: string, admin = false) => new Client(t.base).register(t.invite(admin), `${name}${++n}`);
const signIn = (who: Client, password = "password123") => new Client(t.base, who.username).call("POST", "/api/auth/login", { username: who.username, password });

describe("the Server section", () => {
  it("is for administrators only", async () => {
    const bob = await newUser("bob");
    for (const path of ["/api/admin/users", "/api/admin/disk"]) expect((await bob.call("GET", path)).status).toBe(403);
    expect((await bob.call("PATCH", `/api/admin/users/${bob.id}`, { is_admin: true })).status).toBe(403);
  });

  it("lists everyone with their devices and last activity, and the space used", async () => {
    const admin = await newUser("admin", true);
    const bob = await newUser("bob");
    await signIn(bob);
    const users = (await admin.call("GET", "/api/admin/users")).data;
    expect(users.find((u: { id: number }) => u.id === bob.id)).toEqual({
      id: bob.id,
      username: bob.username,
      display_name: bob.username.toUpperCase(),
      avatar: null,
      is_admin: false,
      blocked: false,
      online: false,
      created_at: expect.any(Number),
      last_active_at: expect.any(Number),
      devices: 2,
      groups: 0,
    });
    const disk = (await admin.call("GET", "/api/admin/disk")).data;
    expect(disk).toMatchObject({ db_bytes: expect.any(Number), media_bytes: 0, media_files: 0 });
  });

  it("blocking signs out every device at once, refuses sign-in and hides the person; unblocking lets them back", async () => {
    const admin = await newUser("admin", true);
    const bob = await newUser("bob");
    const alice = await newUser("alice");
    const ws = await bob.connect();

    const blocked = await admin.call("PATCH", `/api/admin/users/${bob.id}`, { blocked: true });
    expect(blocked.data).toMatchObject({ blocked: true, devices: 0 });
    await Bun.sleep(50);
    expect(ws.closed?.code).toBe(4001);
    expect((await bob.call("GET", "/api/me")).status).toBe(401);
    expect((await signIn(bob)).data).toEqual({ error: "blocked" });
    expect((await alice.call("GET", `/api/users?q=${bob.username}`)).data).toEqual([]);
    expect((await alice.call("POST", "/api/chats", { kind: "direct", user: bob.id })).status).toBe(404);

    await admin.call("PATCH", `/api/admin/users/${bob.id}`, { blocked: false });
    expect((await signIn(bob)).status).toBe(200);
  });

  it("never leaves the server without an administrator", async () => {
    // A server of its own, so the count of administrators is known.
    const own = testServer();
    try {
      const admin = await new Client(own.base).register(own.invite(true), "boss");
      const bob = await new Client(own.base).register(own.invite(), "bob");
      expect((await admin.call("PATCH", `/api/admin/users/${admin.id}`, { is_admin: false })).data).toEqual({ error: "last_admin" });
      expect((await admin.call("PATCH", `/api/admin/users/${admin.id}`, { blocked: true })).status).toBe(409);

      expect((await admin.call("PATCH", `/api/admin/users/${bob.id}`, { is_admin: true })).data.is_admin).toBe(true);
      // Now there are two; still, nobody blocks themselves.
      expect((await admin.call("PATCH", `/api/admin/users/${admin.id}`, { blocked: true })).status).toBe(403);
      expect((await admin.call("PATCH", `/api/admin/users/${admin.id}`, { is_admin: false })).data.is_admin).toBe(false);
      expect((await bob.call("PATCH", `/api/admin/users/${bob.id}`, { is_admin: false })).data).toEqual({ error: "last_admin" });
    } finally {
      await own.server.stop();
    }
  });
});

describe("deleting an account", () => {
  const say = (chat: number, body: string) => ({ t: "msg.send", chat, client_id: crypto.randomUUID(), kind: "text", body });

  it("keeps their messages as from a deleted account, deletes their groups, and never gives their number out again", async () => {
    const own = testServer();
    try {
      const make = (name: string, admin = false) => new Client(own.base).register(own.invite(admin), name);
      const admin = await make("boss", true);
      const alice = await make("alice");
      const bob = await make("bob");
      const direct = (await alice.call("POST", "/api/chats", { kind: "direct", user: bob.id })).data.id;
      const aliceGroup = (await alice.call("POST", "/api/chats", { kind: "group", title: "Family", members: [bob.id] })).data.id;
      const bobGroup = (await bob.call("POST", "/api/chats", { kind: "group", title: "Bob's", members: [alice.id] })).data.id;
      expect((await admin.call("GET", "/api/admin/users")).data.find((u: { id: number }) => u.id === bob.id).groups).toBe(1);

      const bobWs = await bob.connect();
      bobWs.send({ t: "hello", sync: {} });
      bobWs.send(say(direct, "hi alice"));
      bobWs.send(say(aliceGroup, "hi all"));
      await bobWs.next("msg.ack");
      await bobWs.next("msg.ack");
      const aliceWs = await alice.connect();
      aliceWs.send({ t: "hello", sync: {} });
      await aliceWs.next("synced");
      const before = (await alice.call("GET", `/api/chats/${direct}`)).data.version;

      expect((await admin.call("DELETE", `/api/admin/users/${admin.id}`)).status).toBe(403);
      expect((await admin.call("DELETE", `/api/admin/users/${bob.id}`)).data).toEqual({ ok: true });
      await Bun.sleep(50);
      expect(bobWs.closed?.code).toBe(4001);
      expect((await bob.call("GET", "/api/me")).status).toBe(401);
      expect((await new Client(own.base).call("POST", "/api/auth/login", { username: "bob", password: "password123", device_name: "x" })).status).toBe(401);

      await aliceWs.next("chat.removed", (f) => f.chat === bobGroup);
      await aliceWs.next("chat.reset", (f) => f.chat === direct);
      const chat = (await aliceWs.next("chat.update", (f) => f.chat.id === direct)).chat;
      expect(chat).toMatchObject({ peer_deleted: true, members: [{ id: alice.id }] });
      expect(chat.version).toBeGreaterThan(before);
      expect((await alice.call("GET", `/api/chats/${bobGroup}`)).status).toBe(404);
      expect((await alice.call("GET", `/api/chats/${direct}/messages`)).data).toMatchObject([{ from: null, body: "hi alice" }]);
      expect((await alice.call("GET", `/api/chats/${aliceGroup}/messages`)).data).toMatchObject([{ from: null, body: "hi all" }]);
      // A device that was away gets the change on reconnecting.
      const later = await alice.connect();
      later.send({ t: "hello", sync: { [direct]: before } });
      expect((await later.next("msg.update")).msg).toMatchObject({ from: null, body: "hi alice" });

      // Nobody is left to read a new message there.
      aliceWs.send(say(direct, "are you there?"));
      expect((await aliceWs.next("error")).code).toBe("forbidden");
      expect((await admin.call("GET", "/api/admin/users")).data.map((u: { username: string }) => u.username).sort()).toEqual(["alice", "boss"]);

      // A newcomer gets a new number, not the deleted one, and a fresh chat.
      const carol = await make("carol");
      expect(carol.id).toBeGreaterThan(bob.id);
      const fresh = (await alice.call("POST", "/api/chats", { kind: "direct", user: carol.id })).data;
      expect(fresh.id).not.toBe(direct);
      expect(fresh.peer_deleted).toBe(false);
      later.close();
      aliceWs.close();
    } finally {
      await own.server.stop();
    }
  });

  it("is for administrators only", async () => {
    const bob = await newUser("bob");
    const alice = await newUser("alice");
    expect((await bob.call("DELETE", `/api/admin/users/${alice.id}`)).status).toBe(403);
  });
});

describe("password reset links", () => {
  it("set a new password once, sign out the old devices, and sign in this one", async () => {
    const admin = await newUser("admin", true);
    const bob = await newUser("bob");
    const ws = await bob.connect();

    const link = (await admin.call("POST", `/api/admin/users/${bob.id}/reset`)).data;
    expect(link.url).toMatch(new RegExp(`^${t.base}/reset/[\\w-]{32}$`));
    const code = link.url.split("/").at(-1);
    const fresh = new Client(t.base);
    expect((await fresh.call("GET", `/api/auth/reset/${code}`)).data).toEqual({ username: bob.username, display_name: bob.username.toUpperCase() });

    expect((await fresh.call("POST", "/api/auth/reset", { code, password: "short" })).status).toBe(400);
    const done = await fresh.call("POST", "/api/auth/reset", { code, password: "new password", device_name: "Phone" });
    expect(done.data.user.id).toBe(bob.id);
    expect((await fresh.call("GET", "/api/me")).status).toBe(200);
    await Bun.sleep(50);
    expect(ws.closed?.code).toBe(4001);
    expect((await bob.call("GET", "/api/me")).status).toBe(401);

    expect((await signIn(bob)).status).toBe(401);
    expect((await signIn(bob, "new password")).status).toBe(200);
    // Used up.
    expect((await new Client(t.base).call("POST", "/api/auth/reset", { code, password: "another one" })).data).toEqual({ error: "reset_invalid" });
  });

  it("a newer link replaces the older one, and blocking voids it", async () => {
    const admin = await newUser("admin", true);
    const bob = await newUser("bob");
    const first = (await admin.call("POST", `/api/admin/users/${bob.id}/reset`)).data.url.split("/").at(-1);
    const second = (await admin.call("POST", `/api/admin/users/${bob.id}/reset`)).data.url.split("/").at(-1);
    expect((await new Client(t.base).call("GET", `/api/auth/reset/${first}`)).status).toBe(403);
    expect((await new Client(t.base).call("GET", `/api/auth/reset/${second}`)).status).toBe(200);
    await admin.call("PATCH", `/api/admin/users/${bob.id}`, { blocked: true });
    expect((await new Client(t.base).call("GET", `/api/auth/reset/${second}`)).status).toBe(403);
    expect((await admin.call("POST", `/api/admin/users/${bob.id}/reset`)).data).toEqual({ error: "blocked" });
  });
});
