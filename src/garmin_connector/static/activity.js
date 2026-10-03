// Workout detail: synced second-by-second charts, range analysis, zones, laps, splits, map.

const activityId = Number(new URLSearchParams(location.search).get("id") || location.pathname.split("/").pop());
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
  wholeRun = null;
  const s = D.streams, n = s.t.length, u = Units.get();
  const dt = s.t.map((t, i) => { const g = i ? t - s.t[i - 1] : 1; return g > 0 && g <= PAUSE_GAP_S ? g : 1; });
  // carry distance forward over gaps so the distance axis is continuous
  let lastD = 0;
  const distance = s.distance.map((d) => (lastD = d ?? lastD));
  // Smoothing windows are in seconds; the phone copy has one sample every few seconds.
  const step = D.sample_step_s || 1;
  const win = (seconds) => Math.max(1, Math.round(seconds / step));
  const speed = rolling(s.speed, win(15)), gap = rolling(s.gap, win(15));
  const toPace = (v) => (v != null && v >= MOVING_MPS ? M_PER[u] / v : null);
  S = {
    n, t: s.t, dt, distance,
    hr: rolling(s.hr, win(3)),
    speed, gap,
    pace: speed.map(toPace),
    gapPace: gap.map(toPace),
    cadence: rolling(s.cadence.map((c) => (c && c > 60 ? c : null)), win(5)),
    altitude: rolling(s.altitude, win(9)).map((a) => (a == null ? null : elevUnit(a, u))),
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

// Runs, walks and hikes are shown as pace; rides and the rest as speed.
const usesPace = () => PACE_TYPES.test(D.activity.activity_type || "");
const cadUnit = () => (/cycl|bik|ride/.test(D.activity.activity_type || "") ? "rpm" : "spm");
const hasHr = () => !!(D.streams ? D.streams.hr.some((v) => v != null) : D.activity.avg_hr);

// ---------------------------------------------------------------- tiles & warnings

// "Tuesday, September 29, 2026 · 8:00–8:54 AM"
function timeRange(a) {
  const start = localDate(a.start_time_local);
  const end = new Date(start.getTime() + (a.duration_s || 0) * 1000);
  const day = start.toLocaleDateString(undefined, { dateStyle: "full" });
  if (!a.duration_s) return `${day} · ${start.toLocaleTimeString(undefined, { timeStyle: "short" })}`;
  const range = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).formatRange(start, end);
  return `${day} · ${range}`;
}

function renderHeader() {
  const a = D.activity;
  document.title = `${a.name || "Workout"} · Workout Detail`;
  $("title").textContent = a.name || "Workout";
  $("subtitle").textContent = [
    timeRange(a),
    prettyType(a.activity_type), a.location,
    D.streams && hasHr() ? (D.external_hr ? "HR: arm band / strap" : "HR: wrist") : null,
    ...(D.gear || []).map((g) => `${(g.type || "").toLowerCase() === "shoes" ? "Shoes" : g.type || "Gear"}: ${g.name}`),
  ].filter(Boolean).join(" · ");
}

function renderTagline() {
  const w = D.metrics?.workout;
  $("tagline").innerHTML = w ? `${tagHtml(w.label, w.quality, w.type)}<span class="hint" style="margin:0">${esc(w.reason)}</span>` : "";
}

// "6.56 mi" -> "6.56<small>mi</small>", so the number leads and the unit stays quiet
const withUnit = (text) => {
  const m = String(text || "").match(/^(\S+)\s+(.+)$/);
  return m ? `${m[1]}<small>${esc(m[2])}</small>` : esc(text || "–");
};

// Garmin's training effect scale
const teWord = (te) => (!te ? "" : te < 1 ? "No benefit" : te < 2 ? "Minor benefit" : te < 3 ? "Maintaining"
  : te < 4 ? "Improving" : te < 5 ? "Highly improving" : "Overreaching");
const prettyLabel = (s) => (s ? s.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()).replace("Vo2max", "VO2 max") : "");

