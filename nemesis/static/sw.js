/* Nemesis service worker — offline-friendly app shell.
 *  - App shell (HTML, CSS, JS, icons, manifest): cache-first, refreshed in background.
 *  - /api/*, /health, /admin: network-only, never cached (per-user, streamed).
 *  - Cross-origin (fonts, Three.js CDN): stale-while-revalidate.
 *  - Navigations fall back to the cached shell when offline. */
const VERSION = "nemesis-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const SHELL = ["/", "/static/style.css", "/static/script.js", "/static/reactor.js",
  "/static/icons/icon.svg", "/static/icons/icon-192.png", "/static/icons/icon-512.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE)
    .then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(u))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("message", (event) => { if (event.data === "SKIP_WAITING") self.skipWaiting(); });

function isApi(url) {
  return url.origin === self.location.origin &&
    (url.pathname.startsWith("/api/") || url.pathname === "/health" || url.pathname.startsWith("/admin"));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (isApi(url)) return;

  if (req.mode === "navigate") {
    event.respondWith(fetch(req).then((res) => {
      caches.open(SHELL_CACHE).then((c) => c.put("/", res.clone())).catch(() => {});
      return res;
    }).catch(() => caches.match("/")));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) caches.open(SHELL_CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
        return res;
      }).catch(() => cached);
      return cached || network;
    }));
    return;
  }

  event.respondWith(caches.open(RUNTIME_CACHE).then(async (cache) => {
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});
