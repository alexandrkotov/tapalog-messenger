import type { Database } from "bun:sqlite";
import type { HealthResponse } from "@tapalog-messenger/shared";
import { LIMITS } from "@tapalog-messenger/shared";
import { keyMatches } from "./adminKey";
import { createApi, inviteDto } from "./api";
import { createFiles } from "./files";
import { authenticate, originAllowed, originsFor } from "./auth";
import { APP_CSP, error, json, text, withHeaders } from "./http";
import { Hub, type SocketData } from "./hub";
import { createInvite } from "./store/accounts";
import { collectGarbage } from "./store/media";
import { renderStatusPage, tunnelText, type StatusInfo } from "./statusPage";

/** URL path → file the binary can read (an embedded `$bunfs` path when compiled). */
export type AssetMap = Readonly<Record<string, string>>;

export interface ServerOptions {
  port: number;
  /** 127.0.0.1 by default: in internet mode the tunnel connects locally, and nothing else should reach the server directly. */
  hostname?: string;
  assets: AssetMap;
  adminKey: string;
  db: Database;
  /** Where uploads are stored: messenger-data/media. */
  mediaDir: string;
  /** The HTTPS address the server is reachable at from outside, e.g. https://messenger.tapalog.com. */
  publicUrl?: string | null;
  /**
   * Take the client IP from Cloudflare's CF-Connecting-IP header. Only when
   * the tunnel is on: the server listens on 127.0.0.1, so every request
   * otherwise looks like it came from this computer.
   */
  trustCfConnectingIp?: boolean;
  health: HealthResponse;
  status: () => StatusInfo;
  /** Called after a valid POST /shutdown has been answered. */
  onShutdownRequested?: () => void;
  now?: () => number;
}

export interface ServerHandle {
  port: number;
  hub: Hub;
  /** The public address, once known (a quick tunnel only learns it after start). */
  publicUrl(): string | null;
  setPublicUrl(url: string): void;
  stop(): Promise<void>;
}

/** Paths the client router never owns, so they never fall back to index.html. */
const RESERVED_PREFIXES = ["/api/", "/ws", "/media/", "/healthz", "/status", "/shutdown", "/admin/"];

/** Time clients get to hear the close frame before the listener goes away. */
const CLOSE_GRACE_MS = 300;

const GARBAGE_EVERY_MS = 3600 * 1000;

function serveAsset(assets: AssetMap, pathname: string, acceptsHtml: boolean): Response | null {
  let file = assets[pathname === "/" ? "/index.html" : pathname];
  if (!file) {
    // A deep link like /chat/42 reloaded in the browser: hand the client its shell.
    const isClientRoute = acceptsHtml && !/\.[a-z0-9]+$/i.test(pathname) && !RESERVED_PREFIXES.some((p) => pathname.startsWith(p));
    if (!isClientRoute) return null;
    file = assets["/index.html"];
    if (!file) return null;
  }
  // Vite puts content-hashed files under /assets/, so they never change; everything else
  // (index.html, sw.js, the manifest) must be revalidated or updates would never reach users.
  const cache = pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  return withHeaders(new Response(Bun.file(file)), { "Cache-Control": cache, "Content-Security-Policy": APP_CSP });
}

