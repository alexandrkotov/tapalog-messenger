import type { webcrypto } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Web Push without a library: a VAPID signature (RFC 8292) so push services
 * know the sender, and the payload encrypted for the browser (RFC 8291,
 * aes128gcm). Everything is WebCrypto, built into Bun. The keys live in
 * messenger-data/vapid.json; changing them invalidates every subscription,
 * so they are made once and kept.
 */

export const VAPID_FILE = "vapid.json";

export interface Vapid {
  /** Uncompressed P-256 point, base64url: what browsers take as applicationServerKey. */
  publicKey: string;
  privateKey: CryptoKey;
}

const b64u = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
const fromB64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const utf8 = (s: string) => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The server's key pair: read from the data folder, or made and written there on first start. */
export async function loadOrCreateVapid(dataDir: string): Promise<Vapid> {
  const path = join(dataDir, VAPID_FILE);
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf-8")) as { publicKey: string; privateKey: webcrypto.JsonWebKey };
    const privateKey = await crypto.subtle.importKey("jwk", saved.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    return { publicKey: saved.publicKey, privateKey };
  }
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = b64u(await crypto.subtle.exportKey("raw", pair.publicKey));
  writeFileSync(path, JSON.stringify({ publicKey, privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey) }, null, 2));
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows: the file inherits the folder's permissions.
  }
  return { publicKey, privateKey: pair.privateKey };
}

/** `Authorization: vapid t=<JWT>, k=<public key>`: a 12-hour ES256 token for the push service's origin. */
export async function vapidAuthorization(endpoint: string, vapid: Vapid, subject: string, now: number): Promise<string> {
  const header = b64u(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(utf8(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  // WebCrypto signs ECDSA as r‖s, exactly the form a JWT carries.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapid.privateKey, utf8(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array | ArrayBuffer, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/**
 * Encrypts a payload for one browser subscription (RFC 8291 with RFC 8188's
 * aes128gcm, one record). `fixed` pins the random parts, for tests only.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  subscription: { p256dh: string; auth: string },
  fixed?: { serverKeys: CryptoKeyPair; salt: Uint8Array },
): Promise<Uint8Array> {
  const uaPublic = fromB64u(subscription.p256dh);
  const authSecret = fromB64u(subscription.auth);
  const serverKeys = fixed?.serverKeys ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, serverKeys.privateKey, 256);

  const ikm = await hkdf(authSecret, ecdhSecret, concat(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 marks the last (here, only) record.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/**
 * Push services the server will send to. A subscription's address comes
 * from the browser, so without this list anyone signed in could make the
 * server send requests into its own network. Chrome, Edge, Firefox, Safari
 * and the browsers built on them use these.
 */
const PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com", "web.push.apple.com"];
const PUSH_HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com"];

export function isPushServiceUrl(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.port === "" && (PUSH_HOSTS.includes(url.hostname) || PUSH_HOST_SUFFIXES.some((s) => url.hostname.endsWith(s)));
}

export type PushResult = "sent" | "gone" | "failed";

/** Sends one notification. "gone" means the browser dropped the subscription and it should be forgotten. */
export async function sendPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: unknown,
  opts: { vapid: Vapid; subject: string; now: number; fetch?: typeof fetch; ttl?: number },
): Promise<PushResult> {
  try {
    const body = await encryptPayload(utf8(JSON.stringify(payload)), subscription);
    const res = await (opts.fetch ?? fetch)(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(subscription.endpoint, opts.vapid, opts.subject, opts.now),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        // Keep trying for a day while the phone is off; then it is old news (a ringing call sooner).
        TTL: String(opts.ttl ?? 24 * 3600),
        Urgency: "high",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
