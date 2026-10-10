// Caches the app itself so it opens without a connection. Your data is in IndexedDB, not here.
const CACHE = "running-dashboard-0b84aea5083a";
const FILES = ["./", "activities.html", "activity.html", "activity.js", "app.css", "chart.umd.min.js", "common.js", "icon-180.png", "icon-192.png", "icon-512.png", "index.html", "leaflet.css", "leaflet.js", "manifest.webmanifest", "map.html", "map.js", "overview.js", "phone.js", "progress.html"];

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
  // only the app's own files: anything else (your data, for one) always comes from the network
  const name = url.pathname.slice(new URL(self.registration.scope).pathname.length) || "./";
  if (!FILES.includes(name)) return;
  // From the cache first, so switching tabs is instant whatever the signal. Every file of this
  // version was cached at install, and a new version of the app comes with a new sw.js (the
  // cache name changes), which the browser picks up and installs in the background.
  event.respondWith(caches.match(name, { ignoreSearch: true }).then((hit) => hit || fetch(event.request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    }
    return res;
  })));
});