// Running dynamics, power and the rest of what the watch measured
function watchStats(w, run) {
  const imperial = Units.get() === "mi";
  const out = [];
  if (w.calories) out.push(["Calories", withUnit(`${fmtNum(w.calories)} kcal`), ""]);
  if (w.avg_power_w) out.push(["Power", withUnit(`${Math.round(w.avg_power_w)} W`), w.norm_power_w ? `Normalized ${Math.round(w.norm_power_w)} W` : ""]);
  if (run && w.max_speed_mps) out.push(["Best pace", withUnit(fmtPace(w.max_speed_mps)), "Fastest moment of the run"]);
  if (w.stride_cm) out.push(["Stride length", withUnit(imperial ? `${(w.stride_cm / 30.48).toFixed(2)} ft` : `${(w.stride_cm / 100).toFixed(2)} m`), ""]);
  if (w.ground_contact_ms) out.push(["Ground contact", withUnit(`${Math.round(w.ground_contact_ms)} ms`), "Time each foot spends on the ground"]);
  if (w.vertical_oscillation_cm) out.push(["Vertical oscillation", withUnit(imperial ? `${(w.vertical_oscillation_cm / 2.54).toFixed(1)} in` : `${w.vertical_oscillation_cm.toFixed(1)} cm`),
    w.vertical_ratio_pct ? `Vertical ratio ${w.vertical_ratio_pct.toFixed(1)}%` : "Bounce with each step"]);
  if (w.body_battery_change != null) out.push(["Body Battery", `${w.body_battery_change > 0 ? "+" : ""}${Math.round(w.body_battery_change)}`, "Change during the run"]);
  if (w.sweat_loss_ml) out.push(["Sweat loss", withUnit(imperial ? `${Math.round(w.sweat_loss_ml / 29.574)} oz` : `${fmtNum(w.sweat_loss_ml)} ml`), "Estimated by Garmin"]);
  return out;
}

