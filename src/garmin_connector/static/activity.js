// Workout detail: shared state, series helpers, tiles, warnings and weather.
// The rest is in activity-panels.js, activity-tables.js, activity-map.js and activity-compare.js;
// activity-start.js runs the page.

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
    D.source === "apple" ? "Apple Watch" : D.streams && hasHr() ? (D.external_hr ? "HR: arm band / strap" : "HR: wrist") : null,
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
    hrPaceStat(),
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

// Heart rate at your usual pace (the one picked on Progress), against your runs in the month before
function hrPaceStat() {
  const none = ["HR at pace", null, ""];
  const table = D.metrics?.hr_by_speed;
  if (!table?.length || !allActivities) return none;
  const u = Units.get();
  const pick = hrPaceChoice(hrPaces(allActivities, u), u);
  const hr = pick && hrAtPace(table, pick.mps);
  if (hr == null) return none;
  const t = localDate(D.activity.start_time_local).getTime();
  const before = allActivities
    .filter((a) => a.activity_id !== activityId && a.hr_by_speed?.length && isRun(a.activity_type))
    .filter((a) => { const x = localDate(a.start_time_local).getTime(); return x < t && x > t - 30 * 864e5; })
    .map((a) => hrAtPace(a.hr_by_speed, pick.mps)).filter((v) => v != null);
  let sub = "Steady running at that pace, adjusted for hills";
  if (before.length >= 2) {
    const d = Math.round(hr - before.reduce((s, v) => s + v, 0) / before.length);
    sub = d === 0 ? "Same as your runs the month before" : `${Math.abs(d)} bpm ${d < 0 ? "lower" : "higher"} than your runs the month before`;
  }
  return [`HR at ${fmtPace(pick.mps, u)}`, withUnit(`${Math.round(hr)} bpm`), sub];
}

// ---------- weather during the workout ----------
function renderConditions() {
  const el = $("conditions"), w = D.weather;
  if (!w || w.indoor || w.temp_c == null) { el.hidden = true; return; }
  const u = Units.get();
  const sky = skyOf(w.code), air = aqiOf(w.aqi);
  const rain = w.precip_mm >= 0.1 ? (u === "mi" ? `${(w.precip_mm / 25.4).toFixed(2)} in` : `${w.precip_mm.toFixed(1)} mm`) : "";
  const items = [
    [sky ? sky[1] : "Weather", `${sky ? sky[2] + " " : ""}${fmtTemp(w.temp_c, u)}`,
      [w.feels_c != null && Math.abs(w.feels_c - w.temp_c) >= 1.5 ? `Feels like ${fmtTemp(w.feels_c, u)}` : "", rain ? `${rain} of rain` : ""].filter(Boolean).join(" · ")],
    ["Dew point", fmtTemp(w.dew_c, u), w.humidity != null ? `Humidity ${w.humidity}%` : ""],
    ["Wind", w.wind_kmh != null ? `${fmtWind(w.wind_kmh, u)}${w.wind_kmh >= 3 && w.wind_dir != null ? " " + windFrom(w.wind_dir) : ""}` : null,
      w.gust_kmh != null && w.gust_kmh > (w.wind_kmh || 0) + 8 ? `Gusts ${fmtWind(w.gust_kmh, u)}` : ""],
    ["Air quality", air ? `<span style="color:var(${air[2]})">${w.aqi}</span>` : null, air ? `${air[1]} (US AQI)` : ""],
  ].filter(([, v]) => v);
  const heat = w.heat_pct || 0, word = heatWord(heat);
  const humid = (w.dew_c || 0) >= 16 ? " and humid" : "";
  let impact = !word ? (w.temp_c <= -5 ? "<b>Cold:</b> the first part feels harder; a longer warm-up helps."
      : "<b>Good running weather:</b> no meaningful effect on pace.")
    : heat < 2 ? `<b>${word}${humid}:</b> about ${heat}% slower at the same effort.`
    : `<b>${word}${humid}:</b> expect about ${heat}% slower at the same effort, with a higher heart rate than usual.`;
  if (air && w.aqi > 100) impact += ` <b style="color:var(${air[2]})">${air[1]} air:</b> hard efforts are best moved indoors on days like this.`;
  const range = w.temp_start_c != null && w.temp_end_c != null && Math.abs(w.temp_end_c - w.temp_start_c) >= 2
    ? ` Temperature went from ${fmtTemp(w.temp_start_c, u)} to ${fmtTemp(w.temp_end_c, u)}.` : "";
  el.hidden = false;
  el.innerHTML = `<div class="cond-grid">${items.map(([l, v, sub]) =>
      `<div><div class="label">${esc(l)}</div><div class="value">${v}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>`).join("")}</div>
    <p class="cond-impact">${impact}${esc(range)} <span class="dim">Weather from Open-Meteo${w.place_assumed
      ? ", for where your runs around then started (this one has no GPS)" : ""}.</span></p>`;
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
    // one note, not two: the arm band fixes both
    if (m.cadence_lock > 0.15) {
      notes.push(`Heart rate matched your cadence for ${Math.round(m.cadence_lock * 100)}% of this run. The wrist sensor probably locked onto your arm swing, so heart-rate numbers for this run may be off.`
        + (isIntervalWorkout() ? " For reps, your arm band also follows quick changes in heart rate much better." : ""));
    } else if (isIntervalWorkout()) {
      notes.push("This was recorded with wrist heart rate. Wrist sensors lag behind quick changes in short reps, so wearing your arm band gives better rep-by-rep HR.");
    }
  }
  $("warnings").innerHTML = notes.map((n) => `<div class="warn">${esc(n)}</div>`).join("");
}
