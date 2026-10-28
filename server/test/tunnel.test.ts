import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, verify } from "../../scripts/fetch-cloudflared";
import lock from "../../scripts/cloudflared.lock.json";
import { findQuickUrl, isConnectedLine, parseTunnelToken, startTunnel, tunnelCommand, type TunnelState } from "../src/tunnel";

// Real lines from cloudflared 2026.10.0 starting a quick tunnel (captured 2026-10-28).
const QUICK_LOG = [
  "2026-10-28T01:28:04Z INF Requesting new quick Tunnel on trycloudflare.com...",
  "2026-10-28T01:28:06Z INF |  https://looked-collector-trustee-matters.trycloudflare.com                                |",
  "2026-10-28T01:28:06Z INF Registered tunnel connection connIndex=0 connection=6480e412-b4cc-49f2-893b-219a639c7f17 event=0 ip=198.41.200.33 location=pdx03 protocol=quic",
  "2026-10-28T01:28:29Z ERR no more connections active and exiting",
];

describe("cloudflared output", () => {
  it("finds the quick-tunnel address only in the line that has it", () => {
    expect(QUICK_LOG.map((l) => findQuickUrl(l))).toEqual([null, "https://looked-collector-trustee-matters.trycloudflare.com", null, null]);
    expect(findQuickUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF')).toBeNull();
  });

  it("knows when a connection is up", () => {
    expect(QUICK_LOG.map(isConnectedLine)).toEqual([false, false, true, false]);
  });
});

describe("tunnel token", () => {
  const token = Buffer.from(JSON.stringify({ a: "acct", t: "tunnel-id", s: "secret" })).toString("base64");

  it("accepts a real-shaped token and refuses lookalikes", () => {
    expect(parseTunnelToken(token)).toBe(token);
    expect(parseTunnelToken(`  ${token}\n`)).toBe(token);
    expect(parseTunnelToken(Buffer.from(JSON.stringify({ a: "x" })).toString("base64"))).toBeNull();
    expect(parseTunnelToken("eyJnot-json")).toBeNull();
    expect(parseTunnelToken("")).toBeNull();
  });

  it("is passed through the environment, not the command line", () => {
    const { cmd, env } = tunnelCommand("/x/cloudflared", { kind: "named", token }, "http://localhost:8443");
    expect(cmd).toEqual(["/x/cloudflared", "tunnel", "--no-autoupdate", "run"]);
    expect(cmd.join(" ")).not.toContain(token);
    expect(env).toEqual({ TUNNEL_TOKEN: token });
    expect(tunnelCommand("cf", { kind: "quick" }, "http://localhost:9").cmd).toEqual(["cf", "tunnel", "--no-autoupdate", "--url", "http://localhost:9"]);
  });
});

describe("pinned cloudflared", () => {
  it("has a version and a SHA-256 for each of the five builds", () => {
    expect(lock.version).toMatch(/^\d{4}\.\d+\.\d+$/);
    expect(Object.keys(lock.assets).sort()).toEqual(["linux-arm64", "linux-x64", "macos-arm64", "macos-x64", "windows-x64"]);
    for (const a of Object.values(lock.assets)) expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a download whose hash differs", () => {
    const data = new TextEncoder().encode("cloudflared");
    expect(() => verify(data, sha256(data), "ok")).not.toThrow();
    expect(() => verify(data, "0".repeat(64), "bad")).toThrow(/SHA-256/);
  });
});

describe("running cloudflared", () => {
  // A stand-in that prints what the real one prints, so no tunnel is opened.
  function fakeCloudflared(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "tm-cf-"));
    const path = join(dir, "cloudflared");
    writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return path;
  }

  it("reports connected for a named tunnel and gets the token through the environment", async () => {
    const cf = fakeCloudflared(
      `echo "2026-10-28T01:28:06Z INF token=$TUNNEL_TOKEN" >&2\n` +
        `echo "2026-10-28T01:28:06Z INF Registered tunnel connection connIndex=0 location=pdx03 protocol=quic" >&2\n` +
        `sleep 30`,
    );
    const states: TunnelState[] = [];
    const logs: string[] = [];
    const tunnel = startTunnel({ cloudflared: cf, mode: { kind: "named", token: "eyJtoken" }, localUrl: "http://localhost:1", onState: (s) => states.push(s), onLog: (l) => logs.push(l) });
    for (let i = 0; i < 50 && states.at(-1)?.state !== "connected"; i++) await Bun.sleep(20);
    expect(states).toEqual([{ state: "starting" }, { state: "connected", url: null }]);
    expect(logs[0]).toContain("token=eyJtoken");
    await tunnel.stop();
  });

  it("reports a quick tunnel's address once connected", async () => {
    const cf = fakeCloudflared(
      `echo "INF |  https://looked-collector-trustee-matters.trycloudflare.com   |" >&2\n` +
        `echo "INF Registered tunnel connection connIndex=0" >&2\nsleep 30`,
    );
    const states: TunnelState[] = [];
    const tunnel = startTunnel({ cloudflared: cf, mode: { kind: "quick" }, localUrl: "http://localhost:1", onState: (s) => states.push(s) });
    for (let i = 0; i < 50 && states.at(-1)?.state !== "connected"; i++) await Bun.sleep(20);
    expect(states.at(-1)).toEqual({ state: "connected", url: "https://looked-collector-trustee-matters.trycloudflare.com" });
    await tunnel.stop();
  });

  it("says why it went down and starts cloudflared again", async () => {
    const cf = fakeCloudflared(`echo "2026-10-28T01:28:29Z ERR Unauthorized: Invalid tunnel secret" >&2\nexit 1`);
    const states: TunnelState[] = [];
    const tunnel = startTunnel({ cloudflared: cf, mode: { kind: "named", token: "eyJx" }, localUrl: "http://localhost:1", onState: (s) => states.push(s) });
    for (let i = 0; i < 200 && states.filter((s) => s.state === "starting").length < 2; i++) await Bun.sleep(20);
    expect(states[1]).toEqual({ state: "down", message: "cloudflared exited (code 1): Unauthorized: Invalid tunnel secret" });
    expect(states[2]).toEqual({ state: "starting" });
    await tunnel.stop();
  });

  it("stop() ends the process", async () => {
    const cf = fakeCloudflared(`echo "INF Registered tunnel connection" >&2\nexec sleep 30`);
    const states: TunnelState[] = [];
    const tunnel = startTunnel({ cloudflared: cf, mode: { kind: "named", token: "eyJx" }, localUrl: "http://localhost:1", onState: (s) => states.push(s) });
    for (let i = 0; i < 50 && states.at(-1)?.state !== "connected"; i++) await Bun.sleep(20);
    const started = Date.now();
    await tunnel.stop();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(states.at(-1)?.state).toBe("connected"); // no "down" after a deliberate stop
  });
});