function renderTiles() {
  const a = D.activity, m = D.metrics || {}, w = D.watch || {};
  const whole = S ? summarize(0, S.n - 1) : null;
  const run = usesPace();
  const drift = m.decoupling_pct;
  const moving = whole ? whole.moving : a.moving_duration_s || a.duration_s;
  const elapsed = whole ? whole.time : a.duration_s;
  const hero = [
    ["Distance", withUnit(fmtDist(a.distance_m)), ""],
    ["Moving time", esc(fmtDuration(moving)), elapsed - moving > 30 ? `Elapsed ${fmtDuration(elapsed)}` : ""],
    [run ? "Avg pace" : "Avg speed", withUnit(fmtPaceOrSpeed(whole ? whole.speed : a.avg_speed_mps, a.activity_type)),
      run && whole?.gap ? `GAP ${fmtPace(whole.gap)}` : ""],
    // cleaned stream max, so a one-second wrist spike doesn't show up as your max
    ["Avg heart rate", a.avg_hr ? withUnit(`${Math.round(whole?.hr || a.avg_hr)} bpm`) : "–",
      a.avg_hr ? (whole?.hrMax || a.max_hr ? `Max ${Math.round(whole?.hrMax || a.max_hr)} bpm` : "") : "Not recorded"],
  ];
  const stats = [
    ["Cadence", whole?.cadence ? withUnit(`${Math.round(whole.cadence)} ${cadUnit()}`) : null, ""],
    ["Elevation gain", a.elevation_gain_m != null ? withUnit(fmtElev(a.elevation_gain_m)) : null, ""],
    ["Training load", m.trimp != null ? String(Math.round(m.trimp)) : null,
      w.garmin_load ? `Garmin's load ${Math.round(w.garmin_load)}` : "TRIMP, from heart rate"],
    ["Training effect", a.aerobic_te ? withUnit(`${a.aerobic_te.toFixed(1)} aerobic`) : null,
      [teWord(a.aerobic_te), a.anaerobic_te != null ? `anaerobic ${a.anaerobic_te.toFixed(1)}` : "", prettyLabel(w.te_label)].filter(Boolean).join(" · ")],
    ["HR drift", drift != null ? `${drift.toFixed(1)}%` : null,
      drift == null ? "" : drift < 5 ? "Steady: strong aerobic base" : drift < 8 ? "Some drift" : "High (heat, fatigue or too fast)"],
    ["Efficiency", m.efficiency ? withUnit(`${m.efficiency.toFixed(2)} m/beat`) : null, "Distance per heartbeat"],
    ["VO2max", D.effective_vo2max ? D.effective_vo2max.toFixed(1) : null,
      D.vo2max_shape ? `From pace and HR · your shape ${D.vo2max_shape.toFixed(1)}` : "From pace and heart rate"],
  ].filter(([, v]) => v != null);
  const extra = watchStats(w, run);
  const cell = ([l, v, sub]) => `<div class="tile"${l === "Avg heart rate" && a.avg_hr ? ' style="--vc:var(--hr)"' : ""}><div class="label">${l}</div><div class="value">${v || "–"}</div><div class="sub">${esc(sub)}</div></div>`;
  $("tiles").innerHTML = hero.map(cell).join("");
  $("stats").hidden = !stats.length;
  const statCell = ([l, v, sub]) =>
    `<div><div class="label">${l}</div><div class="value">${v}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>`;
  $("stats").innerHTML = stats.map(statCell).join("");
  // Running dynamics and the rest: open on a wide screen, a tap away on a phone
  const more = $("watch-more");
  if (more.hidden && extra.length) more.open = matchMedia("(min-width: 700px)").matches;
  more.hidden = !extra.length;
  $("watch-stats").innerHTML = extra.map(statCell).join("");
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

// ---------------------------------------------------------------- zones, laps, splits, efforts

// Hide table columns that have nothing in them (e.g. GAP on a ride, HR when none was recorded)
function showColumns(table, cols) {
  for (const [col, show] of cols) {
    table.querySelectorAll(`tr > :nth-child(${col})`).forEach((c) => { c.style.display = show ? "" : "none"; });
  }
}

// One line on what the zone mix means
function zoneTake(sec) {
  const total = sec.reduce((a, b) => a + b, 0);
  if (!total || sec.length < 5) return "";
  const pct = (a) => Math.round((a / total) * 100);
  const easy = pct(sec[0] + sec[1]), mid = pct(sec[2]), hard = pct(sec[3] + sec[4]);
  let text;
  if (hard >= 25) text = `<b>${hard}% in Z4–Z5:</b> a hard session. An easy day next lets it pay off.`;
  else if (easy >= 80) text = `<b>${easy}% in Z1–Z2:</b> easy aerobic running, the kind that builds your base.`;
  else if (mid >= 30) text = `<b>${mid}% in Z3:</b> moderate "tempo" effort. Useful, but easy days should stay easier than this.`;
  else text = `<b>${easy}% easy, ${hard}% hard:</b> a mixed effort.`;
  return `<p class="zone-take">${text}</p>`;
}

function renderZones() {
  const m = D.metrics;
  $("zones-card").hidden = !m?.zone_seconds;
  if (!m?.zone_seconds) return;
  $("zones").innerHTML = zoneRows(D.zones, m.zone_seconds) + zoneTake(m.zone_seconds);
  $("zones-hint").innerHTML = `${esc(zoneBasis(D.settings))}. <a href="${pageUrl("progress", { hash: "hr-settings" })}">Change zones</a>`;
}

// Time at each of your training paces (from VO2max shape), on grade-adjusted pace so hills
// don't count as speed work and downhills don't count as easy
function renderPaceZones() {
  const card = $("pace-zones-card");
  const b = D.pace_bounds_mps;
  card.hidden = !(b && D.streams && usesPace() && isRun(D.activity.activity_type));
  if (card.hidden) return;
  const names = ["Easy", "Marathon", "Threshold", "Interval", "Repetition"];
  const secs = [0, 0, 0, 0, 0];
  const s = D.streams;
  for (let i = 1; i < S.n; i++) {
    const v = s.gap[i] ?? s.speed[i];
    if (v == null || s.speed[i] == null || s.speed[i] < MOVING_MPS) continue;
    let k = 0;
    while (k < 4 && v >= b[k]) k++;
    secs[k] += S.dt[i];
  }
  const zones = names.map((name, i) => ({ name, low: i ? b[i - 1] : 0, high: b[i] ?? Infinity }));
  const total = secs.reduce((a, c) => a + c, 0) || 1;
  const maxShare = Math.max(...secs) / total || 1;
  const color = [2, 3, 4, 5, 5];
  const paceText = (z) => (z.low ? (z.high === Infinity ? `under ${fmtPace(z.low)}` : `${fmtPace(z.low, undefined, false)}–${fmtPace(z.high)}`) : `over ${fmtPace(z.high)}`);
  $("pace-zones").innerHTML = zones.map((z, i) => {
    const share = secs[i] / total;
    return `<div class="zone-row">
      <div><span class="swatch" style="--c:var(--z${color[i]})"></span>${z.name}<div class="range">${paceText(z)}</div></div>
      <div class="bar" role="img" aria-label="${Math.round(share * 100)}%"><div style="width:${(share / maxShare) * 100}%;background:var(--z${color[i]})"></div></div>
      <div class="val">${fmtDuration(secs[i])} · <b>${Math.round(share * 100)}%</b></div></div>`;
  }).join("");
  $("pace-zones-hint").textContent = `Your training paces from your current VO2max shape (${D.vo2max_shape.toFixed(1)}), on grade-adjusted pace.`;
}

function renderLaps() {
  const laps = D.laps;
  if (laps.length < 2) { $("laps-card").hidden = true; return; }
  $("laps-card").hidden = false;
  const interval = isIntervalWorkout();
  // Auto-laps every mile or km repeat the splits table; skip the card for those
  const autoLaps = !interval && laps.length >= 3 && laps.slice(0, -1).every((l) =>
    [1609.344, 1000].some((u) => Math.abs((l.distance_m || 0) - u) < u * 0.03));
  if (autoLaps) { $("laps-card").hidden = true; return; }
  const reps = laps.filter((l) => l.intensity === "active" && l.distance_m && l.timer_s);
  if (interval && reps.length >= 2) {
    const paces = reps.map((l) => paceSeconds(l.distance_m / l.timer_s)).filter(Boolean);
    const mean = paces.reduce((a, b) => a + b, 0) / paces.length;
    const spread = Math.sqrt(paces.reduce((a, b) => a + (b - mean) ** 2, 0) / paces.length);
    const hrs = reps.map((l) => l.avg_hr).filter(Boolean);
    $("laps-hint").textContent = `${reps.length} work reps averaged ${fmtDuration(mean)} /${Units.get()}` +
      (hrs.length ? ` at ${Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length)} bpm` : "") +
      `, varying by ±${Math.round(spread)} s. Bars show each lap's speed, colored by its heart-rate zone.`;
  } else {
    $("laps-hint").textContent = `${act()} a lap to analyze it on the timeline. Bars show each lap's speed${hasHr() ? ", colored by its heart-rate zone" : ""}.`;
  }
  const fastest = Math.max(...laps.map((l) => l.avg_speed || 0)) || 1;
  let rep = 0;
  $("laps").innerHTML = laps.map((l) => {
    const rest = ["rest", "recovery"].includes(l.intensity);
    // interval sessions read as reps and recoveries
    const type = interval && l.intensity === "active" ? `Rep ${++rep}` : interval && rest ? "Recovery" : prettyType(l.intensity || "lap");
    const zone = zoneIndex(l.avg_hr);
    const bar = l.avg_speed ? `<span class="pbar" style="width:${Math.round((l.avg_speed / fastest) * 48)}px;--c:${zone >= 0 ? `var(--z${zone + 1})` : "var(--elev)"}"></span>` : "";
    return `<tr class="clickable ${rest ? "muted" : ""}" tabindex="0" data-start="${l.start_t}" data-len="${l.elapsed_s || 0}">
      <td>${l.idx}</td><td>${esc(type)}</td>
      <td class="num">${fmtDuration(l.timer_s ?? l.elapsed_s)}</td>
      <td class="num">${fmtDist(l.distance_m)}</td>
      <td class="num">${bar}${l.avg_speed ? fmtPaceOrSpeed(l.avg_speed, D.activity.activity_type) : ""}</td>
      <td class="num">${l.avg_hr ? Math.round(l.avg_hr) : ""}</td>
      <td class="num">${l.max_hr ? Math.round(l.max_hr) : ""}</td>
      <td class="num">${l.avg_cadence ? Math.round(l.avg_cadence) : ""}</td></tr>`;
  }).join("");
  // Drop columns the watch didn't record for any lap
  $("laps-pace-h").textContent = usesPace() ? "Pace" : "Speed";
  showColumns($("laps").closest("table"), [[6, laps.some((l) => l.avg_hr)], [7, laps.some((l) => l.max_hr)], [8, laps.some((l) => l.avg_cadence)]]);
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
  const run = usesPace();
  const rows = [];
  const parts = [];
  for (let k = 1; k < bounds.length; k++) parts.push(summarize(bounds[k - 1], bounds[k]));
  const fastest = Math.max(...parts.map((p) => p.speed || 0)) || 1;
  // the quickest full split gets a label (not a short last one)
  const full = parts.map((p, k) => (p.meters >= unit * 0.95 ? p.speed || 0 : 0));
  const best = full.length > 2 ? full.indexOf(Math.max(...full)) : -1;
  for (let k = 1; k < bounds.length; k++) {
    const i0 = bounds[k - 1], i1 = bounds[k], s = parts[k - 1];
    const zone = zoneIndex(s.hr);
    const bar = s.speed ? `<span class="pbar" style="width:${Math.round((s.speed / fastest) * 28)}px;--c:${zone >= 0 ? `var(--z${zone + 1})` : "var(--elev)"}"></span>` : "";
    const partial = s.meters < unit * 0.95;
    const elev = (S.altitude[i1] ?? 0) - (S.altitude[i0] ?? 0);
    rows.push(`<tr class="clickable" tabindex="0" data-i0="${i0}" data-i1="${i1}">
      <td>${k}${partial ? ` <span class="hint">(${dist(s.meters).toFixed(2)})</span>` : ""}${k - 1 === best ? ` <span class="best" title="Fastest split" aria-label="Fastest split">★</span>` : ""}</td>
      <td class="num">${bar}<b>${fmtPaceOrSpeed(s.speed, D.activity.activity_type)}</b></td>
      <td class="num">${run && s.gap ? fmtPace(s.gap) : ""}</td>
      <td class="num">${s.hr ? Math.round(s.hr) : ""}</td>
      <td class="num">${s.cadence ? Math.round(s.cadence) : ""}</td>
      <td class="num">${elev >= 0 ? "+" : "−"}${Math.abs(Math.round(elev))} ${u === "mi" ? "ft" : "m"}</td></tr>`);
  }
  $("splits").innerHTML = rows.join("") || `<tr><td colspan="6" class="empty">No distance data.</td></tr>`;
  $("splits-pace-h").textContent = usesPace() ? "Pace" : "Speed";
  const gap = run && parts.some((p) => p.gap);
  $("splits-hint").textContent = (gap ? "GAP (grade-adjusted pace) is the flat-ground equivalent of each split's effort. " : "") +
    (hasHr() ? "Bars show speed, colored by heart-rate zone." : "Bars show speed.");
  if (rows.length) showColumns($("splits").closest("table"), [[3, run && parts.some((p) => p.gap)], [4, parts.some((p) => p.hr)], [5, parts.some((p) => p.cadence)]]);
}

function renderEfforts() {
  const efforts = Object.entries(D.metrics?.best_efforts || {});
  // Only outdoor runs have best efforts; skip the card for everything else
  $("efforts-card").hidden = !efforts.length;
  $("efforts").innerHTML = efforts.length ? efforts.map(([label, e]) => {
    const i0 = S ? idxAtT(e.start_t) : 0;
    const i1 = S ? idxAtT(e.start_t + e.seconds) : 0;
    return `<tr class="clickable" tabindex="0" data-i0="${i0}" data-i1="${i1}"><td>${esc(label)}</td>
      <td class="num"><b>${fmtDuration(e.seconds)}</b></td><td class="num">${fmtPace(e.meters / e.seconds)}</td>
      <td class="num">${fmtDuration(e.start_t)}</td></tr>`;
  }).join("") : `<tr><td colspan="4" class="empty">Best efforts are tracked for outdoor runs.</td></tr>`;
}

// Enter or Space on a focused row does what a click does
for (const id of ["laps", "splits", "efforts"]) {
  $(id).addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("tr.clickable")) { e.preventDefault(); e.target.click(); }
  });
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
  // The route is stored with the workout, but the map tiles behind it come from the internet.
  const colored = hasHr();
  $("map-hint").textContent = (colored ? "Colored by heart-rate zone." : "No heart rate was recorded, so the route isn't colored by zone.") +
    (navigator.onLine === false ? " You're offline, so the map background won't load; the route still shows." : "");
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
  $("map-legend").innerHTML = !colored ? "" : D.zones.map((z, i) => `<span style="--c:var(--z${i + 1})">Z${i + 1}</span>`).join("");
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
  renderHeader(); renderTagline(); renderWarnings(); renderTiles(); renderZones(); if (S) renderPaceZones(); else $("pace-zones-card").hidden = true;
  renderLaps(); renderSplits(); renderEfforts();
  renderNotes($("notes"), (D.insights || []).filter((n) => !n.title.startsWith("Tagged:")), "Nothing stands out in this workout.");
  setupAiBox($("ai"), "activity", activityId);
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

