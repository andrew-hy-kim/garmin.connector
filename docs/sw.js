// Caches the app itself so it opens without a connection. Your data is in IndexedDB, not here.
const CACHE = "running-dashboard-1fad940bd488";
const FILES = ["./", "activities.html", "activity.html", "activity.js", "app.css", "chart.umd.min.js", "common.js", "icon-180.png", "icon-192.png", "icon-512.png", "index.html", "leaflet.css", "leaflet.js", "manifest.webmanifest", "map.html", "map.js", "overview.js", "phone.js", "plan.html", "plan.js", "progress.html"];

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
  // Network first, so updates arrive when online; the cache when offline. On a weak signal the
  // network can hang for a long time, so after a few seconds the cached copy is used instead
  // (the download carries on and refreshes the cache for next time).
  const network = fetch(event.request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    }
    return res;
  });
  const cached = () => caches.match(event.request, { ignoreSearch: true });
  const slow = new Promise((resolve) => setTimeout(resolve, 2000)).then(cached);
  event.respondWith(new Promise((resolve, reject) => {
    network.then(resolve, () => cached().then((hit) => (hit ? resolve(hit) : reject(new Error("offline")))));
    slow.then((hit) => { if (hit) resolve(hit); });
  }));
});
