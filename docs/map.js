// Map page: a heatmap of everywhere you've run (or every route, colored by workout type),
// with filters, "runs through here" on click, and your most-run places.

const WORKOUTS = [
  ["all", "All workouts", null],
  ["easy", "Easy & recovery", ["easy", "recovery", "easy_strides"]],
  ["long", "Long runs", ["long"]],
  ["quality", "Hard sessions", [...QUALITY]],
  ["race", "Races", ["race"]],
];
const M = { acts: new Map(), tracks: [], shown: [], map: null, mode: "heat", heat: null, routes: null, fitted: false };

// ---------- filters ----------
function selected() {
  const when = $("m-when").value, type = $("m-type").value, workout = $("m-workout").value, minM = Number($("m-dist").value);
  const now = new Date();
  let from = null, to = null;
  if (/^\d+$/.test(when)) { from = new Date(); from.setDate(from.getDate() - Number(when)); }
  else if (when === "year") from = new Date(now.getFullYear(), 0, 1);
  else if (when === "lastyear") { from = new Date(now.getFullYear() - 1, 0, 1); to = new Date(now.getFullYear(), 0, 1); }
  const kinds = (WORKOUTS.find(([k]) => k === workout) || WORKOUTS[0])[2];
  return M.tracks.filter((t) => {
    const a = M.acts.get(t.id);
    if (!a) return false;
    const d = localDate(a.start_time_local);
    return (!from || d >= from) && (!to || d < to)
      && (type === "all" ? true : type === "run" ? isRun(a.activity_type) : a.activity_type === type)
      && (!kinds || kinds.includes(a.workout_type)) && (a.distance_m || 0) >= minM;
  });
}

function bboxOf(list) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const t of list) { s = Math.min(s, t.bb[0]); w = Math.min(w, t.bb[1]); n = Math.max(n, t.bb[2]); e = Math.max(e, t.bb[3]); }
  return L.latLngBounds([s, w], [n, e]);
}

// ---------- heat layer: tracks drawn with low opacity, so overlaps add up, then colored by density ----------
const RAMP = (() => {
  const stops = [[0, [40, 110, 255, 0]], [0.06, [60, 130, 255, 150]], [0.3, [120, 90, 255, 210]], [0.55, [255, 90, 60, 235]],
    [0.8, [255, 190, 40, 250]], [1, [255, 250, 220, 255]]];
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let k = 0; while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
    const [v0, c0] = stops[k], [v1, c1] = stops[k + 1];
    const f = Math.min(1, Math.max(0, (v - v0) / (v1 - v0)));
    for (let j = 0; j < 4; j++) lut[i * 4 + j] = c0[j] + (c1[j] - c0[j]) * f;
  }
  return lut;
})();

// Web Mercator in world units (0..1): projected once per track, so a redraw is plain arithmetic
function mercator(track) {
  const xy = new Float64Array(track.length * 2);
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  track.forEach(([la, lo], i) => {
    const x = (lo + 180) / 360;
    const s = Math.sin(Math.max(-85, Math.min(85, la)) * Math.PI / 180);
    const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    xy[2 * i] = x; xy[2 * i + 1] = y;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  });
  return { xy, box: [x0, y0, x1, y1] };
}

// The heat canvas lives in a map pane, so panning moves it for free. When a pan or zoom ends it's
// redrawn on a second canvas a slice at a time (a few milliseconds per frame, so the map never
// stalls), then swapped in; during the zoom animation the current image is scaled along.
const HEAT_PAD = 0.35; // drawn this far beyond each edge, so a pan doesn't show blank margins
const SLICE_MS = 8;
const BAND = 96; // rows recolored per step
const HeatLayer = L.Layer.extend({
  onAdd(map) {
    this._heatCanvas = L.DomUtil.create("canvas", "heat-canvas leaflet-zoom-animated");
    this._heatBuffer = document.createElement("canvas");
    map.getPane("overlayPane").appendChild(this._heatCanvas);
    map.on("moveend resize", this.redraw, this);
    map.on("zoomanim", this._heatZoomAnim, this);
    this.redraw();
  },
  onRemove(map) {
    this._heatJob = null;
    this._heatCanvas.remove();
    map.off("moveend resize", this.redraw, this);
    map.off("zoomanim", this._heatZoomAnim, this);
  },
  _heatZoomAnim(e) {
    if (!this._heatBounds) return;
    const scale = this._map.getZoomScale(e.zoom);
    const offset = this._map._latLngBoundsToNewLayerBounds(this._heatBounds, e.zoom, e.center).min;
    L.DomUtil.setTransform(this._heatCanvas, offset, scale);
  },
  redraw() {
    const map = this._map;
    if (!map) return;
    const size = map.getSize();
    const padX = Math.round(size.x * HEAT_PAD), padY = Math.round(size.y * HEAT_PAD);
    const w = size.x + 2 * padX, h = size.y + 2 * padY;
    const topLeft = map.containerPointToLayerPoint([-padX, -padY]);
    const bounds = L.latLngBounds(map.layerPointToLatLng(topLeft), map.layerPointToLatLng(topLeft.add([w, h])));
    const job = this._heatJob = heatJob(this._heatBuffer, map, w, h, topLeft);
    const step = () => {
      if (this._heatJob !== job) return; // superseded by a newer pan or zoom
      if (!job.next(performance.now() + SLICE_MS)) { requestAnimationFrame(step); return; }
      // done: show it where it was drawn
      const c = this._heatCanvas;
      if (c.width !== this._heatBuffer.width || c.height !== this._heatBuffer.height) {
        c.width = this._heatBuffer.width; c.height = this._heatBuffer.height;
      }
      c.style.width = `${w}px`; c.style.height = `${h}px`;
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(this._heatBuffer, 0, 0);
      this._heatBounds = bounds;
      L.DomUtil.setPosition(c, topLeft);
      this._heatJob = null;
    };
    step();
  },
});

