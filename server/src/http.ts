import type { ErrorCode } from "@tapalog-messenger/shared";

// The client is served from the same origin as the API, so no CORS headers
// at all — their absence is what keeps other sites from reading responses.
export const APP_CSP = [
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

export function withHeaders(res: Response, headers: Record<string, string>): Response {
  for (const [k, v] of Object.entries({ ...COMMON_HEADERS, ...headers })) res.headers.set(k, v);
  return res;
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return withHeaders(Response.json(body, { status }), { "Cache-Control": "no-store", "Content-Security-Policy": APP_CSP, ...extra });
}

export function text(body: string, status: number): Response {
  return withHeaders(new Response(body, { status }), { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
}

const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  wrong_password: 401,
  forbidden: 403,
  bad_origin: 403,
  invite_invalid: 403,
  not_found: 404,
  username_taken: 409,
  chat_full: 409,
  too_large: 413,
  too_short: 400,
  blocked: 403,
  reset_invalid: 403,
  rate_limited: 429,
};

export function error(code: ErrorCode): Response {
  return json({ error: code }, ERROR_STATUS[code]);
}

/** The request body as an object, or null if it is not JSON or too big. */
export async function readJson(req: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown> | null> {
  const length = Number(req.headers.get("Content-Length") ?? 0);
  if (length > maxBytes) return null;
  try {
    const raw = await req.text();
    if (raw.length > maxBytes) return null;
    const body: unknown = JSON.parse(raw);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Counts events per key in a sliding window; `hit` is false once a key is over the limit. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string, now: number): boolean {
    if (!this.allowed(key, now)) return false;
    this.record(key, now);
    return true;
  }

  /** Under the limit, without counting this check. */
  allowed(key: string, now: number): boolean {
    this.sweep(now);
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    this.hits.set(key, recent);
    return recent.length < this.limit;
  }

  record(key: string, now: number): void {
    const recent = this.hits.get(key) ?? [];
    recent.push(now);
    this.hits.set(key, recent);
  }

  private sweep(now: number) {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, times] of this.hits) if (times.every((t) => t <= now - this.windowMs)) this.hits.delete(key);
  }
}
