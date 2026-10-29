// App-shell service worker. The build (scripts/gen-client-assets.ts) replaces
// the placeholder below with this build's file list and a version hash, so
// every new build is a byte-different sw.js and browsers install it.
const PRECACHE = __PRECACHE__;
const CACHE = `shell-${PRECACHE.version}`;

// Server routes are always live; never answer them from the cache.
const LIVE = ["/healthz", "/status", "/shutdown", "/api/", "/ws", "/media/"];

// Photo previews are kept so chats look right without a network. The bytes
// behind an id never change, so a cached copy is always current. The oldest
// go once there are more than THUMB_LIMIT (a preview is tens of KB).
// Signing out deletes this cache.
const THUMBS = "thumbs";
const THUMB_LIMIT = 1000;
const THUMB_PATH = /^\/media\/[A-Za-z0-9_-]{22}\/thumb$/;

async function thumb(req) {
  const cache = await caches.open(THUMBS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - THUMB_LIMIT)).map((k) => cache.delete(k)));
  }
  return res;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.files))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("shell-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (THUMB_PATH.test(url.pathname)) return event.respondWith(thumb(req));
  if (LIVE.some((p) => url.pathname.startsWith(p))) return;
  // Any page navigation gets the shell; the client decides what to show.
  const key = req.mode === "navigate" ? "/" : req;
  event.respondWith(caches.match(key, { ignoreSearch: req.mode === "navigate" }).then((hit) => hit ?? fetch(req)));
});