export function startServer(opts: ServerOptions): ServerHandle {
  const now = opts.now ?? Date.now;
  const adminKeyOf = (req: Request, url: URL) => req.headers.get("X-Admin-Key") ?? url.searchParams.get("key");
  const origins = originsFor(opts.port, opts.publicUrl ?? null);
  const hub = new Hub(opts.db, now);
  let port = opts.port;
  let publicUrl = opts.publicUrl ?? null;
  const inviteBase = () => publicUrl ?? `http://localhost:${port}`;
  const files = createFiles({ db: opts.db, mediaDir: opts.mediaDir, now });
  const handleApi = createApi({ db: opts.db, hub, files, origins, inviteBase, now });
  const sweep = () => {
    try {
      collectGarbage(opts.db, opts.mediaDir, now());
    } catch (err) {
      console.error(`  Cleaning up unused files failed: ${err instanceof Error ? err.message : err}`);
    }
  };
  sweep();
  const sweepTimer = setInterval(sweep, GARBAGE_EVERY_MS);

  const bunServer = Bun.serve<SocketData>({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    // Uploads stream to disk with their own limit; this only stops a body far beyond it.
    maxRequestBodySize: LIMITS.fileBytes + 1024 * 1024,
    async fetch(req, server) {
      const url = new URL(req.url);
      const { pathname } = url;
      const ip = () => (opts.trustCfConnectingIp && req.headers.get("CF-Connecting-IP")) || server.requestIP(req)?.address || "unknown";

      if (pathname === "/healthz") return json(opts.health);

      if (pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD" && !originAllowed(req, origins)) return error("bad_origin");
        return handleApi(req, url, ip());
      }

      if (pathname.startsWith("/media/") && (req.method === "GET" || req.method === "HEAD")) {
        return files.serve(req, url, authenticate(opts.db, req, now()));
      }

      if (pathname === "/ws") {
        if (!originAllowed(req, origins)) return error("bad_origin");
        const session = authenticate(opts.db, req, now());
        if (!session) return error("unauthorized");
        if (server.upgrade(req, { data: { userId: session.user.id, deviceId: session.deviceId } })) return undefined;
        return text("Expected a WebSocket", 400);
      }

      if (pathname === "/status" || pathname === "/status.json" || pathname === "/shutdown" || pathname === "/admin/invite") {
        if (!keyMatches(opts.adminKey, adminKeyOf(req, url))) return text("Forbidden", 403);
        if (pathname === "/status.json") {
          const st = opts.status();
          return json({ ...st, tunnel: st.tunnel && { ...st.tunnel, text: tunnelText(st.tunnel) } });
        }
        if (pathname === "/status") {
          const nonce = crypto.randomUUID().replaceAll("-", "");
          return withHeaders(new Response(renderStatusPage(opts.status(), nonce), { headers: { "Content-Type": "text/html; charset=utf-8" } }), {
            "Cache-Control": "no-store",
            "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
          });
        }
        if (req.method !== "POST") return text("Method Not Allowed", 405);
        if (pathname === "/admin/invite") {
          // The host's own invite link, from the status page: one person, valid for a week.
          const row = createInvite(opts.db, { createdBy: null, grantsAdmin: false, maxUses: 1, expiresAt: now() + 7 * 24 * 3600 * 1000, now: now() });
          return json(inviteDto(row, inviteBase()), 201);
        }
        // Answer first, then stop: the caller (the Stop button) needs to hear back.
        setTimeout(() => opts.onShutdownRequested?.(), 50);
        return json({ ok: true }, 202);
      }

      if (req.method === "GET" || req.method === "HEAD") {
        const res = serveAsset(opts.assets, pathname, (req.headers.get("Accept") ?? "").includes("text/html"));
        if (res) return res;
      }
      return text("Not Found", 404);
    },
    websocket: {
      ...hub.handlers,
      maxPayloadLength: LIMITS.frameBytes,
      // Bun pings idle sockets itself; clients also ping every 30 s, under Cloudflare's ~100 s idle cut-off.
      idleTimeout: 120,
      sendPings: true,
    },
  });
  hub.attach(bunServer);
  port = bunServer.port ?? opts.port;
  // Port 0 (tests) picks a free port only now.
  for (const origin of originsFor(port, null).allowed) origins.allowed.add(origin);

  let stopped = false;
  return {
    port,
    hub,
    publicUrl: () => publicUrl,
    setPublicUrl(url) {
      publicUrl = url;
      origins.allowed.add(new URL(url).origin);
      origins.publicHost = new URL(url).host;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(sweepTimer);
      hub.closeAll();
      await Bun.sleep(CLOSE_GRACE_MS);
      await bunServer.stop(true);
    },
  };
}
