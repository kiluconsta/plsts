/* Offline shell only — the ~50KB of HTML/CSS/JS that makes the player
   boot. Video and playlists are never cached: they're hundreds of
   megabytes on someone else's CDN, and the playlists get rewritten by
   the weekly prune, so a stale copy would be worse than no copy.
   
   Network-first, cache-as-fallback: a fresh deploy always wins, and the
   cache is only reached for when the network isn't there. */
const CACHE = "plsts-shell-v1";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./manifest.json",
  "./favicon.svg",
  "./favicon-32.png",
  "./favicon.ico",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.includes("/playlists/")) return;      // always live

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match("./index.html")))
  );
});
