// Minimal service worker: makes the PWA installable and serves the app shell offline.
// Never caches API/RPC/indexer responses (live prices must not be stale).
const CACHE = "meridian-shell-v1";
const SHELL = ["/", "/trade", "/positions", "/earn", "/fix", "/stats", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    // network first for pages, shell fallback offline
    event.respondWith(fetch(req).catch(() => caches.match(req).then((r) => r || caches.match("/trade"))));
    return;
  }
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; }),
      ),
    );
  }
});
