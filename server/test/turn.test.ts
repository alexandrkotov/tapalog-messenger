import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTurnFlags } from "../src/config";
import { TURN_TTL_S, turnCredentials } from "../src/turn";
import { Client, testServer } from "./helpers";

const SECRET = "0123456789abcdef-secret";
const URLS = ["turn:t.example.com:3478", "turns:t.example.com:5349"];

describe("TURN credentials", () => {
  it("are what coturn's use-auth-secret expects: <expiry>:<user>, base64 HMAC-SHA1", () => {
    // Worked out separately with Python's hmac module.
    expect(turnCredentials({ urls: URLS, secret: SECRET }, 5, 1_700_000_000_000)).toEqual({
      ice_servers: [{ urls: URLS, username: "1700021600:5", credential: "yhnUj5iKt37rhrHFdki1wQCkbBI=" }],
      expires_at: (1_700_000_000 + TURN_TTL_S) * 1000,
    });
  });
});

describe("GET /api/turn", () => {
  const withTurn = testServer({ turn: { urls: URLS, secret: SECRET } });
  const without = testServer();
  afterAll(() => Promise.all([withTurn.server.stop(), without.server.stop()]));

  it("needs a session", async () => {
    expect((await new Client(withTurn.base).call("GET", "/api/turn")).status).toBe(401);
  });

  it("gives a signed-in user a password for six hours, and never the secret", async () => {
    const alice = await new Client(withTurn.base).register(withTurn.invite(), "alice");
    const res = await alice.call("GET", "/api/turn");
    expect(res.status).toBe(200);
    expect(res.data.ice_servers[0]).toMatchObject({ urls: URLS, username: expect.stringMatching(new RegExp(`^\\d+:${alice.id}$`)) });
    expect(res.data.expires_at - Date.now()).toBeGreaterThan((TURN_TTL_S - 60) * 1000);
    expect(JSON.stringify(res.data)).not.toContain(SECRET);
  });

  it("says so when no relay is set up", async () => {
    const bob = await new Client(without.base).register(without.invite(), "bob");
    expect(await bob.call("GET", "/api/turn")).toMatchObject({ status: 404, data: { error: "turn_not_configured" } });
  });
});

describe("--turn-url and --turn-secret-file", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-turn-"));
  const file = (body: string) => {
    const path = join(dir, `s${Math.random()}`);
    writeFileSync(path, body);
    return path;
  };

  it("need both the first time, then either one changes just its part", () => {
    expect(() => withTurnFlags({}, URLS, null)).toThrow(/both/);
    const first = withTurnFlags({ public_url: "https://m.example.com" }, URLS, file(`${SECRET}\n`));
    expect(first).toEqual({ public_url: "https://m.example.com", turn: { urls: URLS, secret: SECRET } });
    expect(withTurnFlags(first, ["turn:other.example.com:3478"], null).turn).toEqual({ urls: ["turn:other.example.com:3478"], secret: SECRET });
    expect(withTurnFlags(first, [], file("another-secret-of-length")).turn?.secret).toBe("another-secret-of-length");
    expect(withTurnFlags(first, [], null)).toBe(first);
  });

  it("refuse a short secret or a missing file", () => {
    expect(() => withTurnFlags({}, URLS, file("short"))).toThrow(/at least 16/);
    expect(() => withTurnFlags({}, URLS, join(dir, "missing"))).toThrow(/Cannot read/);
  });
});
