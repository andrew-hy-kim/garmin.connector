// Workout detail: synced second-by-second charts, range analysis, zones, laps, splits, map.

const activityId = Number(location.pathname.split("/").pop());
const PAUSE_GAP_S = 10;       // matches analysis.MAX_SAMPLE_GAP_S
const MOVING_MPS = 0.8;       // slower than this counts as stopped for pace
const PLOT = { left: 54, right: 12, top: 20, bottom: 6 };

let D = null;                 // API response
let S = null;                 // derived series
let xMode = "time";
let selection = null;         // [startIdx, endIdx]
let hoverIdx = null;
let panels = [];
let map = null, mapLayers = {};

// ---------------------------------------------------------------- series helpers

function rolling(values, window) {
  // centered rolling mean skipping nulls, O(n) via prefix sums
  const n = values.length, sum = new Float64Array(n + 1), cnt = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    sum[i + 1] = sum[i] + (v == null ? 0 : v);
    cnt[i + 1] = cnt[i] + (v == null ? 0 : 1);
  }
  const half = Math.floor(window / 2);
  return values.map((v, i) => {
    if (v == null) return null;
    const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
    const c = cnt[b] - cnt[a];
    return c ? (sum[b] - sum[a]) / c : null;
  });
}

function percentile(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]; }

function derive() {
  const s = D.streams, n = s.t.length, u = Units.get();
  const dt = s.t.map((t, i) => { const g = i ? t - s.t[i - 1] : 1; return g > 0 && g <= PAUSE_GAP_S ? g : 1; });
  // carry distance forward over gaps so the distance axis is continuous
  let lastD = 0;
  const distance = s.distance.map((d) => (lastD = d ?? lastD));
  const speed = rolling(s.speed, 15), gap = rolling(s.gap, 15);
  const toPace = (v) => (v != null && v >= MOVING_MPS ? M_PER[u] / v : null);
  S = {
    n, t: s.t, dt, distance,
    hr: rolling(s.hr, 3),
    speed, gap,
    pace: speed.map(toPace),
    gapPace: gap.map(toPace),
    cadence: rolling(s.cadence.map((c) => (c && c > 60 ? c : null)), 5),
    altitude: rolling(s.altitude, 9).map((a) => (a == null ? null : elevUnit(a, u))),
    grade: s.grade,
    lat: s.lat, lon: s.lon,
  };
  S.x = xMode === "distance" ? distance.map((d) => dist(d, u)) : s.t.map((t) => t);
}

function idxAtT(t) { // first sample at or after elapsed time t
  let lo = 0, hi = S.n - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (S.t[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
}

function idxAtX(x) {
  let lo = 0, hi = S.n - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (S.x[mid] < x) lo = mid + 1; else hi = mid; }
  if (lo > 0 && Math.abs(S.x[lo - 1] - x) < Math.abs(S.x[lo] - x)) lo--;
  return lo;
}

// Summary of samples i0..i1 (inclusive)
function summarize(i0, i1) {
  let time = 0, moving = 0, hrSum = 0, hrT = 0, hrMax = 0, cadSum = 0, cadT = 0, gapSum = 0, gapT = 0, up = 0, down = 0;
  const raw = D.streams;
  for (let i = i0 + 1; i <= i1; i++) {
    const dt = S.dt[i];
    time += dt;
    const isMoving = raw.speed[i] != null && raw.speed[i] >= MOVING_MPS;
    if (isMoving) moving += dt;
    if (S.hr[i] != null) { hrSum += S.hr[i] * dt; hrT += dt; hrMax = Math.max(hrMax, raw.hr[i] ?? 0); }
    if (isMoving && S.cadence[i] != null) { cadSum += S.cadence[i] * dt; cadT += dt; }
    if (isMoving && raw.gap[i] != null) { gapSum += raw.gap[i] * dt; gapT += dt; }
    const a0 = S.altitude[i - 1], a1 = S.altitude[i];
    if (a0 != null && a1 != null) { if (a1 > a0) up += a1 - a0; else down += a0 - a1; }
  }
  const meters = S.distance[i1] - S.distance[i0];
  return {
    time, moving, meters,
    speed: moving ? meters / moving : null,
    gap: gapT ? gapSum / gapT : null,
    hr: hrT ? hrSum / hrT : null, hrMax: hrMax || null,
    cadence: cadT ? cadSum / cadT : null,
    up, down,
  };
}

// ---------------------------------------------------------------- tiles & warnings

function renderHeader() {
  const a = D.activity;
  document.title = `${a.name || "Workout"} · Workout Detail`;
  $("title").textContent = a.name || "Workout";
  $("subtitle").textContent = [
    localDate(a.start_time_local).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }),
    prettyType(a.activity_type), a.location,
    D.streams ? (D.external_hr ? "HR: arm band / strap" : "HR: wrist") : null,
  ].filter(Boolean).join(" · ");
}

