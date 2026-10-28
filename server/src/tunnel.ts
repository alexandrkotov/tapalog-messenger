/**
 * Runs cloudflared so the server, listening only on 127.0.0.1, is reachable
 * over HTTPS from the internet.
 *
 * - Named tunnel (the normal mode): created once in the Cloudflare
 *   dashboard with a fixed hostname (messenger.tapalog.com) pointing at
 *   http://localhost:<port>. We only pass its token — through the
 *   environment, so it does not show in other users' process lists.
 * - Quick tunnel (demo only): a new https://*.trycloudflare.com address on
 *   every start, read from cloudflared's output, as in ECM.
 *
 * If cloudflared exits, it is started again with a growing delay.
 */

export type TunnelMode = { kind: "named"; token: string } | { kind: "quick" };

export type TunnelState =
  | { state: "starting" }
  | { state: "connected"; url: string | null }
  | { state: "down"; message: string };

// api.trycloudflare.com shows up in error lines and is not ours.
const QUICK_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;
// cloudflared logs this once per edge connection (it keeps four).
const CONNECTED_RE = /Registered tunnel connection|Connection [0-9a-f-]+ registered/;

/** The quick-tunnel address in a line of cloudflared output, if there is one. */
export function findQuickUrl(line: string): string | null {
  return line.match(QUICK_URL_RE)?.[0] ?? null;
}

export function isConnectedLine(line: string): boolean {
  return CONNECTED_RE.test(line);
}

/**
 * Accepts a token as copied from the dashboard — also when the whole
 * `cloudflared service install eyJ…` line was pasted. Null if it is not one.
 */
export function parseTunnelToken(raw: string): string | null {
  const token = raw.match(/eyJ[A-Za-z0-9+/_=-]+/)?.[0];
  if (!token) return null;
  try {
    const decoded = JSON.parse(Buffer.from(token, "base64").toString("utf-8")) as Record<string, unknown>;
    return typeof decoded.a === "string" && typeof decoded.t === "string" && typeof decoded.s === "string" ? token : null;
  } catch {
    return null;
  }
}

export function tunnelCommand(cloudflared: string, mode: TunnelMode, localUrl: string): { cmd: string[]; env: Record<string, string> } {
  // --no-autoupdate: this copy is embedded and pinned; it must not replace itself.
  if (mode.kind === "named") return { cmd: [cloudflared, "tunnel", "--no-autoupdate", "run"], env: { TUNNEL_TOKEN: mode.token } };
  return { cmd: [cloudflared, "tunnel", "--no-autoupdate", "--url", localUrl], env: {} };
}

export interface Tunnel {
  stop(): Promise<void>;
}

export function startTunnel(opts: {
  cloudflared: string;
  mode: TunnelMode;
  localUrl: string;
  onState: (s: TunnelState) => void;
  onLog?: (line: string) => void;
}): Tunnel {
  const { cmd, env } = tunnelCommand(opts.cloudflared, opts.mode, opts.localUrl);
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let stopped = false;
  let delay = 2000;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let lastLines: string[] = [];

  async function watch(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
  }

  function launch() {
    opts.onState({ state: "starting" });
    let url: string | null = null;
    let connected = false;
    lastLines = [];
    try {
      proc = Bun.spawn(cmd, {
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
        // Otherwise Windows opens an empty console window for cloudflared.exe (seen in ECM).
        windowsHide: true,
      });
    } catch (err) {
      opts.onState({ state: "down", message: `Could not start cloudflared: ${err instanceof Error ? err.message : err}` });
      return scheduleRestart();
    }
    const onLine = (line: string) => {
      opts.onLog?.(line);
      lastLines = [...lastLines.slice(-4), line];
      url ??= opts.mode.kind === "quick" ? findQuickUrl(line) : null;
      if (!connected && isConnectedLine(line) && (opts.mode.kind === "named" || url)) {
        connected = true;
        delay = 2000;
        opts.onState({ state: "connected", url });
      }
    };
    const p = proc;
    void watch(p.stdout as ReadableStream<Uint8Array>, onLine);
    void watch(p.stderr as ReadableStream<Uint8Array>, onLine);
    void p.exited.then((code) => {
      if (stopped || proc !== p) return;
      proc = null;
      const tail = lastLines.at(-1)?.replace(/^\S+\s+\S+\s+/, "") ?? "";
      opts.onState({ state: "down", message: `cloudflared exited (code ${code})${tail ? `: ${tail}` : ""}` });
      scheduleRestart();
    });
  }

  function scheduleRestart() {
    if (stopped) return;
    restartTimer = setTimeout(launch, delay);
    delay = Math.min(delay * 2, 60_000);
  }

  launch();
  return {
    async stop() {
      stopped = true;
      clearTimeout(restartTimer);
      const p = proc;
      proc = null;
      if (!p) return;
      p.kill();
      await Promise.race([p.exited, Bun.sleep(3000)]);
    },
  };
}
