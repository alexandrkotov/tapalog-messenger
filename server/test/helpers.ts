import { Database } from "bun:sqlite";
import { APP_ID, type ServerFrame } from "@tapalog-messenger/shared";
import { migrate } from "../src/db";
import { startServer, type ServerHandle } from "../src/server";
import { createInvite } from "../src/store/accounts";

/** A real server on a free port with an in-memory database. */
export function testServer(opts: { publicUrl?: string; trustCfConnectingIp?: boolean } = {}) {
  const db = new Database(":memory:", { strict: true });
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  const server: ServerHandle = startServer({
    port: 0,
    adminKey: "k".repeat(64),
    db,
    assets: {},
    publicUrl: opts.publicUrl ?? null,
    trustCfConnectingIp: opts.trustCfConnectingIp,
    health: { app: APP_ID, ok: true, version: "0", schema: 2 },
    status: () => ({ version: "0", schema: 2, localUrl: "", publicUrl: null, setupInviteUrl: null, tunnel: null, addressChangedFrom: null, dataDir: "", startedAt: "" }),
  });
  const base = `http://localhost:${server.port}`;
  const invite = (grantsAdmin = false) => createInvite(db, { createdBy: null, grantsAdmin, maxUses: 1, expiresAt: null, now: Date.now() }).code;
  return { db, server, base, origin: base, invite };
}

/** A browser-like client: keeps the session cookie and sends our Origin. */
export class Client {
  cookie = "";
  id = 0;

  constructor(
    private base: string,
    public username = "",
  ) {}

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: { Origin: this.base, ...(this.cookie && { Cookie: this.cookie }), ...(body !== undefined && { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("Set-Cookie");
    if (set) this.cookie = set.split(";")[0]!;
    const data = (await res.json().catch(() => null)) as any;
    return { status: res.status, data, headers: res.headers };
  }

  async register(invite: string, username: string, password = "password123") {
    const res = await this.call("POST", "/api/auth/register", { invite, username, display_name: username.toUpperCase(), password, device_name: "Test" });
    if (res.status !== 201) throw new Error(`register ${username}: ${res.status} ${JSON.stringify(res.data)}`);
    this.username = username;
    this.id = res.data.user.id;
    return this;
  }

  connect(): Promise<Socket> {
    return Socket.open(this.base.replace("http", "ws") + "/ws", { Origin: this.base, Cookie: this.cookie });
  }
}

/** A WebSocket that records what it receives and can wait for a frame. */
export class Socket {
  frames: ServerFrame[] = [];
  closed: { code: number } | null = null;
  private waiters: { match: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];

  private constructor(public ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const frame = JSON.parse(String(e.data)) as ServerFrame;
      this.frames.push(frame);
      this.waiters = this.waiters.filter((w) => {
        if (!w.match(frame)) return true;
        w.resolve(frame);
        return false;
      });
    });
    ws.addEventListener("close", (e) => (this.closed = { code: e.code }));
  }

  static open(url: string, headers: Record<string, string>): Promise<Socket> {
    // Bun's WebSocket takes headers, unlike a browser's.
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(new Socket(ws)));
      ws.addEventListener("error", () => reject(new Error("WebSocket refused")));
    });
  }

  send(frame: unknown) {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  /** The first frame (already received or arriving within the timeout) of type `t` that passes `pred`. */
  next<T extends ServerFrame["t"]>(t: T, pred: (f: Extract<ServerFrame, { t: T }>) => boolean = () => true, timeoutMs = 2000) {
    type F = Extract<ServerFrame, { t: T }>;
    const match = (f: ServerFrame): boolean => f.t === t && pred(f as F);
    const seen = this.frames.find(match);
    if (seen) {
      this.frames.splice(this.frames.indexOf(seen), 1);
      return Promise.resolve(seen as F);
    }
    return new Promise<F>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${t} frame within ${timeoutMs} ms; got ${JSON.stringify(this.frames)}`)), timeoutMs);
      this.waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer);
          this.frames.splice(this.frames.indexOf(f), 1);
          resolve(f as F);
        },
      });
    });
  }

  /** Lets in-flight frames land, then says whether one of type `t` arrived. */
  async got(t: ServerFrame["t"], waitMs = 150) {
    await Bun.sleep(waitMs);
    return this.frames.some((f) => f.t === t);
  }

  close() {
    this.ws.close();
  }
}
