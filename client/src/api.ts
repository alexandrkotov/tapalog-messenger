import type { ErrorCode } from "@tapalog-messenger/shared";

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode | "network",
    public readonly status: number,
  ) {
    super(code);
  }
}

/** JSON call to /api; throws ApiError with the server's error code, or "network" when it cannot be reached. */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("network", 0);
  }
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new ApiError(((data as { error?: ErrorCode } | null)?.error ?? "bad_request") as ErrorCode, res.status);
  return data as T;
}

/** A readable name for this browser in the device list, like "Chrome on Windows". */
export function deviceName(ua = navigator.userAgent): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}
