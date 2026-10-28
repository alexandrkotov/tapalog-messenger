import { describe, expect, it } from "bun:test";
import { ArgsError, DEFAULT_PORT, parseArgs } from "../src/args";

describe("parseArgs", () => {
  it("uses defaults with no flags", () => {
    expect(parseArgs([])).toEqual({
      port: DEFAULT_PORT,
      data: null,
      open: true,
      publicUrl: null,
      invite: false,
      tunnelToken: null,
      quickTunnel: false,
      noTunnel: false,
      forgetTunnel: false,
      checkTunnelBinary: false,
      version: false,
      help: false,
    });
  });

  it("reads every flag", () => {
    expect(
      parseArgs(["--port", "9000", "--data", "/srv/m", "--no-open", "--public-url", "https://m.example.com/x", "--invite", "--version"]),
    ).toEqual({
      port: 9000,
      data: "/srv/m",
      open: false,
      publicUrl: "https://m.example.com",
      invite: true,
      tunnelToken: null,
      quickTunnel: false,
      noTunnel: false,
      forgetTunnel: false,
      checkTunnelBinary: false,
      version: true,
      help: false,
    });
  });

  it("rejects a bad port, a missing value and unknown flags", () => {
    expect(() => parseArgs(["--port", "70000"])).toThrow(ArgsError);
    expect(() => parseArgs(["--port", "abc"])).toThrow(ArgsError);
    expect(() => parseArgs(["--data"])).toThrow(ArgsError);
    expect(() => parseArgs(["--data", "--no-open"])).toThrow(ArgsError);
    expect(() => parseArgs(["--tunnel"])).toThrow(ArgsError);
    expect(() => parseArgs(["--public-url", "http://m.example.com"])).toThrow(ArgsError);
    expect(() => parseArgs(["--public-url", "m.example.com"])).toThrow(ArgsError);
    expect(() => parseArgs(["--tunnel-token", "abc"])).toThrow(ArgsError);
    expect(() => parseArgs(["--quick-tunnel", "--no-tunnel"])).toThrow(ArgsError);
  });

  it("takes a tunnel token, also out of a pasted install command", () => {
    const token = Buffer.from(JSON.stringify({ a: "acct", t: "tunnel-id", s: "secret" })).toString("base64");
    expect(parseArgs(["--tunnel-token", token]).tunnelToken).toBe(token);
    expect(parseArgs(["--tunnel-token", `sudo cloudflared service install ${token}`]).tunnelToken).toBe(token);
  });
});
