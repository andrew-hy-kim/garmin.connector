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

function drawHeat() {
  const map = M.map, canvas = M.heat;
  if (!canvas || M.mode !== "heat") return;
  const size = map.getSize(), dpr = window.devicePixelRatio || 1;
  canvas.width = size.x * dpr; canvas.height = size.y * dpr;
  canvas.style.width = `${size.x}px`; canvas.style.height = `${size.y}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.x, size.y);
  const view = map.getBounds().pad(0.1);
  const zoom = map.getZoom();
  ctx.lineWidth = zoom >= 16 ? 3.5 : zoom >= 14 ? 2.5 : zoom >= 12 ? 1.8 : 1.3;
  ctx.lineJoin = ctx.lineCap = "round";
  // each run adds a little opacity; the more runs share a street, the hotter it gets
  const n = M.shown.length;
  ctx.strokeStyle = `rgba(0,0,0,${n > 400 ? 0.12 : n > 100 ? 0.18 : 0.28})`;
  ctx.filter = "blur(0.8px)"; // soft edges, so a line's rim doesn't read as a quieter street
  for (const t of M.shown) {
    if (!view.intersects(L.latLngBounds([t.bb[0], t.bb[1]], [t.bb[2], t.bb[3]]))) continue;
    ctx.beginPath();
    t.track.forEach(([la, lo], i) => {
      const p = map.latLngToContainerPoint([la, lo]);
      if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    });
    ctx.stroke();
  }
  ctx.filter = "none";
  // color by how opaque each pixel became
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height), px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (!a) continue;
    const j = a * 4;
    px[i] = RAMP[j]; px[i + 1] = RAMP[j + 1]; px[i + 2] = RAMP[j + 2]; px[i + 3] = Math.max(RAMP[j + 3], 90);
  }
  ctx.putImageData(img, 0, 0);
}

let heatFrame = 0;
const redrawSoon = () => { cancelAnimationFrame(heatFrame); heatFrame = requestAnimationFrame(drawHeat); };

// ---------- routes layer: every run as its own line, colored by workout type ----------
function drawRoutes() {
  if (M.routes) { M.map.removeLayer(M.routes); M.routes = null; }
  if (M.mode !== "routes") return;
  const renderer = L.canvas({ padding: 0.3 });
  const group = L.featureGroup();
  for (const t of M.shown) {
    const a = M.acts.get(t.id);
    const z = TYPE_ZONE[a.workout_type] || 1;
    L.polyline(t.track, { renderer, color: cssVar(`--z${z}`), weight: 2.5, opacity: 0.7 })
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
  const map = M.map, p = map.latLngToContainerPoint(latlng);
  const near = L.latLngBounds(map.containerPointToLatLng([p.x - 12, p.y + 12]), map.containerPointToLatLng([p.x + 12, p.y - 12]));
  const hits = [];
  for (const t of M.shown) {
    if (!near.intersects(L.latLngBounds([t.bb[0], t.bb[1]], [t.bb[2], t.bb[3]]))) continue;
    let prev = null;
    for (const pt of t.track) {
      const q = map.latLngToContainerPoint(pt);
      if (prev && segDist(p, prev, q) <= 10) { hits.push(M.acts.get(t.id)); break; }
      prev = q;
    }
  }
  return hits.sort((a, b) => (a.start_time_local < b.start_time_local ? 1 : -1));
}

// ---------- places ----------
function renderPlaces() {
  const byPlace = new Map();
  for (const t of M.shown) {
    const a = M.acts.get(t.id);
    const name = a.location || "Unnamed place";
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
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
  map.setView([20, 0], 2);
  const canvas = M.heat = document.createElement("canvas");
  canvas.className = "heat-canvas";
  map.getContainer().appendChild(canvas);
  map.on("move resize", redrawSoon);
  map.on("zoomstart", () => { canvas.style.opacity = 0; });
  map.on("zoomend", () => { drawHeat(); canvas.style.opacity = 1; });
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
  M.heat.style.display = mode === "heat" ? "" : "none";
  try { localStorage.setItem("mapMode", mode); } catch {}
  update();
}

async function load() {
  const [acts, tracks] = await Promise.all([getJSON("/api/activities"), getJSON("/api/heatmap")]);
  for (const a of acts) M.acts.set(a.activity_id, a);
  M.tracks = tracks.map((t) => {
    let s = 90, w = 180, n = -90, e = -180;
    for (const [la, lo] of t.track) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
    return { ...t, bb: [s, w, n, e] };
  });
  const types = [...new Set(acts.filter((a) => M.tracks.some((t) => t.id === a.activity_id)).map((a) => a.activity_type).filter((t) => t && !isRun(t)))].sort();
  $("m-type").innerHTML = `<option value="run">Runs</option><option value="all">All activities</option>` +
    types.map((t) => `<option value="${esc(t)}">${esc(prettyType(t))}</option>`).join("");
  $("m-workout").innerHTML = WORKOUTS.map(([k, label]) => `<option value="${k}">${label}</option>`).join("");
  document.body.classList.toggle("no-data", !M.tracks.length);
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  $("today").textContent = today;
  if (!M.tracks.length) {
    $("m-hint").textContent = "Runs with GPS show up here after they sync.";
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