// 32-bit pixel colors by how opaque the strokes made a pixel (little-endian RGBA)
const RAMP32 = (() => {
  const out = new Uint32Array(256);
  for (let a = 1; a < 256; a++) {
    const j = a * 4;
    out[a] = (Math.max(RAMP[j + 3], 90) << 24 | RAMP[j + 2] << 16 | RAMP[j + 1] << 8 | RAMP[j]) >>> 0;
  }
  return out;
})();

// Draws the heat into `canvas` in pieces: next(deadline) works until the deadline and returns true when done.
function heatJob(canvas, map, w, h, topLeft) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const zoom = map.getZoom(), scale = 256 * 2 ** zoom;
  const origin = map.getPixelOrigin().add(topLeft); // world pixel at the canvas's top left
  const ox = origin.x, oy = origin.y;
  ctx.lineWidth = zoom >= 16 ? 3.5 : zoom >= 14 ? 2.5 : zoom >= 12 ? 1.8 : 1.3;
  ctx.lineJoin = ctx.lineCap = "round";
  // each run adds a little opacity; the more runs share a street, the hotter it gets
  const n = M.shown.length;
  ctx.strokeStyle = `rgba(0,0,0,${n > 400 ? 0.12 : n > 100 ? 0.18 : 0.28})`;
  const list = M.shown.filter((t) => {
    const [x0, y0, x1, y1] = t.m.box;
    return !(x1 * scale < ox || x0 * scale > ox + w || y1 * scale < oy || y0 * scale > oy + h);
  });
  const rows = canvas.height, cols = canvas.width;
  let k = 0, row = 0;
  return {
    next(deadline) {
      while (k < list.length) {
        const xy = list[k++].m.xy;
        ctx.beginPath();
        let lx = xy[0] * scale - ox, ly = xy[1] * scale - oy;
        ctx.moveTo(lx, ly);
        for (let i = 2; i < xy.length; i += 2) {
          const x = xy[i] * scale - ox, y = xy[i + 1] * scale - oy;
          // skip points within a pixel of the last one: invisible, and most of the work when zoomed out
          if (i < xy.length - 2 && Math.abs(x - lx) < 1 && Math.abs(y - ly) < 1) continue;
          ctx.lineTo(x, y); lx = x; ly = y;
        }
        ctx.stroke();
        ctx.getImageData(0, 0, 1, 1); // the browser draws lazily; this makes it draw now, inside this slice
        if (performance.now() > deadline) return false;
      }
      // color by how opaque each pixel became, a band of rows at a time
      while (row < rows) {
        const band = Math.min(BAND, rows - row);
        const img = ctx.getImageData(0, row, cols, band), px32 = new Uint32Array(img.data.buffer);
        for (let i = 0; i < px32.length; i++) {
          const a = px32[i] >>> 24;
          if (a) px32[i] = RAMP32[a];
        }
        ctx.putImageData(img, 0, row);
        row += band;
        if (row < rows && performance.now() > deadline) return false;
      }
      return true;
    },
  };
}

const redrawSoon = () => M.heat?.redraw();

