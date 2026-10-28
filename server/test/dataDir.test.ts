import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { DATA_DIR_NAME, HOME_DATA_DIR_NAME, isCompiled, resolveDataDir } from "../src/dataDir";

const base = { flag: null, execPath: "/opt/tm/tapalog-messenger", cwd: "/work", home: "/home/alec" };

describe("resolveDataDir", () => {
  it("--data wins, resolved against the current directory", () => {
    expect(resolveDataDir({ ...base, compiled: true, flag: "my-data" })).toBe(join("/work", "my-data"));
    expect(resolveDataDir({ ...base, compiled: true, flag: "/srv/m" })).toBe("/srv/m");
  });

  it("puts data next to a compiled binary when that folder is writable", () => {
    expect(resolveDataDir({ ...base, compiled: true, isWritable: () => true })).toBe(join("/opt/tm", DATA_DIR_NAME));
  });

  it("falls back to the home folder when the binary's folder is read-only (.deb, Snap)", () => {
    expect(resolveDataDir({ ...base, compiled: true, isWritable: () => false })).toBe(join("/home/alec", HOME_DATA_DIR_NAME));
  });

  it("uses the current directory when run from source", () => {
    expect(resolveDataDir({ ...base, compiled: false })).toBe(join("/work", DATA_DIR_NAME));
  });
});

describe("isCompiled", () => {
  it("recognises Bun's virtual filesystem on POSIX and Windows", () => {
    expect(isCompiled("/$bunfs/root/tapalog-messenger")).toBe(true);
    expect(isCompiled("B:\\~BUN\\root\\tapalog-messenger.exe")).toBe(true);
    expect(isCompiled("/home/alec/tapalog-messenger/server/src/main.ts")).toBe(false);
  });
});
