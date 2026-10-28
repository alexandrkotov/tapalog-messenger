import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ID } from "@tapalog-messenger/shared";
import { migrate } from "../src/db";
import { startServer, type ServerHandle } from "../src/server";

const KEY = "k".repeat(64);
let server: ServerHandle;
let base: string;
let shutdownCalls = 0;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "tm-srv-"));
  const file = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };
  server = startServer({
    port: 0,
    adminKey: KEY,
    db: (() => {
      const db = new Database(":memory:", { strict: true });
      migrate(db);
      return db;
    })(),
    assets: {
      "/index.html": file("index.html", "<!doctype html><title>shell</title>"),
      "/assets/app-abc.js": file("app-abc.js", "console.log(1)"),
      "/sw.js": file("sw.js", "// sw"),
    },
    health: { app: APP_ID, ok: true, version: "1.2.3", schema: 1 },
    status: () => ({ version: "1.2.3", schema: 1, localUrl: "http://localhost", publicUrl: null, setupInviteUrl: null, tunnel: null, addressChangedFrom: null, dataDir: "/data", startedAt: "now" }),
    onShutdownRequested: () => shutdownCalls++,
  });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop());

const html = { Accept: "text/html" };

describe("server", () => {
  it("answers /healthz for anyone", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ app: APP_ID, ok: true, version: "1.2.3", schema: 1 });
  });

  it("refuses the status page, status JSON and shutdown without the right key", async () => {
    for (const path of ["/status", "/status.json", "/status?key=wrong"]) {
      expect((await fetch(base + path)).status).toBe(403);
    }
    expect((await fetch(`${base}/shutdown`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${base}/shutdown`, { method: "POST", headers: { "X-Admin-Key": "wrong" } })).status).toBe(403);
    expect(shutdownCalls).toBe(0);
  });

  it("serves the status page with the key, with a nonce-only script policy", async () => {
    const res = await fetch(`${base}/status?key=${KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toMatch(/script-src 'nonce-[0-9a-f]+'/);
    expect(await res.text()).toContain("Stop server");
    expect(await (await fetch(`${base}/status.json`, { headers: { "X-Admin-Key": KEY } })).json()).toMatchObject({ dataDir: "/data" });
  });

  it("shutdown needs POST, then asks main to stop", async () => {
    expect((await fetch(`${base}/shutdown`, { headers: { "X-Admin-Key": KEY } })).status).toBe(405);
    expect((await fetch(`${base}/shutdown`, { method: "POST", headers: { "X-Admin-Key": KEY } })).status).toBe(202);
    await Bun.sleep(100);
    expect(shutdownCalls).toBe(1);
  });

  it("serves the shell at / and for client routes, but not for missing files or server routes", async () => {
    expect(await (await fetch(`${base}/`, { headers: html })).text()).toContain("shell");
    expect(await (await fetch(`${base}/chat/42`, { headers: html })).text()).toContain("shell");
    expect((await fetch(`${base}/missing.js`, { headers: html })).status).toBe(404);
    expect((await fetch(`${base}/api/nothing`, { headers: html })).status).toBe(401); // needs a session; never the shell
    expect((await fetch(`${base}/chat/42`)).status).toBe(404); // not a browser navigation
  });

  it("caches hashed assets forever and everything else never", async () => {
    expect((await fetch(`${base}/assets/app-abc.js`)).headers.get("Cache-Control")).toContain("immutable");
    expect((await fetch(`${base}/sw.js`)).headers.get("Cache-Control")).toBe("no-cache");
    expect((await fetch(`${base}/`, { headers: html })).headers.get("Cache-Control")).toBe("no-cache");
  });

  it("sends no CORS headers, so other sites cannot read responses", async () => {
    const res = await fetch(`${base}/healthz`, { headers: { Origin: "https://evil.example" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
