import { afterAll, describe, expect, it } from "bun:test";
import { Client, testServer } from "./helpers";

const t = testServer();
afterAll(() => t.server.stop());
let n = 0;
const uniq = (name: string) => `${name}${++n}`;
const newUser = (name: string, admin = false) => new Client(t.base).register(t.invite(admin), uniq(name));

describe("register and log in", () => {
  it("registers with an invite, which then is used up", async () => {
    const code = t.invite();
    const alice = new Client(t.base);
    const res = await alice.call("POST", "/api/auth/register", { invite: code, username: uniq("Alice"), display_name: "Alice", password: "password123", device_name: "Laptop" });
    expect(res.status).toBe(201);
    expect(res.data.user).toMatchObject({ display_name: "Alice", is_admin: false });
    expect(res.data.user.username).toMatch(/^alice\d+$/); // stored lower-case
    expect(res.headers.get("Set-Cookie")).toMatch(/^session=[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    expect((await alice.call("GET", "/api/me")).data.user.display_name).toBe("Alice");

    const again = await new Client(t.base).call("POST", "/api/auth/register", { invite: code, username: uniq("xavier"), display_name: "X", password: "password123" });
    expect(again).toMatchObject({ status: 403, data: { error: "invite_invalid" } });
  });

  it("refuses a taken username without using up the invite", async () => {
    const alice = await newUser("alice");
    const code = t.invite();
    const res = await new Client(t.base).call("POST", "/api/auth/register", { invite: code, username: alice.username, display_name: "A", password: "password123" });
    expect(res).toMatchObject({ status: 409, data: { error: "username_taken" } });
    expect((await new Client(t.base).call("POST", "/api/auth/register", { invite: code, username: uniq("bob"), display_name: "B", password: "password123" })).status).toBe(201);
  });

  it("checks the username, name and password", async () => {
    for (const body of [
      { username: "ab", display_name: "A", password: "password123" },
      { username: "has space", display_name: "A", password: "password123" },
      { username: uniq("ok"), display_name: " ", password: "password123" },
      { username: uniq("ok"), display_name: "A", password: "short" },
    ]) {
      expect((await new Client(t.base).call("POST", "/api/auth/register", { invite: t.invite(), ...body })).status).toBe(400);
    }
  });

  it("an admin invite makes an admin", async () => {
    expect((await (await newUser("root", true)).call("GET", "/api/me")).data.user.is_admin).toBe(true);
  });

  it("logs in with the right password only, and logs out", async () => {
    const alice = await newUser("alice");
    const phone = new Client(t.base);
    expect((await phone.call("POST", "/api/auth/login", { username: alice.username, password: "wrong-password" })).status).toBe(401);
    expect((await phone.call("POST", "/api/auth/login", { username: "nobody-here", password: "password123" })).status).toBe(401);
    expect((await phone.call("POST", "/api/auth/login", { username: alice.username.toUpperCase(), password: "password123", device_name: "Phone" })).status).toBe(200);
    expect((await phone.call("GET", "/api/me")).status).toBe(200);

    const out = await phone.call("POST", "/api/auth/logout");
    expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await phone.call("GET", "/api/me")).status).toBe(401);
    expect((await alice.call("GET", "/api/me")).status).toBe(200); // the other device is still in
  });

  it("lists devices and signs one out from another", async () => {
    const alice = await newUser("alice");
    const phone = new Client(t.base);
    await phone.call("POST", "/api/auth/login", { username: alice.username, password: "password123", device_name: "Phone" });
    const devices = (await alice.call("GET", "/api/devices")).data as { id: number; name: string; current: boolean }[];
    expect(devices.map((d) => [d.name, d.current]).sort()).toEqual([["Phone", false], ["Test", true]]);
    const phoneId = devices.find((d) => d.name === "Phone")!.id;
    expect((await alice.call("DELETE", `/api/devices/${phoneId}`)).status).toBe(200);
    expect((await phone.call("GET", "/api/me")).status).toBe(401);
  });

  it("changes the display name and the password", async () => {
    const alice = await newUser("alice");
    expect((await alice.call("PATCH", "/api/me", { display_name: "Alice K" })).data.user.display_name).toBe("Alice K");
    expect((await alice.call("PATCH", "/api/me", { password: { current: "nope-nope", next: "new-password" } })).status).toBe(401);
    expect((await alice.call("PATCH", "/api/me", { password: { current: "password123", next: "new-password" } })).status).toBe(200);
    expect((await new Client(t.base).call("POST", "/api/auth/login", { username: alice.username, password: "new-password" })).status).toBe(200);
  });

  it("limits guessing: the 11th try in a minute from one address is refused", async () => {
    const own = testServer({ trustCfConnectingIp: true });
    try {
      const c = new Client(own.base);
      const tryOnce = (ip: string) => c.call("POST", "/api/auth/login", { username: "x", password: "y" }, { "CF-Connecting-IP": ip });
      for (let i = 0; i < 10; i++) expect((await tryOnce("203.0.113.5")).status).toBe(401);
      expect((await tryOnce("203.0.113.5")).status).toBe(429);
      expect((await tryOnce("203.0.113.6")).status).toBe(401); // someone else is not affected
    } finally {
      await own.server.stop();
    }
  });
});

