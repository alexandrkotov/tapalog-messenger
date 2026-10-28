import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How to start the server under test. With TM_BINARY set (CI), the compiled
 * executable — what users actually run; otherwise the sources through Bun.
 */
export function serverCommand(port: number, dataDir: string): string[] {
  const bin = process.env.TM_BINARY;
  const args = ["--port", String(port), "--data", JSON.stringify(dataDir), "--no-open"];
  return bin ? [JSON.stringify(bin), ...args] : ["bun", "../server/src/main.ts", ...args];
}

/** A one-person invite link from the host side, the way the status page makes one. */
export async function inviteCode(baseUrl: string, dataDir = process.env.TM_E2E_DATA!): Promise<string> {
  const key = readFileSync(join(dataDir, "admin.key"), "utf-8").trim();
  const res = await fetch(`${baseUrl}/admin/invite`, { method: "POST", headers: { "X-Admin-Key": key } });
  if (!res.ok) throw new Error(`/admin/invite: ${res.status}`);
  return ((await res.json()) as { code: string }).code;
}

/** A server of a test's own, for tests that stop and restart it. */
export class OwnServer {
  readonly dataDir = mkdtempSync(join(tmpdir(), "tm-e2e-own-"));
  private proc: ChildProcess | null = null;

  constructor(readonly port: number) {}

  get url() {
    return `http://localhost:${this.port}`;
  }

  async start() {
    const [cmd, ...args] = serverCommand(this.port, this.dataDir).map((a) => a.replace(/^"(.*)"$/, "$1"));
    this.proc = spawn(cmd!, args, { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${this.url}/healthz`).then((r) => r.ok, () => false)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("own server did not start");
  }

  /** Kills the process outright, like a crash or a pulled plug. */
  kill() {
    this.proc?.kill("SIGKILL");
    this.proc = null;
  }

  invite() {
    return inviteCode(this.url, this.dataDir);
  }
}
