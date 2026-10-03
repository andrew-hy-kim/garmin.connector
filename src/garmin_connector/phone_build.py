"""Build the phone app (a home-screen web app) into ``docs/`` for GitHub Pages.

    python -m garmin_connector.phone_build            # writes ./docs
    python -m garmin_connector.phone_build some/dir   # or somewhere else

The phone app is the same dashboard pages, served as plain files: links become
``activity.html?id=...`` instead of server routes, ``phone.js`` answers the data
requests from the file imported on the phone, and a service worker caches the
app so it opens offline. The output contains code only, never your data.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

STATIC = Path(__file__).parent / "static"
PHONE = STATIC / "phone"

PAGES = ["index.html", "activity.html", "plan.html"]
ASSETS = ["app.css", "common.js", "overview.js", "activity.js", "plan.js",
          "chart.umd.min.js", "leaflet.js", "leaflet.css"]
PHONE_ASSETS = ["phone.js", "icon-180.png", "icon-192.png", "icon-512.png"]

HEAD_EXTRA = """<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Running">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
"""

MANIFEST = {
    "name": "Running Dashboard",
    "short_name": "Running",
    "description": "Your Garmin running data and analysis, offline on your phone.",
    "start_url": "./index.html",
    "scope": "./",
    "display": "standalone",
    "background_color": "#f2f2f7",
    "theme_color": "#2a78d6",
    "icons": [
        {"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"},
    ],
}

SERVICE_WORKER = """// Caches the app itself so it opens without a connection. Your data is in IndexedDB, not here.
const CACHE = "running-dashboard-__VERSION__";
const FILES = __FILES__;

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
"""


def phone_page(html: str) -> str:
    """Turn a server page into its phone-app version."""
    html = html.replace('href="/static/', 'href="').replace('src="/static/', 'src="')
    html = html.replace('href="/plan"', 'href="plan.html"').replace('href="/"', 'href="index.html"')
    html = html.replace("</head>", HEAD_EXTRA + "</head>", 1)
    marker = '<script src="common.js"></script>'
    if marker not in html:
        raise ValueError("page has no common.js script tag")
    return html.replace(marker, '<script src="phone.js"></script>\n' + marker, 1)


def build(out: Path | str = "docs") -> Path:
    out = Path(out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    files: dict[str, bytes] = {}
    for page in PAGES:
        files[page] = phone_page((STATIC / page).read_text()).encode()
    for name in ASSETS:
        files[name] = (STATIC / name).read_bytes()
    for name in PHONE_ASSETS:
        files[name] = (PHONE / name).read_bytes()
    files["manifest.webmanifest"] = (json.dumps(MANIFEST, indent=2) + "\n").encode()

    version = hashlib.sha256(b"".join(files[k] for k in sorted(files))).hexdigest()[:12]
    cached = ["./"] + sorted(files)
    files["sw.js"] = (SERVICE_WORKER.replace("__VERSION__", version)
                      .replace("__FILES__", json.dumps(cached))).encode()
    files[".nojekyll"] = b""  # serve files as-is on GitHub Pages
    for name, data in files.items():
        (out / name).write_bytes(data)
    return out


if __name__ == "__main__":
    print(build(sys.argv[1] if len(sys.argv) > 1 else "docs"))