describe("guards", () => {
  it("everything but register and login needs a session", async () => {
    for (const [method, path] of [["GET", "/api/me"], ["GET", "/api/chats"], ["POST", "/api/chats"], ["GET", "/api/users?q=a"]] as const) {
      expect((await new Client(t.base).call(method, path)).status).toBe(401);
    }
  });

  it("refuses changes sent from another site's page", async () => {
    const alice = await newUser("alice");
    const res = await alice.call("PATCH", "/api/me", { display_name: "Pwned" }, { Origin: "https://evil.example" });
    expect(res).toMatchObject({ status: 403, data: { error: "bad_origin" } });
  });

  it("gives Secure __Host- cookies on the public address and plain ones locally", async () => {
    const pub = testServer({ publicUrl: "https://chat.example.com" });
    try {
      const viaTunnel = await new Client(pub.base).call(
        "POST",
        "/api/auth/register",
        { invite: pub.invite(), username: "tunnel", display_name: "T", password: "password123" },
        { Host: "chat.example.com", Origin: "https://chat.example.com" },
      );
      expect(viaTunnel.status).toBe(201);
      expect(viaTunnel.headers.get("Set-Cookie")).toMatch(/^__Host-session=.*; Secure;/);
      const local = await new Client(pub.base).call("POST", "/api/auth/login", { username: "tunnel", password: "password123" });
      expect(local.headers.get("Set-Cookie")).toMatch(/^session=/);
      expect(local.headers.get("Set-Cookie")).not.toContain("Secure");
    } finally {
      await pub.server.stop();
    }
  });
});

describe("chats over HTTP", () => {
  it("a direct chat is created once and only its members can see it", async () => {
    const [alice, bob, eve] = await Promise.all([newUser("alice"), newUser("bob"), newUser("eve")]);
    const first = await alice.call("POST", "/api/chats", { kind: "direct", user: bob.id });
    expect(first.status).toBe(201);
    expect((await bob.call("POST", "/api/chats", { kind: "direct", user: alice.id })).data.id).toBe(first.data.id);
    expect((await bob.call("GET", "/api/chats")).data.map((c: { id: number }) => c.id)).toContain(first.data.id);
    expect((await eve.call("GET", `/api/chats/${first.data.id}`)).status).toBe(404);
    expect((await eve.call("GET", `/api/chats/${first.data.id}/messages`)).status).toBe(404);
  });

  it("groups: create, rename, add, remove — admins only", async () => {
    const [alice, bob, carol] = await Promise.all([newUser("alice"), newUser("bob"), newUser("carol")]);
    const g = (await alice.call("POST", "/api/chats", { kind: "group", title: "Team", members: [bob.id] })).data;
    expect(g.members.map((m: { id: number; role: string }) => [m.id, m.role])).toEqual([[alice.id, "admin"], [bob.id, "member"]]);
    expect((await bob.call("PATCH", `/api/chats/${g.id}`, { title: "Mine" })).status).toBe(403);
    expect((await bob.call("POST", `/api/chats/${g.id}/members`, { user: carol.id })).status).toBe(403);
    expect((await alice.call("PATCH", `/api/chats/${g.id}`, { title: "Team 2" })).data.title).toBe("Team 2");
    expect((await alice.call("POST", `/api/chats/${g.id}/members`, { user: carol.id })).data.members).toHaveLength(3);
    expect((await alice.call("PATCH", `/api/chats/${g.id}/members/${bob.id}`, { role: "admin" })).status).toBe(200);
    expect((await bob.call("DELETE", `/api/chats/${g.id}/members/${carol.id}`)).status).toBe(200);
    expect((await carol.call("GET", `/api/chats/${g.id}`)).status).toBe(404);
  });

  it("finds people by name", async () => {
    const alice = await newUser("alice");
    const zed = await newUser("zedonly");
    const found = (await alice.call("GET", "/api/users?q=zedon")).data;
    expect(found).toEqual([{ id: zed.id, username: zed.username, display_name: zed.username.toUpperCase(), avatar: null }]);
  });
});

describe("invites", () => {
  it("only admins create and list them", async () => {
    const admin = await newUser("admin", true);
    const user = await newUser("user");
    expect((await user.call("POST", "/api/invites", {})).status).toBe(403);
    const inv = await admin.call("POST", "/api/invites", { max_uses: 3, expires_in_days: 2 });
    expect(inv.status).toBe(201);
    expect(inv.data).toMatchObject({ max_uses: 3, grants_admin: false, url: `${t.base}/invite/${inv.data.code}` });
    expect((await admin.call("GET", "/api/invites")).data.map((i: { code: string }) => i.code)).toContain(inv.data.code);
    expect((await admin.call("DELETE", `/api/invites/${inv.data.code}`)).status).toBe(200);
  });

  it("the host can make one with the admin key", async () => {
    expect((await fetch(`${t.base}/admin/invite`, { method: "POST" })).status).toBe(403);
    const res = await fetch(`${t.base}/admin/invite`, { method: "POST", headers: { "X-Admin-Key": "k".repeat(64) } });
    expect(res.status).toBe(201);
    const { code } = (await res.json()) as { code: string };
    expect((await new Client(t.base).call("POST", "/api/auth/register", { invite: code, username: uniq("guest"), display_name: "G", password: "password123" })).status).toBe(201);
  });
});
