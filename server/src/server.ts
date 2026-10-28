import type { HealthResponse } from "@tapalog-messenger/shared";
import { keyMatches } from "./adminKey";
import { renderStatusPage, type StatusInfo } from "./statusPage";

/** URL path → file the binary can read (an embedded `$bunfs` path when compiled). */
export type AssetMap = Readonly<Record<string, string>>;

export interface ServerOptions {
  port: number;
  /** 127.0.0.1 by default: in internet mode the tunnel connects locally, and nothing else should reach the server directly. */
  hostname?: string;
  assets: AssetMap;
  adminKey: string;
  health: HealthResponse;
  status: () => StatusInfo;
  /** Called after a valid POST /shutdown has been answered. */
  onShutdownRequested?: () => void;
}

export interface ServerHandle {
  port: number;
  stop(): Promise<void>;
}

// The client is served from the same origin as the API, so no CORS headers
// at all — their absence is what keeps other sites from reading responses.
const APP_CSP = [
  "default-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const COMMON_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function withHeaders(res: Response, headers: Record<string, string>): Response {
  for (const [k, v] of Object.entries({ ...COMMON_HEADERS, ...headers })) res.headers.set(k, v);
  return res;
}

function json(body: unknown, status = 200): Response {
  return withHeaders(Response.json(body, { status }), { "Cache-Control": "no-store", "Content-Security-Policy": APP_CSP });
}

function text(body: string, status: number): Response {
  return withHeaders(new Response(body, { status }), { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
}

/** Paths the client router never owns, so they never fall back to index.html. */
const RESERVED_PREFIXES = ["/api/", "/ws", "/media/", "/healthz", "/status", "/shutdown"];

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
  const adminKeyOf = (req: Request, url: URL) => req.headers.get("X-Admin-Key") ?? url.searchParams.get("key");

  const bunServer = Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/healthz") return json(opts.health);

      if (pathname === "/status" || pathname === "/status.json" || pathname === "/shutdown") {
        if (!keyMatches(opts.adminKey, adminKeyOf(req, url))) return text("Forbidden", 403);
        if (pathname === "/status.json") return json(opts.status());
        if (pathname === "/status") {
          const nonce = crypto.randomUUID().replaceAll("-", "");
          return withHeaders(new Response(renderStatusPage(opts.status(), nonce), { headers: { "Content-Type": "text/html; charset=utf-8" } }), {
            "Cache-Control": "no-store",
            "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
          });
        }
        if (req.method !== "POST") return text("Method Not Allowed", 405);
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
  });

  let stopped = false;
  return {
    port: bunServer.port ?? opts.port,
    async stop() {
      if (stopped) return;
      stopped = true;
      await bunServer.stop(true);
    },
  };
}
