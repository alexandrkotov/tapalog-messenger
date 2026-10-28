// App-shell service worker. The build (scripts/gen-client-assets.ts) replaces
// the placeholder below with this build's file list and a version hash, so
// every new build is a byte-different sw.js and browsers install it.
const PRECACHE = __PRECACHE__;
const CACHE = `shell-${PRECACHE.version}`;

// Server routes are always live; never answer them from the cache.
const LIVE = ["/healthz", "/status", "/shutdown", "/api/", "/ws", "/media/"];

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
  if (req.method !== "GET" || url.origin !== self.location.origin || LIVE.some((p) => url.pathname.startsWith(p))) return;
  // Any page navigation gets the shell; the client decides what to show.
  const key = req.mode === "navigate" ? "/" : req;
  event.respondWith(caches.match(key, { ignoreSearch: req.mode === "navigate" }).then((hit) => hit ?? fetch(req)));
});