function renderTiles() {
  const a = D.activity, m = D.metrics || {};
  const whole = S ? summarize(0, S.n - 1) : null;
  const run = isRun(a.activity_type);
  const drift = m.decoupling_pct;
  const tiles = [
    ["Distance", fmtDist(a.distance_m), ""],
    ["Moving time", fmtDuration(whole ? whole.moving : a.moving_duration_s || a.duration_s), `Elapsed ${fmtDuration(whole ? whole.time : a.duration_s)}`],
    [run ? "Avg pace" : "Avg speed", fmtPaceOrSpeed(whole ? whole.speed : a.avg_speed_mps, a.activity_type),
      run && whole?.gap ? `GAP ${fmtPace(whole.gap)}` : ""],
    ["Avg heart rate", a.avg_hr ? `${Math.round(whole?.hr || a.avg_hr)} bpm` : "–", // cleaned stream max, so a one-second wrist spike doesn't show up as your max
      whole?.hrMax || a.max_hr ? `Max ${Math.round(whole?.hrMax || a.max_hr)}` : ""],
    ["Cadence", whole?.cadence ? `${Math.round(whole.cadence)} spm` : "–", ""],
    ["Elevation gain", fmtElev(a.elevation_gain_m) || "–", ""],
    ["Training load", m.trimp != null ? Math.round(m.trimp) : "–",
      a.aerobic_te ? `Aerobic TE ${a.aerobic_te.toFixed(1)} · Anaerobic ${a.anaerobic_te?.toFixed(1) ?? "–"}` : ""],
  ];
  if (drift != null) {
    tiles.push(["HR drift", `${drift.toFixed(1)}%`,
      drift < 5 ? "Steady; strong aerobic base" : drift < 8 ? "Some drift" : "High drift (heat, fatigue or too fast)"]);
  }
  if (m.efficiency) tiles.push(["Efficiency", `${m.efficiency.toFixed(2)} m/beat`, "Distance per heartbeat"]);
  $("tiles").innerHTML = tiles.map(([l, v, sub]) =>
    `<div class="tile"><div class="label">${l}</div><div class="value">${v || "–"}</div><div class="sub">${esc(sub)}</div></div>`).join("");
}

function isIntervalWorkout() {
  return D.laps.some((l) => ["rest", "recovery"].includes(l.intensity)) && D.laps.some((l) => l.intensity === "active");
}

function renderWarnings() {
  const notes = [];
  const m = D.metrics || {};
  if (!D.streams) {
    notes.push("There's no second-by-second data for this activity yet. Run a sync to download its workout file.");
  } else if (!D.external_hr) {
    if (m.cadence_lock > 0.15) {
      notes.push(`Heart rate matched your cadence for ${Math.round(m.cadence_lock * 100)}% of this run. The wrist sensor probably locked onto your arm swing, so heart-rate numbers for this run may be off.`);
    }
    if (isIntervalWorkout()) {
      notes.push("This was recorded with wrist heart rate. Wrist sensors lag behind quick changes in short reps, so wearing your arm band gives better rep-by-rep HR.");
    }
  }
  $("warnings").innerHTML = notes.map((n) => `<div class="warn">${esc(n)}</div>`).join("");
}

// ---------------------------------------------------------------- panels

