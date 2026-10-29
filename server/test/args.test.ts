import { describe, expect, it } from "bun:test";
import { ArgsError, DEFAULT_PORT, parseArgs } from "../src/args";

describe("parseArgs", () => {
  it("uses defaults with no flags", () => {
    expect(parseArgs([])).toEqual({
      command: "serve",
      service: null,
      port: DEFAULT_PORT,
      data: null,
      open: true,
      publicUrl: null,
      invite: false,
      tunnelToken: null,
      quickTunnel: false,
      noTunnel: false,
      forgetTunnel: false,
      behindProxy: false,
      checkTunnelBinary: false,
      version: false,
      help: false,
    });
  });

  it("reads every flag", () => {
    expect(
      parseArgs(["--port", "9000", "--data", "/srv/m", "--no-open", "--public-url", "https://m.example.com/x", "--invite", "--behind-proxy", "--version"]),
    ).toEqual({
      command: "serve",
      service: null,
      port: 9000,
      data: "/srv/m",
      open: false,
      publicUrl: "https://m.example.com",
      invite: true,
      tunnelToken: null,
      quickTunnel: false,
      noTunnel: false,
      forgetTunnel: false,
      behindProxy: true,
      checkTunnelBinary: false,
      version: true,
      help: false,
    });
  });

  it("reads the backup command, with a data folder and nothing else", () => {
    expect(parseArgs(["backup"])).toMatchObject({ command: "backup", data: null });
    expect(parseArgs(["backup", "--data", "/srv/m"])).toMatchObject({ command: "backup", data: "/srv/m" });
    expect(() => parseArgs(["--data", "/srv/m", "backup"])).toThrow(ArgsError);
    expect(() => parseArgs(["backup", "--port", "9000"])).toThrow(ArgsError);
  });

  it("reads the service commands and what each one takes", () => {
    expect(parseArgs(["service", "install", "--public-url", "https://m.example.com", "--port", "9000"])).toMatchObject({
      command: "service",
      service: { action: "install", file: null },
      publicUrl: "https://m.example.com",
      port: 9000,
    });
    expect(parseArgs(["service", "update", "/tmp/new-binary"])).toMatchObject({ service: { action: "update", file: "/tmp/new-binary" } });
    expect(parseArgs(["service", "uninstall"])).toMatchObject({ service: { action: "uninstall", file: null } });
    expect(() => parseArgs(["service"])).toThrow(ArgsError);
    expect(() => parseArgs(["service", "start"])).toThrow(ArgsError);
    expect(() => parseArgs(["service", "install"])).toThrow(ArgsError); // needs the address
    expect(() => parseArgs(["service", "install", "--public-url", "https://m.example.com", "--data", "/srv"])).toThrow(ArgsError);
    expect(() => parseArgs(["service", "update"])).toThrow(ArgsError);
    expect(() => parseArgs(["service", "update", "--port", "9000"])).toThrow(ArgsError);
    expect(() => parseArgs(["service", "uninstall", "--no-open"])).toThrow(ArgsError);
    expect(() => parseArgs(["--no-open", "service", "install"])).toThrow(ArgsError);
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
