import { api } from "./api";
import type { Lang } from "./i18n";

/**
 * Notifications while the app is closed (Web Push). The browser keeps a
 * subscription, an address at its push service; the server gets that
 * address and wakes this device through it. The service worker (public/sw.js)
 * shows the notification.
 */

export type PushState = "unsupported" | "needs-install" | "denied" | "off" | "on";

/** iPhone and iPad allow push only to an app added to the Home Screen. */
function iosBrowserTab(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && !matchMedia("(display-mode: standalone)").matches && !(navigator as { standalone?: boolean }).standalone;
}

/**
 * This browser's subscription. Without permission there cannot be one, so
 * the push service is not asked (in some WebKit builds asking then hangs).
 */
async function current(): Promise<PushSubscription | null> {
  if (!("Notification" in window) || Notification.permission !== "granted") return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return iosBrowserTab() ? "needs-install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  return (await current()) ? "on" : "off";
}

function send(sub: PushSubscription, lang: Lang) {
  const { endpoint, keys } = sub.toJSON();
  return api("POST", "/push/subscribe", { endpoint, keys, lang });
}

/** Asks for permission (only ever from a tap) and hands the subscription to the server. */
export async function turnOn(lang: Lang): Promise<PushState> {
  if ((await Notification.requestPermission()) !== "granted") return pushState();
  const reg = await navigator.serviceWorker.ready;
  const { public_key } = await api<{ public_key: string }>("GET", "/push/key");
  const key = Uint8Array.from(atob(public_key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another server key cannot be reused.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await send(sub, lang);
  return "on";
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

export async function turnOff(): Promise<PushState> {
  const sub = await current();
  if (sub) {
    await api("DELETE", "/push/subscribe", { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
  return pushState();
}

/**
 * Tells the server again about this device's subscription, in the chosen
 * language. Browsers may change the address now and then; this runs on each
 * start and on a change of language, and does nothing when push is off.
 */
export async function resync(lang: Lang): Promise<void> {
  try {
    if ((await pushState()) !== "on") return;
    const sub = await current();
    if (sub) await send(sub, lang);
  } catch {
    // Next start will try again.
  }
}

/** Signing out: the server already dropped the subscription with the device; drop it here too. */
export async function forget(): Promise<void> {
  try {
    await (await current())?.unsubscribe();
  } catch {
    // Nothing to forget.
  }
}