function panelDefs() {
  const u = Units.get();
  const defs = [
    { key: "hr", label: "Heart rate", unit: "bpm", color: "--hr", values: S.hr, zones: true, fmt: (v) => `${Math.round(v)}` },
    { key: "pace", label: "Pace", unit: `/${u}`, color: "--pace", values: S.pace, invert: true,
      second: { values: S.gapPace, color: "--gap", label: "GAP" }, fmt: (v) => fmtDuration(v) },
    { key: "cadence", label: "Cadence", unit: "spm", color: "--cadence", values: S.cadence, fmt: (v) => `${Math.round(v)}` },
    { key: "altitude", label: "Elevation", unit: u === "mi" ? "ft" : "m", color: "--elev", values: S.altitude, fill: true, fmt: (v) => `${Math.round(v)}` },
  ];
  if (!isRun(D.activity.activity_type)) {
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
  if (def.zones) {
    D.zones.forEach((z, i) => {
      const top = y(Math.min(z.high, hi)), bot = y(Math.max(z.low, lo));
      if (bot <= top) return;
      ctx.globalAlpha = 0.10;
      ctx.fillStyle = cssVar(`--z${i + 1}`);
      ctx.fillRect(PLOT.left, top, right - PLOT.left, bot - top);
      ctx.globalAlpha = 1;
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
  if (i == null) { $("readout").innerHTML = `<span>Hover over the charts</span>`; return; }
  const raw = D.streams, u = Units.get();
  const parts = [
    ["Time", fmtDuration(S.t[i])],
    ["Distance", fmtDist(S.distance[i])],
    ["HR", S.hr[i] != null ? `${Math.round(S.hr[i])} bpm` : null],
    [isRun(D.activity.activity_type) ? "Pace" : "Speed", fmtPaceOrSpeed(S.speed[i], D.activity.activity_type)],
    ["GAP", isRun(D.activity.activity_type) && S.gap[i] ? fmtPace(S.gap[i]) : null],
    ["Cadence", S.cadence[i] != null ? `${Math.round(S.cadence[i])} spm` : null],
    ["Elevation", S.altitude[i] != null ? `${Math.round(S.altitude[i])} ${u === "mi" ? "ft" : "m"}` : null],
    ["Grade", raw.grade[i] != null ? `${(raw.grade[i] * 100).toFixed(1)}%` : null],
  ];
  $("readout").innerHTML = parts.filter(([, v]) => v).map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join("");
}

function renderSelection() {
  const el = $("selection");
  if (!selection) { el.classList.remove("show"); el.innerHTML = ""; updateMapSelection(); return; }
  const [i0, i1] = selection, s = summarize(i0, i1), run = isRun(D.activity.activity_type), u = Units.get();
  const parts = [
    ["Selected", `${fmtDuration(S.t[i0])}–${fmtDuration(S.t[i1])}`],
    ["Time", fmtDuration(s.time)],
    ["Distance", fmtDist(s.meters)],
    [run ? "Avg pace" : "Avg speed", fmtPaceOrSpeed(s.speed, D.activity.activity_type)],
    ["GAP", run && s.gap ? fmtPace(s.gap) : null],
    ["Avg HR", s.hr ? `${Math.round(s.hr)} bpm` : null],
    ["Max HR", s.hrMax ? `${Math.round(s.hrMax)}` : null],
    ["Cadence", s.cadence ? `${Math.round(s.cadence)} spm` : null],
    ["Elev.", `+${Math.round(s.up)} / −${Math.round(s.down)} ${u === "mi" ? "ft" : "m"}`],
  ];
  el.innerHTML = parts.filter(([, v]) => v).map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join("") +
    `<button id="clear-sel" style="margin-left:auto">Clear</button>`;
  el.classList.add("show");
  $("clear-sel").onclick = () => { selection = null; drawOverlay(); renderSelection(); };
  updateMapSelection();
}

function selectRange(i0, i1) {
  selection = [Math.max(0, Math.min(i0, i1)), Math.min(S.n - 1, Math.max(i0, i1))];
  drawOverlay(); renderSelection();
  $("charts-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

function attachPointer(el) {
  let dragFrom = null, dragPx = null;
  const idxFromEvent = (e) => {
    const r = el.getBoundingClientRect();
    const px = Math.max(PLOT.left, Math.min(r.width - PLOT.right, e.clientX - r.left));
    return { idx: idxAtX(pxToX(px, r.width)), px };
  };
  el.addEventListener("pointerdown", (e) => {
    const { idx, px } = idxFromEvent(e);
    dragFrom = idx; dragPx = px;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    const { idx, px } = idxFromEvent(e);
    hoverIdx = idx;
    if (dragFrom != null && Math.abs(px - dragPx) > 4) selection = [Math.min(dragFrom, idx), Math.max(dragFrom, idx)];
    drawOverlay(); renderReadout(); updateMapMarker();
    if (dragFrom != null && selection) renderSelection();
  });
  el.addEventListener("pointerup", (e) => {
    const { px } = idxFromEvent(e);
    if (dragFrom != null && Math.abs(px - dragPx) <= 4) { selection = null; }
    dragFrom = null;
    drawOverlay(); renderSelection();
  });
  el.addEventListener("pointerleave", () => {
    if (dragFrom != null) return;
    hoverIdx = null; drawOverlay(); renderReadout(); updateMapMarker();
  });
}

function drawAll() {
  if (!S) return;
  panels.forEach(drawPanel); drawAxis(); drawOverlay(); renderReadout();
}

// ---------------------------------------------------------------- zones, laps, splits, efforts

function renderZones() {
  const m = D.metrics;
  if (!m?.zone_seconds) { $("zones").innerHTML = `<p class="empty">No heart-rate data.</p>`; return; }
  $("zones").innerHTML = zoneRows(D.zones, m.zone_seconds);
  $("zones-hint").textContent = `Zones ${D.settings.lthr ? `from threshold HR ${Math.round(D.settings.lthr)}` : `from max HR ${Math.round(D.settings.max_hr)}`}. You can change these on the overview page.`;
}

function renderLaps() {
  const laps = D.laps;
  if (laps.length < 2) { $("laps-card").hidden = true; return; }
  $("laps-card").hidden = false;
  const interval = isIntervalWorkout();
  const reps = laps.filter((l) => l.intensity === "active" && l.distance_m && l.timer_s);
  if (interval && reps.length >= 2) {
    const paces = reps.map((l) => paceSeconds(l.distance_m / l.timer_s)).filter(Boolean);
    const mean = paces.reduce((a, b) => a + b, 0) / paces.length;
    const spread = Math.sqrt(paces.reduce((a, b) => a + (b - mean) ** 2, 0) / paces.length);
    const hrs = reps.map((l) => l.avg_hr).filter(Boolean);
    $("laps-hint").textContent = `${reps.length} work reps averaged ${fmtDuration(mean)} /${Units.get()}` +
      (hrs.length ? ` at ${Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length)} bpm` : "") +
      `, varying by ±${Math.round(spread)} s. Recovery laps are greyed out.`;
  } else {
    $("laps-hint").textContent = "Click a lap to analyze it on the timeline.";
  }
  $("laps").innerHTML = laps.map((l) => {
    const rest = ["rest", "recovery"].includes(l.intensity);
    return `<tr class="clickable ${rest ? "muted" : ""}" data-start="${l.start_t}" data-len="${l.elapsed_s || 0}">
      <td>${l.idx}</td><td>${esc(prettyType(l.intensity || "lap"))}</td>
      <td class="num">${fmtDuration(l.timer_s ?? l.elapsed_s)}</td>
      <td class="num">${fmtDist(l.distance_m)}</td>
      <td class="num">${l.avg_speed ? fmtPaceOrSpeed(l.avg_speed, D.activity.activity_type) : ""}</td>
      <td class="num">${l.avg_hr ? Math.round(l.avg_hr) : ""}</td>
      <td class="num">${l.max_hr ? Math.round(l.max_hr) : ""}</td>
      <td class="num">${l.avg_cadence ? Math.round(l.avg_cadence) : ""}</td></tr>`;
  }).join("");
}

function renderSplits() {
  const u = Units.get(), unit = M_PER[u];
  $("split-unit").textContent = u === "mi" ? "Mile" : "Km";
  $("splits-title").textContent = u === "mi" ? "Mile splits" : "Kilometer splits";
  if (!S) { $("splits").innerHTML = ""; return; }
  const bounds = [0];
  let next = unit;
  for (let i = 0; i < S.n; i++) if (S.distance[i] >= next) { bounds.push(i); next += unit; }
  if (S.distance[S.n - 1] - S.distance[bounds.at(-1)] > unit * 0.05) bounds.push(S.n - 1);
  const run = isRun(D.activity.activity_type);
  const rows = [];
  for (let k = 1; k < bounds.length; k++) {
    const i0 = bounds[k - 1], i1 = bounds[k], s = summarize(i0, i1);
    const partial = s.meters < unit * 0.95;
    const elev = (S.altitude[i1] ?? 0) - (S.altitude[i0] ?? 0);
    rows.push(`<tr class="clickable" data-i0="${i0}" data-i1="${i1}">
      <td>${k}${partial ? ` <span class="hint">(${dist(s.meters).toFixed(2)})</span>` : ""}</td>
      <td class="num"><b>${fmtPaceOrSpeed(s.speed, D.activity.activity_type)}</b></td>
      <td class="num">${run && s.gap ? fmtPace(s.gap) : ""}</td>
      <td class="num">${s.hr ? Math.round(s.hr) : ""}</td>
      <td class="num">${s.cadence ? Math.round(s.cadence) : ""}</td>
      <td class="num">${elev >= 0 ? "+" : "−"}${Math.abs(Math.round(elev))} ${u === "mi" ? "ft" : "m"}</td></tr>`);
  }
  $("splits").innerHTML = rows.join("") || `<tr><td colspan="6" class="empty">No distance data.</td></tr>`;
}

function renderEfforts() {
  const efforts = Object.entries(D.metrics?.best_efforts || {});
  $("efforts").innerHTML = efforts.length ? efforts.map(([label, e]) => {
    const i0 = S ? idxAtT(e.start_t) : 0;
    const i1 = S ? idxAtT(e.start_t + e.seconds) : 0;
    return `<tr class="clickable" data-i0="${i0}" data-i1="${i1}"><td>${esc(label)}</td>
      <td class="num"><b>${fmtDuration(e.seconds)}</b></td><td class="num">${fmtPace(e.meters / e.seconds)}</td>
      <td class="num">${fmtDuration(e.start_t)}</td></tr>`;
  }).join("") : `<tr><td colspan="4" class="empty">Best efforts are tracked for outdoor runs.</td></tr>`;
}

$("laps").addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-start]");
  if (!row || !S) return;
  const t0 = Number(row.dataset.start);
  selectRange(idxAtT(t0), idxAtT(t0 + Number(row.dataset.len)));
});
for (const id of ["splits", "efforts"]) {
  $(id).addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-i0]");
    if (row && S) selectRange(Number(row.dataset.i0), Number(row.dataset.i1));
  });
}

