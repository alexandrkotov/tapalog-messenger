import { afterAll, describe, expect, it } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error: no types; the reference implementation, used only to check ours.
import ece from "http_ece";
import type { PushPayload } from "@tapalog-messenger/shared";
import { encryptPayload, isPushServiceUrl, loadOrCreateVapid, vapidAuthorization } from "../src/push";
import { Client, testServer } from "./helpers";

/** What a browser holds: its key pair and auth secret, and the subscription it hands to the server. */
function browserKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
}

function decrypt(body: Uint8Array, browser: ReturnType<typeof browserKeys>): string {
  return ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: browser.ecdh, authSecret: browser.auth.toString("base64url") }).toString("utf-8");
}

const vapid = await loadOrCreateVapid(mkdtempSync(join(tmpdir(), "tm-vapid-")));

async function verifyJwt(authorization: string, key: string) {
  const [, token, k] = authorization.match(/^vapid t=([^,]+), k=(.+)$/)!;
  expect(k).toBe(key);
  const [header, claims, signature] = token!.split(".");
  const publicKey = await crypto.subtle.importKey("raw", Buffer.from(key, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, Buffer.from(signature!, "base64url"), new TextEncoder().encode(`${header}.${claims}`));
  return { ok, header: JSON.parse(Buffer.from(header!, "base64url").toString()), claims: JSON.parse(Buffer.from(claims!, "base64url").toString()) };
}

describe("push crypto", () => {
  it("encrypts so a browser can read it (checked against http_ece)", async () => {
    const browser = browserKeys();
    for (const text of ["", "hi", "ж".repeat(2000)]) {
      const body = await encryptPayload(new TextEncoder().encode(text), browser.keys);
      expect(decrypt(body, browser)).toBe(text);
    }
  });

  it("signs a VAPID token for the push service's origin", async () => {
    const now = Date.UTC(2026, 9, 28);
    const auth = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", vapid, "https://messenger.example", now);
    const jwt = await verifyJwt(auth, vapid.publicKey);
    expect(jwt.ok).toBe(true);
    expect(jwt.header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(jwt.claims).toEqual({ aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: "https://messenger.example" });
  });

  it("keeps its keys in the data folder across restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tm-vapid-"));
    const first = await loadOrCreateVapid(dir);
    const second = await loadOrCreateVapid(dir);
    expect(second.publicKey).toBe(first.publicKey);
    expect(Buffer.from(first.publicKey, "base64url")).toHaveLength(65);
    if (process.platform !== "win32") expect(statSync(join(dir, "vapid.json")).mode & 0o777).toBe(0o600);
    expect((await verifyJwt(await vapidAuthorization("https://x.example/", second, "https://localhost", 0), first.publicKey)).ok).toBe(true);
  });

  it("sends only to the known push services", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ])
      expect(isPushServiceUrl(ok)).toBe(true);
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evilnotify.windows.com/x",
      "https://localhost/x",
      "https://192.168.1.1/x",
      "not a url",
    ])
      expect(isPushServiceUrl(bad)).toBe(false);
  });
});

/** A stand-in push service that records what reaches it and answers with `status`. */
function fakePushService() {
  const received: { path: string; headers: Headers; body: Uint8Array }[] = [];
  let status = 201;
  const waiters: (() => void)[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push({ path: new URL(req.url).pathname, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
      waiters.splice(0).forEach((w) => w());
      return new Response(null, { status });
    },
  });
  return {
    url: (name: string) => `http://localhost:${server.port}/push/${name}`,
    received,
    answer: (s: number) => (status = s),
    /** Waits for the next push, or gives up and resolves anyway. */
    next: (ms = 1000) => new Promise<void>((resolve) => (waiters.push(resolve), setTimeout(resolve, ms))),
    stop: () => server.stop(true),
  };
}