unitsToggle($("units"), () => { renderAll(); if (allActivities) renderComparison(allActivities); });
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawAll, 100); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { drawAll(); if (D?.streams) renderMap(); });

// Previous / next workout (with second-by-second data), so you can page through your training
// "vs. your last Easy run (Sep 25): 0:05 /mi faster at 1 bpm lower"
function renderComparison(all) {
  const a = D.activity, w = D.metrics?.workout;
  const el = $("compare-last");
  // Whole-run averages only mean something for steady runs, not for reps with recoveries
  const steady = ["easy", "recovery", "easy_strides", "long", "tempo", "threshold", "progression"].includes(w?.type);
  if (!w || !steady || !isRun(a.activity_type) || !a.avg_speed_mps) { el.hidden = true; return; }
  const prev = all.find((x) => x.activity_id !== a.activity_id && x.workout_type === w.type && isRun(x.activity_type)
    && x.start_time_local < a.start_time_local && x.avg_speed_mps);
  if (!prev) { el.hidden = true; return; }
  const u = Units.get();
  const dp = Math.round(paceSeconds(a.avg_speed_mps) - paceSeconds(prev.avg_speed_mps)); // seconds per unit, negative = faster
  const pace = Math.abs(dp) < 2 ? "about the same pace" : `${fmtDuration(Math.abs(dp))} /${u} ${dp < 0 ? "faster" : "slower"}`;
  const dh = a.avg_hr && prev.avg_hr ? Math.round(a.avg_hr - prev.avg_hr) : null;
  const hr = dh == null ? "" : Math.abs(dh) < 1 ? " at the same heart rate" : ` at ${Math.abs(dh)} bpm ${dh < 0 ? "lower" : "higher"} heart rate`;
  const better = dp <= 0 && (dh == null || dh <= 0) && (dp < -1 || (dh != null && dh < 0));
  el.hidden = false;
  el.innerHTML = `<span class="${better ? "up" : ""}">vs. your last ${esc(/^.[a-z]/.test(w.label) ? w.label[0].toLowerCase() + w.label.slice(1) : w.label)}</span>
    (<a href="${pageUrl("activity", { id: prev.activity_id })}">${esc(fmtDate(prev.start_time_local, { month: "short", day: "numeric" }))}</a>): ${pace}${hr}`;
}

