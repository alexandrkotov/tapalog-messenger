import { describe, expect, it } from "bun:test";
import { ArgsError, DEFAULT_PORT, parseArgs } from "../src/args";

describe("parseArgs", () => {
  it("uses defaults with no flags", () => {
    expect(parseArgs([])).toEqual({ port: DEFAULT_PORT, data: null, open: true, version: false, help: false });
  });

  it("reads every flag", () => {
    expect(parseArgs(["--port", "9000", "--data", "/srv/m", "--no-open", "--version"])).toEqual({
      port: 9000,
      data: "/srv/m",
      open: false,
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
  });
});