// ---------------------------------------------------------------- map

function zoneIndex(hr) {
  if (hr == null) return -1;
  return D.zones.findIndex((z) => hr >= z.low && hr < z.high);
}

function renderMap() {
  const s = D.streams;
  const has = s && s.lat.some((v) => v != null);
  $("map").parentElement.style.display = has ? "" : "none";
  if (!has || typeof L === "undefined") return;
  if (!map) {
    map = L.map("map", { scrollWheelZoom: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
  }
  Object.values(mapLayers).forEach((l) => l && map.removeLayer(l));
  const group = L.featureGroup();
  let seg = [], zone = null;
  const flush = () => {
    if (seg.length > 1) L.polyline(seg, { color: zone >= 0 ? cssVar(`--z${zone + 1}`) : cssVar("--elev"), weight: 4, opacity: 0.9 }).addTo(group);
  };
  for (let i = 0; i < S.n; i++) {
    if (s.lat[i] == null) continue;
    const z = zoneIndex(S.hr[i]);
    const pt = [s.lat[i], s.lon[i]];
    if (z !== zone) { seg.push(pt); flush(); seg = [pt]; zone = z; } else seg.push(pt);
  }
  flush();
  group.addTo(map);
  mapLayers.route = group;
  map.fitBounds(group.getBounds(), { padding: [12, 12] });
}

function updateMapMarker() {
  if (!map) return;
  if (mapLayers.marker) { map.removeLayer(mapLayers.marker); mapLayers.marker = null; }
  const s = D.streams;
  if (hoverIdx == null || s.lat[hoverIdx] == null) return;
  mapLayers.marker = L.circleMarker([s.lat[hoverIdx], s.lon[hoverIdx]], {
    radius: 6, color: cssVar("--surface-1"), weight: 2, fillColor: cssVar("--text-primary"), fillOpacity: 1,
  }).addTo(map);
}

function updateMapSelection() {
  if (!map) return;
  if (mapLayers.selection) { map.removeLayer(mapLayers.selection); mapLayers.selection = null; }
  if (!selection) return;
  const s = D.streams, pts = [];
  for (let i = selection[0]; i <= selection[1]; i++) if (s.lat[i] != null) pts.push([s.lat[i], s.lon[i]]);
  if (pts.length > 1) mapLayers.selection = L.polyline(pts, { color: cssVar("--text-primary"), weight: 7, opacity: 0.35 }).addTo(map);
}

// ---------------------------------------------------------------- page

function renderAll() {
  if (D.streams) { derive(); }
  renderHeader(); renderWarnings(); renderTiles(); renderZones(); renderLaps(); renderSplits(); renderEfforts();
  $("charts-card").style.display = D.streams ? "" : "none";
  if (D.streams) { buildPanels(); drawAll(); renderSelection(); }
}

$("xaxis").addEventListener("click", (e) => {
  const x = e.target.dataset.x;
  if (!x || !S) return;
  xMode = x;
  $("xaxis").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.x === x));
  derive(); drawAll();
});

unitsToggle($("units"), () => { renderAll(); });
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawAll, 100); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { drawAll(); if (D?.streams) renderMap(); });

getJSON(`/api/activities/${activityId}`)
  .then((data) => { D = data; renderAll(); renderMap(); })
  .catch((err) => { $("title").textContent = "Couldn't load this activity"; setStatus(err.message, true); });
