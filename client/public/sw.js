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

// Web Push. The server sends who wrote and in which chat, never the text, so
// the words are made here in the language the person chose. Browsers insist
// that every push shows a notification. One notification per chat: a newer
// message replaces the older one instead of piling up.
//
// A ringing call has its own notification, which stays until it is tapped or
// replaced: when the call is over, the push with its record takes its place
// (loudly for a missed call, quietly otherwise).
const PUSH_TEXT = {
  en: { text: "New message", image: "Photo", file: "File", voice: "Voice message", ring: "Incoming call", ringVideo: "Incoming video call", missed: "Missed call", ended: "Call ended" },
  ru: { text: "Новое сообщение", image: "Фото", file: "Файл", voice: "Голосовое сообщение", ring: "Входящий звонок", ringVideo: "Входящий видеозвонок", missed: "Пропущенный звонок", ended: "Звонок завершён" },
  uk: { text: "Нове повідомлення", image: "Фото", file: "Файл", voice: "Голосове повідомлення", ring: "Вхідний дзвінок", ringVideo: "Вхідний відеодзвінок", missed: "Пропущений дзвінок", ended: "Дзвінок завершено" },
};

function callNotification(p, words) {
  const icon = p.icon || "/icons/icon-192.png";
  const tag = `call-${p.chat}`;
  if (p.ringing) {
    return {
      title: p.from,
      options: { body: p.ringing.video ? words.ringVideo : words.ring, tag, renotify: true, requireInteraction: true, vibrate: [400, 200, 400, 200, 400], icon, data: { chat: p.chat } },
    };
  }
  const missed = p.call && (p.call.outcome === "missed" || p.call.outcome === "busy");
  return { title: p.from, options: { body: missed ? words.missed : words.ended, tag, renotify: missed, silent: !missed, icon, data: { chat: p.chat } } };
}

self.addEventListener("push", (event) => {
  let p;
  try {
    p = event.data.json();
  } catch {
    return;
  }
  const words = PUSH_TEXT[p.lang] ?? PUSH_TEXT.en;
  if (p.kind === "call") {
    const n = callNotification(p, words);
    return event.waitUntil(self.registration.showNotification(n.title, n.options));
  }
  const what = words[p.kind] ?? words.text;
  const title = p.chat_title ?? p.from;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: p.chat_title ? `${p.from}: ${what}` : what,
      tag: `chat-${p.chat}`,
      renotify: true,
      icon: p.icon || "/icons/icon-192.png",
      data: { chat: p.chat },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = `/chat/${event.notification.data?.chat ?? ""}`;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(path);
      // The open app moves to the chat itself, without a reload.
      open.postMessage({ t: "open", path });
      return open.focus();
    }),
  );
});