// ---------- routes layer: every run as its own line, colored by workout type ----------
function drawRoutes() {
  if (M.routes) { M.map.removeLayer(M.routes); M.routes = null; }
  if (M.mode !== "routes") return;
  const renderer = L.canvas({ padding: 0.3 });
  const group = L.featureGroup();
  // outlines first, all of them, so the colored lines sit on top and stand out from the map
  const casing = cssVar("--route-casing");
  for (const t of M.shown) L.polyline(t.track, { renderer, color: casing, weight: 5, opacity: 0.75, smoothFactor: 1.5, interactive: false }).addTo(group);
  for (const t of M.shown) {
    const a = M.acts.get(t.id);
    const z = TYPE_ZONE[a.workout_type] || 1;
    L.polyline(t.track, { renderer, color: cssVar(z === 1 ? "--map-z1" : `--z${z}`), weight: 2.5, opacity: 0.85, smoothFactor: 1.5 })
      .bindPopup(() => popupFor([a]))
      .addTo(group);
  }
  M.routes = group.addTo(M.map);
}

// ---------- "runs through here" ----------
function popupFor(list, total = list.length) {
  const u = Units.get();
  const rows = list.slice(0, 6).map((a) => `<li><a href="${pageUrl("activity", { id: a.activity_id })}">${esc(fmtDate(a.start_time_local, { month: "short", day: "numeric", year: "numeric" }))}</a>
      · ${esc(a.name || "")} · ${esc(fmtDist(a.distance_m, u, 1))}</li>`).join("");
  return `<div class="run-popup"><b>${total === 1 ? "1 run" : `${fmtNum(total)} runs`} through here</b><ul>${rows}</ul>${total > 6 ? `<span class="dim">and ${fmtNum(total - 6)} more</span>` : ""}</div>`;
}

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function runsNear(latlng) {
  const map = M.map, scale = 256 * 2 ** map.getZoom();
  const c = map.project(latlng, map.getZoom()), p = { x: c.x, y: c.y };
  const hits = [];
  for (const t of M.shown) {
    const [x0, y0, x1, y1] = t.m.box;
    if (x1 * scale < p.x - 12 || x0 * scale > p.x + 12 || y1 * scale < p.y - 12 || y0 * scale > p.y + 12) continue;
    const xy = t.m.xy;
    for (let i = 2; i < xy.length; i += 2) {
      const a = { x: xy[i - 2] * scale, y: xy[i - 1] * scale }, b = { x: xy[i] * scale, y: xy[i + 1] * scale };
      if (segDist(p, a, b) <= 10) { hits.push(M.acts.get(t.id)); break; }
    }
  }
  return hits.sort((a, b) => (a.start_time_local < b.start_time_local ? 1 : -1));
}

// ---------- places ----------
// A run without a place name (Apple Watch runs have none) takes the name of the nearest
// named run that started within 5 km, so it counts with the place you usually run.
const PLACE_KM = 5;
function placeOf(t) {
  if (t.place !== undefined) return t.place;
  const a = M.acts.get(t.id);
  if (a.location) return (t.place = a.location);
  if (!M.named) M.named = M.tracks.filter((x) => M.acts.get(x.id)?.location && x.track.length);
  const [lat, lon] = t.track[0] || [];
  let best = null, bestKm = PLACE_KM;
  for (const x of lat == null ? [] : M.named) {
    const [la, lo] = x.track[0];
    const km = 111.2 * Math.hypot(la - lat, (lo - lon) * Math.cos((lat * Math.PI) / 180));
    if (km < bestKm) { bestKm = km; best = M.acts.get(x.id).location; }
  }
  return (t.place = best || "Unnamed place");
}

function renderPlaces() {
  const byPlace = new Map();
  for (const t of M.shown) {
    const a = M.acts.get(t.id);
    const name = placeOf(t);
    const p = byPlace.get(name) || { name, runs: 0, meters: 0, last: "", tracks: [] };
    p.runs += 1; p.meters += a.distance_m || 0; p.tracks.push(t);
    if (a.start_time_local > p.last) p.last = a.start_time_local;
    byPlace.set(name, p);
  }
  const places = [...byPlace.values()].sort((a, b) => b.runs - a.runs);
  M.places = places;
  $("places-card").hidden = places.length < 1;
  const u = Units.get();
  const max = places[0]?.runs || 1;
  $("places").innerHTML = places.slice(0, 10).map((p, i) => `<button type="button" class="place" data-i="${i}">
      <span class="pl-name">${esc(p.name)}</span>
      <span class="pl-bar"><i style="width:${Math.max(3, (p.runs / max) * 100)}%"></i></span>
      <span class="pl-stats"><b>${fmtNum(p.runs)}</b> ${p.runs === 1 ? "run" : "runs"} · ${fmtNum(dist(p.meters, u), 0)} ${u} · last ${esc(fmtDate(p.last, { month: "short", day: "numeric", year: "numeric" }))}</span>
    </button>`).join("");
  return places;
}

$("places").addEventListener("click", (e) => {
  const b = e.target.closest(".place");
  if (!b) return;
  const p = M.places[Number(b.dataset.i)];
  M.map.fitBounds(bboxOf(p.tracks), { padding: [20, 20] });
  $("heatmap").scrollIntoView({ behavior: "smooth", block: "center" });
});

