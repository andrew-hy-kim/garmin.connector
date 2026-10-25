// Workout detail: zones, laps, splits and best efforts.

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
      (Math.round(spread) ? `, varying by ±${Math.round(spread)} s` : ", all at the same pace") + `. Bars show each lap's speed, colored by its heart-rate zone.`;
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
