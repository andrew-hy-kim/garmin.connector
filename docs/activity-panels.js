// Workout detail: the synced second-by-second chart panels, hover and range selection.

// ---------------------------------------------------------------- panels

function panelDefs() {
  const u = Units.get();
  const defs = [
    { key: "hr", label: "Heart rate", unit: "bpm", color: "--hr", values: S.hr, zones: true, fmt: (v) => `${Math.round(v)}` },
    { key: "pace", label: "Pace", unit: `/${u}`, color: "--pace", values: S.pace, invert: true,
      second: { values: S.gapPace, color: "--gap", label: "GAP" }, fmt: (v) => fmtDuration(v) },
    { key: "cadence", label: "Cadence", unit: cadUnit(), color: "--cadence", values: S.cadence, fmt: (v) => `${Math.round(v)}` },
    { key: "altitude", label: "Elevation", unit: u === "mi" ? "ft" : "m", color: "--elev", values: S.altitude, fill: true, fmt: (v) => `${Math.round(v)}` },
  ];
  if (!usesPace()) {
    defs[1] = { key: "speed", label: "Speed", unit: u === "mi" ? "mph" : "km/h", color: "--pace",
      values: S.speed.map((v) => (v == null ? null : v * 3600 / M_PER[u])), fmt: (v) => v.toFixed(1) };
  }
  return defs.filter((d) => d.values.some((v) => v != null));
}

function buildPanels() {
  const box = $("panels");
  box.innerHTML = "";
  panels = panelDefs().map((def) => {
    const el = document.createElement("div");
    el.className = "panel";
    const legend = def.second
      ? `${def.label} <span style="color:var(${def.second.color})">— ${def.second.label}</span>` : def.label;
    el.innerHTML = `<span class="plabel" style="left:${PLOT.left}px">${legend} (${def.unit})</span><canvas></canvas>`;
    box.appendChild(el);
    return { def, el, canvas: el.querySelector("canvas") };
  });
  const axis = document.createElement("div");
  axis.className = "panel"; axis.style.height = "26px"; axis.style.borderTop = "0";
  axis.innerHTML = "<canvas></canvas>";
  box.appendChild(axis);
  const overlay = document.createElement("canvas");
  overlay.style.cssText = "position:absolute;inset:0;width:100%;height:100%;cursor:crosshair;touch-action:pan-y";
  overlay.setAttribute("aria-label", "Workout timeline; drag to select a range");
  box.appendChild(overlay);
  panels.axis = axis.querySelector("canvas");
  panels.overlay = overlay;
  attachPointer(overlay);
}

function sizeCanvas(c) {
  const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

const xDomain = () => [S.x[0], S.x[S.n - 1]];
function xToPx(x, w) { const [a, b] = xDomain(); return PLOT.left + ((x - a) / (b - a || 1)) * (w - PLOT.left - PLOT.right); }
function pxToX(px, w) { const [a, b] = xDomain(); return a + ((px - PLOT.left) / (w - PLOT.left - PLOT.right)) * (b - a); }

function yRange(values, invert) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  let lo = percentile(v, 0.01), hi = percentile(v, 0.99);
  if (invert) { lo = percentile(v, 0.02); hi = percentile(v, 0.98); }
  const pad = (hi - lo) * 0.1 || 5;
  return [lo - pad, hi + pad];
}