describe("notifications", () => {
  const service = fakePushService();
  const t = testServer({ push: { vapid, allowEndpoint: (e) => e.startsWith(service.url("")) } });
  afterAll(() => (t.server.stop(), service.stop()));
  let n = 0;
  const newUser = (name: string) => new Client(t.base).register(t.invite(), `${name}${++n}`);

  async function pair() {
    const alice = await newUser("alice");
    const bob = await newUser("bob");
    const chat = (await alice.call("POST", "/api/chats", { kind: "direct", user: bob.id })).data.id as number;
    const browser = browserKeys();
    const endpoint = service.url(`bob${n}`);
    expect((await bob.call("POST", "/api/push/subscribe", { endpoint, keys: browser.keys, lang: "ru" })).status).toBe(201);
    return { alice, bob, chat, browser, endpoint };
  }

  async function say(c: Client, chat: number, body: string) {
    const ws = await c.connect();
    ws.send({ t: "msg.send", chat, client_id: crypto.randomUUID(), kind: "text", body });
    await ws.next("msg.new");
    ws.close();
  }

  /** How many pushes reached this subscription after `act`. */
  async function pushesDuring(endpoint: string, act: () => Promise<unknown>) {
    const path = new URL(endpoint).pathname;
    const before = service.received.filter((r) => r.path === path).length;
    const arrived = service.next();
    await act();
    await arrived;
    await Bun.sleep(50);
    return service.received.filter((r) => r.path === path).slice(before);
  }

  it("hands out the public key", async () => {
    const alice = await newUser("alice");
    expect((await alice.call("GET", "/api/push/key")).data).toEqual({ public_key: vapid.publicKey });
    expect((await new Client(t.base).call("GET", "/api/push/key")).status).toBe(401);
  });

  it("wakes a member with no open tab, saying who and where but not what", async () => {
    const { alice, chat, browser, endpoint } = await pair();
    const [push] = await pushesDuring(endpoint, () => say(alice, chat, "the secret is 42"));
    expect(push!.headers.get("content-encoding")).toBe("aes128gcm");
    expect(push!.headers.get("ttl")).toBe("86400");
    expect((await verifyJwt(push!.headers.get("authorization")!, vapid.publicKey)).ok).toBe(true);
    const payload = JSON.parse(decrypt(push!.body, browser)) as PushPayload;
    expect(payload).toEqual({ chat, chat_title: null, from: alice.username.toUpperCase(), icon: null, kind: "text", lang: "ru" });
    expect(JSON.stringify(payload)).not.toContain("42");
  });

  it("names the group in group chats", async () => {
    const { alice, bob, browser, endpoint } = await pair();
    const group = (await alice.call("POST", "/api/chats", { kind: "group", title: "Family", members: [bob.id] })).data.id as number;
    const [push] = await pushesDuring(endpoint, () => say(alice, group, "dinner"));
    expect(JSON.parse(decrypt(push!.body, browser))).toMatchObject({ chat: group, chat_title: "Family" });
  });

  it("wakes each device that has the app closed, even while another one has it open", async () => {
    const { alice, bob, chat, endpoint } = await pair();
    // Bob's phone (the subscription above) is in his pocket; his computer has the chat open.
    const computer = new Client(t.base);
    const login = await computer.call("POST", "/api/auth/login", { username: bob.username, password: "password123", device_name: "PC" });
    expect(login.status).toBe(200);
    const open = await computer.connect();
    expect(await pushesDuring(endpoint, () => say(alice, chat, "to the phone"))).toHaveLength(1);
    open.close();
  });

  it("stays quiet for the sender, for a device with the app open, and for muted chats", async () => {
    const { alice, bob, chat, endpoint } = await pair();
    const aliceBrowser = browserKeys();
    const aliceEndpoint = service.url(`alice${n}`);
    await alice.call("POST", "/api/push/subscribe", { endpoint: aliceEndpoint, keys: aliceBrowser.keys, lang: "en" });
    expect(await pushesDuring(aliceEndpoint, () => say(alice, chat, "mine"))).toHaveLength(0);

    const open = await bob.connect();
    expect(await pushesDuring(endpoint, () => say(alice, chat, "seen live"))).toHaveLength(0);
    open.close();
    await Bun.sleep(50);

    const muted = await bob.call("PATCH", `/api/chats/${chat}`, { muted: true });
    expect(muted.data).toMatchObject({ id: chat, muted: true });
    expect(await pushesDuring(endpoint, () => say(alice, chat, "shh"))).toHaveLength(0);
    expect((await bob.call("PATCH", `/api/chats/${chat}`, { muted: false })).data.muted).toBe(false);
    expect(await pushesDuring(endpoint, () => say(alice, chat, "loud"))).toHaveLength(1);
  });

  it("forgets a subscription the push service says is gone", async () => {
    const { alice, chat, endpoint } = await pair();
    service.answer(410);
    try {
      expect(await pushesDuring(endpoint, () => say(alice, chat, "anyone?"))).toHaveLength(1);
      expect(t.db.query("SELECT 1 FROM push_subscriptions WHERE endpoint = ?").get(endpoint)).toBeNull();
    } finally {
      service.answer(201);
    }
  });

  it("takes only well-formed subscriptions to a push service, and unsubscribes only your own", async () => {
    const { alice, bob, endpoint } = await pair();
    const keys = browserKeys().keys;
    const bad = [
      { endpoint: "https://evil.example/x", keys },
      { endpoint: service.url("x"), keys: { ...keys, auth: "short" } },
      { endpoint: service.url("x"), keys: { ...keys, p256dh: Buffer.alloc(65, 3).toString("base64url") } },
      { endpoint: service.url("x"), keys: { ...keys, p256dh: "not base64!" } },
      { endpoint: service.url("x") },
      { keys },
    ];
    for (const body of bad) expect((await alice.call("POST", "/api/push/subscribe", body)).status).toBe(400);
    expect((await new Client(t.base).call("POST", "/api/push/subscribe", { endpoint: service.url("x"), keys })).status).toBe(401);

    await alice.call("DELETE", "/api/push/subscribe", { endpoint });
    expect(t.db.query("SELECT 1 FROM push_subscriptions WHERE endpoint = ?").get(endpoint)).not.toBeNull();
    await bob.call("DELETE", "/api/push/subscribe", { endpoint });
    expect(t.db.query("SELECT 1 FROM push_subscriptions WHERE endpoint = ?").get(endpoint)).toBeNull();
  });

  it("drops the subscription when its device signs out", async () => {
    const { bob, endpoint } = await pair();
    await bob.call("POST", "/api/auth/logout");
    expect(t.db.query("SELECT 1 FROM push_subscriptions WHERE endpoint = ?").get(endpoint)).toBeNull();
  });
});

describe("without push set up", () => {
  const t = testServer();
  afterAll(() => t.server.stop());
  it("says so", async () => {
    const alice = await new Client(t.base).register(t.invite(), "alice");
    expect((await alice.call("GET", "/api/push/key")).status).toBe(404);
    expect((await alice.call("POST", "/api/push/subscribe", { endpoint: "https://fcm.googleapis.com/x", keys: browserKeys().keys })).status).toBe(400);
  });
});

