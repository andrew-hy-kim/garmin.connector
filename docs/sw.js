// Caches the app itself so it opens without a connection. Your data is in IndexedDB, not here.
const CACHE = "running-dashboard-4c52ff21022b";
const FILES = ["./", "activity.html", "activity.js", "app.css", "chart.umd.min.js", "common.js", "icon-180.png", "icon-192.png", "icon-512.png", "index.html", "leaflet.css", "leaflet.js", "manifest.webmanifest", "overview.js", "phone.js", "plan.html", "plan.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return; // e.g. map tiles
  // Network first, so updates arrive when online; the cache when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