let allActivities = null; // the activity list, for the comparison line and older/newer
async function renderPrevNext() {
  const all = allActivities = await getJSON("/api/activities");
  renderComparison(all);
  const list = all.filter((a) => a.has_streams);
  const i = list.findIndex((a) => a.activity_id === activityId);
  if (i < 0) return;
  const link = (a, text, rel) => (a ? `<a href="${pageUrl("activity", { id: a.activity_id })}" rel="${rel}" title="${esc(a.name)} · ${esc(fmtDate(a.start_time_local))}">${text}</a>` : `<span class="off">${text}</span>`);
  // the list is newest first
  $("pn").innerHTML = link(list[i + 1], "‹ Older", "prev") + link(list[i - 1], "Newer ›", "next");
}

document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const rel = e.key === "ArrowLeft" ? "prev" : e.key === "ArrowRight" ? "next" : null;
  const a = rel && document.querySelector(`#pn a[rel="${rel}"]`);
  if (a) location.href = a.href;
});

getJSON(`/api/activities/${activityId}`)
  .then((data) => {
    D = data; renderAll(); ready(); renderMap(); renderPrevNext().catch(() => {});
    // Opened from a record: select that stretch
    const m = location.hash.match(/t=(\d+)-(\d+)/);
    if (m && S) selectRange(idxAtT(Number(m[1])), idxAtT(Number(m[2])));
  })
  .catch((err) => { ready(); $("title").textContent = "Couldn't load this activity"; setStatus(err.message, true); });