// ---------- update ----------
function update() {
  M.shown = selected();
  const meters = M.shown.reduce((t, x) => t + (M.acts.get(x.id).distance_m || 0), 0);
  const u = Units.get();
  $("m-summary").textContent = M.shown.length
    ? `${fmtNum(M.shown.length)} ${M.shown.length === 1 ? "run" : "runs"} · ${fmtNum(dist(meters, u), 0)} ${u}` : "No runs with GPS match these filters.";
  $("m-hint").textContent = M.mode === "heat"
    ? `The brighter a street, the more often you've run it. ${act()} anywhere on the map to see the runs that went through.`
    : `Each run is a line, colored by workout type. ${act()} one to open it.`;
  $("map-key").hidden = M.mode !== "heat";
  $("route-key").hidden = M.mode !== "routes";
  const places = renderPlaces();
  if (!M.fitted && M.shown.length) {
    // start where you run most, not zoomed out to every trip you've ever taken
    M.map.fitBounds(bboxOf(places[0] ? places[0].tracks : M.shown), { padding: [20, 20] });
    M.fitted = true;
  }
  drawRoutes();
  redrawSoon();
}

function setupMap() {
  const map = M.map = L.map("heatmap", { zoomControl: true, preferCanvas: true, worldCopyJump: true });
  // In heat mode the map is dimmed by fading the tile layer over a dark background (see app.css):
  // one cheap layer, unlike a CSS filter on every tile, which made panning stutter
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
  map.setView([20, 0], 2);
  M.heat = new HeatLayer();
  map.on("click", (e) => {
    if (M.mode !== "heat") return;
    const hits = runsNear(e.latlng);
    if (hits.length) L.popup({ maxWidth: 320 }).setLatLng(e.latlng).setContent(popupFor(hits)).openOn(map);
  });
}

function setMode(mode) {
  M.mode = mode;
  M.map.closePopup();
  $("m-mode").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode));
  $("heatmap").classList.toggle("heat-mode", mode === "heat");
  if (mode === "heat") M.heat.addTo(M.map); else M.heat.remove();
  try { localStorage.setItem("mapMode", mode); } catch {}
  update();
}

async function load() {
  const [acts, got] = await Promise.all([getJSON("/api/activities"), getJSON("/api/heatmap")]);
  const oldFile = got == null; // phone: data imported before the map existed
  const tracks = got || [];
  for (const a of acts) M.acts.set(a.activity_id, a);
  M.tracks = tracks.map((t) => {
    let s = 90, w = 180, n = -90, e = -180;
    for (const [la, lo] of t.track) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
    return { ...t, bb: [s, w, n, e], m: mercator(t.track) };
  });
  const withTrack = new Set(M.tracks.map((t) => t.id));
  const types = [...new Set(acts.filter((a) => withTrack.has(a.activity_id)).map((a) => a.activity_type).filter((t) => t && !isRun(t)))].sort();
  $("m-type").innerHTML = `<option value="run">Runs</option><option value="all">All activities</option>` +
    types.map((t) => `<option value="${esc(t)}">${esc(prettyType(t))}</option>`).join("");
  $("m-workout").innerHTML = WORKOUTS.map(([k, label]) => `<option value="${k}">${label}</option>`).join("");
  document.body.classList.toggle("no-data", !M.tracks.length);
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  $("today").textContent = today;
  if (!M.tracks.length) {
    $("map-empty").hidden = false;
    if (oldFile) {
      $("map-empty").querySelector("h2").textContent = "Update your data for the map";
      $("map-empty-hint").textContent = "The data file on this phone is from before the map existed. Tap Update at the top and pick the latest file from your Mac to bring in your routes.";
    } else if (PHONE) $("map-empty-hint").textContent = "Sync on your Mac, then tap Update at the top and pick the latest file to bring in new routes.";
    ready();
    return;
  }
  setupMap();
  let mode = "heat";
  try { mode = localStorage.getItem("mapMode") || "heat"; } catch {}
  setMode(mode);
  ready();
  M.map.invalidateSize();
}

for (const id of ["m-when", "m-type", "m-workout", "m-dist"]) $(id).addEventListener("change", update);
$("m-mode").addEventListener("click", (e) => { if (e.target.dataset.mode) setMode(e.target.dataset.mode); });
unitsToggle($("units"), () => M.map && update());
$("sync")?.addEventListener("click", async () => {
  setStatus("Syncing with Garmin Connect…");
  try {
    await busy($("sync"), "Syncing…", () => getJSON("/api/sync", { method: "POST" }));
    location.reload();
  } catch (err) { setStatus(err.message, true); }
});
load().catch((err) => { ready(); setStatus(`Couldn't load the map: ${err.message}`, true); });