function niceTicks(lo, hi, count = 3) {
  const step0 = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || step0;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

function paceTicks(lo, hi) { // whole minutes (or 30 s steps on a narrow range)
  const step = [30, 60, 120, 300].find((s) => (hi - lo) / s <= 4) || 300;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

function lapBands() {
  // shade the hard reps of an interval workout
  if (!isIntervalWorkout()) return [];
  return D.laps.filter((l) => l.intensity === "active").map((l) => {
    const i0 = idxAtT(l.start_t), i1 = idxAtT(l.start_t + (l.elapsed_s || 0)) ;
    return [S.x[i0], S.x[Math.min(i1, S.n - 1)]];
  });
}

function drawPanel(p) {
  const { ctx, w, h } = sizeCanvas(p.canvas);
  const def = p.def;
  const [lo, hi] = yRange(def.values, def.invert);
  const y = (v) => {
    const f = (v - lo) / (hi - lo);
    return PLOT.top + (def.invert ? f : 1 - f) * (h - PLOT.top - PLOT.bottom);
  };
  p.y = y; p.range = [lo, hi];
  const right = w - PLOT.right, bottom = h - PLOT.bottom;

  // HR zone bands
  const zoneLabels = [];
  if (def.zones) {
    D.zones.forEach((z, i) => {
      const top = y(Math.min(z.high, hi)), bot = y(Math.max(z.low, lo));
      if (bot <= top) return;
      ctx.globalAlpha = 0.10;
      ctx.fillStyle = cssVar(`--z${i + 1}`);
      ctx.fillRect(PLOT.left, top, right - PLOT.left, bot - top);
      ctx.globalAlpha = 1;
      // zone name at the right edge when the band is tall enough (drawn over the line below)
      if (bot - top >= 13) zoneLabels.push([`Z${i + 1}`, cssVar(`--z${i + 1}`), (top + bot) / 2]);
    });
  }
  // interval reps
  ctx.fillStyle = cssVar("--surface-2");
  for (const [a, b] of lapBands()) ctx.fillRect(xToPx(a, w), PLOT.top, xToPx(b, w) - xToPx(a, w), bottom - PLOT.top);

  // grid + y labels
  ctx.font = "11px -apple-system, system-ui, sans-serif";
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  const ticks = def.key === "pace" ? paceTicks(lo, hi) : niceTicks(Math.min(lo, hi), Math.max(lo, hi));
  for (const v of ticks) {
    const yy = y(v);
    if (yy < PLOT.top + 4 || yy > bottom - 2) continue;
    ctx.strokeStyle = cssVar("--grid"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PLOT.left, yy); ctx.lineTo(right, yy); ctx.stroke();
    ctx.fillStyle = cssVar("--text-muted");
    ctx.fillText(def.fmt(v), PLOT.left - 6, yy);
  }

  const line = (values, color, dashed = false, fill = false) => {
    ctx.beginPath();
    let open = false, firstPx = null, lastPx = null;
    for (let i = 0; i < S.n; i++) {
      const v = values[i];
      const broken = v == null || (xMode === "time" && i && S.t[i] - S.t[i - 1] > PAUSE_GAP_S);
      if (v == null) { open = false; continue; }
      const px = xToPx(S.x[i], w), py = Math.max(PLOT.top, Math.min(bottom, y(v)));
      if (!open || broken) { ctx.moveTo(px, py); open = true; firstPx ??= px; } else ctx.lineTo(px, py);
      lastPx = px;
    }
    ctx.strokeStyle = cssVar(color); ctx.lineWidth = dashed ? 1.5 : 1.5;
    ctx.setLineDash(dashed ? [4, 3] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    if (fill && firstPx != null) {
      ctx.lineTo(lastPx, bottom); ctx.lineTo(firstPx, bottom); ctx.closePath();
      ctx.globalAlpha = 0.18; ctx.fillStyle = cssVar(color); ctx.fill(); ctx.globalAlpha = 1;
    }
  };
  if (def.second) line(def.second.values, def.second.color, true);
  line(def.values, def.color, false, def.fill);
  ctx.font = "700 10px -apple-system, system-ui, sans-serif";
  ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
  for (const [text, color, yy] of zoneLabels) {
    ctx.strokeStyle = cssVar("--surface-1"); ctx.lineWidth = 3; ctx.strokeText(text, right - 4, yy);
    ctx.fillStyle = color; ctx.fillText(text, right - 4, yy);
  }
}

function drawAxis() {
  const { ctx, w } = sizeCanvas(panels.axis);
  const [a, b] = xDomain();
  ctx.font = "11px -apple-system, system-ui, sans-serif";
  ctx.fillStyle = cssVar("--text-muted"); ctx.textAlign = "center"; ctx.textBaseline = "top";
  let ticks;
  if (xMode === "time") {
    const step = [60, 300, 600, 900, 1800, 3600, 7200].find((s) => (b - a) / s <= 8) || 7200;
    ticks = []; for (let v = 0; v <= b; v += step) ticks.push(v);
    ticks.forEach((v) => ctx.fillText(fmtDuration(v), xToPx(v, w), 6));
  } else {
    ticks = niceTicks(a, b, 6);
    ticks.forEach((v) => ctx.fillText(`${+v.toFixed(2)} ${Units.get()}`, xToPx(v, w), 6));
  }
}

function drawOverlay() {
  const { ctx, w, h } = sizeCanvas(panels.overlay);
  if (selection) {
    const [i0, i1] = selection;
    ctx.fillStyle = cssVar("--select");
    ctx.fillRect(xToPx(S.x[i0], w), 0, xToPx(S.x[i1], w) - xToPx(S.x[i0], w), h - 26);
  }
  if (hoverIdx != null) {
    const px = xToPx(S.x[hoverIdx], w);
    ctx.strokeStyle = cssVar("--text-secondary"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h - 26); ctx.stroke();
    for (const p of panels) {
      const v = p.def.values[hoverIdx];
      if (v == null) continue;
      const top = p.el.offsetTop;
      const py = top + Math.max(PLOT.top, Math.min(p.el.offsetHeight - PLOT.bottom, p.y(v)));
      ctx.beginPath(); ctx.arc(px, py, 4, 0, 2 * Math.PI);
      ctx.fillStyle = cssVar(p.def.color); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = cssVar("--surface-1"); ctx.stroke();
    }
  }
}

function renderReadout() {
  const i = hoverIdx;
  if (i == null) { $("readout").innerHTML = `<span class="idle">${matchMedia("(hover: hover)").matches ? "Hover to read every metric at that moment. Drag across a stretch, or click a lap or split, to analyze just that part." : "Tap to read every metric at that moment. Drag sideways, or tap a lap or split, to analyze just that part."}</span>`; return; }
  const raw = D.streams, u = Units.get();
  const parts = [
    ["Time", fmtDuration(S.t[i])],
    ["Distance", fmtDist(S.distance[i])],
    ["HR", S.hr[i] != null ? `${Math.round(S.hr[i])} bpm` : null],
    [usesPace() ? "Pace" : "Speed", fmtPaceOrSpeed(S.speed[i], D.activity.activity_type)],
    ["GAP", usesPace() && S.gap[i] ? fmtPace(S.gap[i]) : null],
    ["Cadence", S.cadence[i] != null ? `${Math.round(S.cadence[i])} ${cadUnit()}` : null],
    ["Elevation", S.altitude[i] != null ? `${Math.round(S.altitude[i])} ${u === "mi" ? "ft" : "m"}` : null],
    ["Grade", raw.grade[i] != null ? `${(raw.grade[i] * 100).toFixed(1)}%` : null],
  ];
  $("readout").innerHTML = parts.filter(([, v]) => v).map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join("");
}

// How a selected stretch compares with the whole workout: "(0:42 faster)", "(+12 bpm)"
let wholeRun = null;
function vsWhole(what, s) {
  if (!wholeRun) wholeRun = summarize(0, S.n - 1);
  const w = wholeRun;
  if (what === "hr") {
    if (!s.hr || !w.hr) return "";
    const d = Math.round(s.hr - w.hr);
    return Math.abs(d) < 1 ? "" : ` <span class="vs">${d > 0 ? "+" : "−"}${Math.abs(d)} vs run</span>`;
  }
  if (!s.speed || !w.speed) return "";
  if (usesPace()) {
    const d = Math.round(paceSeconds(s.speed) - paceSeconds(w.speed));
    return Math.abs(d) < 2 ? "" : ` <span class="vs">${fmtDuration(Math.abs(d))} ${d < 0 ? "faster" : "slower"}</span>`;
  }
  const d = (s.speed - w.speed) * 3600 / M_PER[Units.get()];
  return Math.abs(d) < 0.1 ? "" : ` <span class="vs">${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)} vs run</span>`;
}

function renderSelection() {
  const el = $("selection");
  if (!selection) { el.classList.remove("show"); el.innerHTML = ""; updateMapSelection(); return; }
  const [i0, i1] = selection, s = summarize(i0, i1), run = usesPace(), u = Units.get();
  const parts = [
    ["Selected", `${fmtDuration(S.t[i0])}–${fmtDuration(S.t[i1])}`],
    ["Time", fmtDuration(s.time)],
    ["Distance", fmtDist(s.meters)],
    [run ? "Avg pace" : "Avg speed", fmtPaceOrSpeed(s.speed, D.activity.activity_type) + vsWhole("pace", s)],
    ["GAP", run && s.gap ? fmtPace(s.gap) : null],
    ["Avg HR", s.hr ? `${Math.round(s.hr)} bpm${vsWhole("hr", s)}` : null],
    ["Max HR", s.hrMax ? `${Math.round(s.hrMax)}` : null],
    ["Cadence", s.cadence ? `${Math.round(s.cadence)} ${cadUnit()}` : null],
    ["Elev.", `+${Math.round(s.up)} / −${Math.round(s.down)} ${u === "mi" ? "ft" : "m"}`],
  ];
  el.innerHTML = parts.filter(([, v]) => v).map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join("") +
    `<button id="clear-sel" style="margin-left:auto">Clear</button>`;
  el.classList.add("show");
  $("clear-sel").onclick = () => {
    selection = null; drawOverlay(); renderSelection();
    if (map && mapLayers.route) map.fitBounds(mapLayers.route.getBounds(), { padding: [12, 12] });
  };
  updateMapSelection();
}

function selectRange(i0, i1) {
  selection = [Math.max(0, Math.min(i0, i1)), Math.min(S.n - 1, Math.max(i0, i1))];
  drawOverlay(); renderSelection();
  // zoom the map to that stretch
  if (map && mapLayers.selection) map.fitBounds(mapLayers.selection.getBounds(), { padding: [30, 30], maxZoom: 17 });
  $("charts-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

function attachPointer(el) {
  let dragFrom = null, dragPx = null;
  const idxFromEvent = (e) => {
    const r = el.getBoundingClientRect();
    const px = Math.max(PLOT.left, Math.min(r.width - PLOT.right, e.clientX - r.left));
    return { idx: idxAtX(pxToX(px, r.width)), px };
  };
  const showAt = (idx) => { hoverIdx = idx; drawOverlay(); renderReadout(); updateMapMarker(); };
  el.addEventListener("pointerdown", (e) => {
    const { idx, px } = idxFromEvent(e);
    dragFrom = idx; dragPx = px;
    el.setPointerCapture(e.pointerId);
    showAt(idx); // a tap on a phone shows that moment's values
  });
  el.addEventListener("pointermove", (e) => {
    const { idx, px } = idxFromEvent(e);
    if (dragFrom != null && Math.abs(px - dragPx) > 4) selection = [Math.min(dragFrom, idx), Math.max(dragFrom, idx)];
    showAt(idx);
    if (dragFrom != null && selection) renderSelection();
  });
  el.addEventListener("pointerup", (e) => {
    const { px } = idxFromEvent(e);
    if (dragFrom != null && Math.abs(px - dragPx) <= 4) { selection = null; }
    dragFrom = null;
    drawOverlay(); renderSelection();
  });
  // The page scrolled instead (vertical swipe on a phone): drop the half-started drag.
  el.addEventListener("pointercancel", () => { dragFrom = null; });
  el.addEventListener("pointerleave", (e) => {
    // With a finger there's no hover, so keep the last tapped point's values on screen.
    if (dragFrom != null || e.pointerType !== "mouse") return;
    showAt(null);
  });
}

function drawAll() {
  if (!S) return;
  panels.forEach(drawPanel); drawAxis(); drawOverlay(); renderReadout();
}
