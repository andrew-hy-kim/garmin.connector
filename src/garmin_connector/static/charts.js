// Progress charts: base, fatigue & form, consistency, volume, long runs, intensity, efficiency,
// heart rate at a fixed pace, running form, VO2 max, records; and the heart-rate settings.

// ---------- training load ----------
function renderLoad() {
  if (!$("load")) return;
  const startDay = isoDay(rangeStart());
  const days = state.load.filter((d) => d.date >= startDay);
  const long = days.length > 400;
  // Over long ranges plot weekly averages: fewer points to draw and a readable fatigue line
  let recent = days;
  if (long) {
    const weeks = new Map();
    for (const d of days) {
      const k = isoDay(startOfWeek(new Date(d.date + "T12:00")));
      const w = weeks.get(k) || { date: k, fitness: 0, fatigue: 0, n: 0 };
      w.fitness += d.fitness; w.fatigue += d.fatigue; w.n += 1;
      weeks.set(k, w);
    }
    recent = [...weeks.values()].map((w) => ({ date: w.date, fitness: w.fitness / w.n, fatigue: w.fatigue / w.n }));
  }
  const label = (d) => (long ? fmtMonthYear(new Date(d.date + "T12:00")) : new Date(d.date + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  const opts = chartBase();
  opts.plugins.tooltip = { callbacks: {
    title: (i) => (long ? "Week of " : "") + new Date(recent[i[0].dataIndex].date + "T12:00").toLocaleDateString(undefined, { dateStyle: "medium" }),
    label: (i) => `${i.dataset.label}${long ? " (average)" : ""}: ${i.parsed.y.toFixed(0)}`,
  } };
  drawChart("load", "load", {
    type: "line",
    data: { labels: recent.map(label), datasets: [
      { label: "Base", data: recent.map((d) => d.fitness), borderColor: cssVar("--fitness"), backgroundColor: cssVar("--fitness") + "1f",
        fill: "origin", borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 4, order: 0 },
      // Fatigue jumps every workout; drawn lighter so the slower fitness trend stays readable
      { label: "Fatigue", data: recent.map((d) => d.fatigue), borderColor: cssVar("--fatigue") + "b3", borderWidth: 1.5,
        pointRadius: 0, pointHoverRadius: 4, order: 1 },
    ] },
    options: opts,
  });

  // Fitness needs about 6 weeks of history before form means anything; grey out that stretch.
  const warmupEnd = state.load.length ? isoDay(new Date(new Date(state.load[0].date + "T12:00").getTime() + WARMUP_DAYS * 864e5)) : "";
  // Daily form bars, or weekly averages over long ranges so bars stay readable.
  let bars = days.map((d) => ({ ...d, warmup: d.date < warmupEnd }));
  if (long) {
    const weeks = new Map();
    for (const d of days) {
      const k = isoDay(startOfWeek(new Date(d.date + "T12:00")));
      const w = weeks.get(k) || { date: k, form: 0, fitness: 0, n: 0 };
      w.form += d.form; w.fitness += d.fitness; w.n += 1;
      weeks.set(k, w);
    }
    bars = [...weeks.values()].map((w) => ({ date: w.date, form: w.form / w.n, fitness: w.fitness / w.n, warmup: w.date < warmupEnd }));
  }
  const formOpts = chartBase();
  formOpts.plugins.tooltip = { callbacks: {
    title: (i) => (long ? "Week of " : "") + new Date(bars[i[0].dataIndex].date + "T12:00").toLocaleDateString(undefined, { dateStyle: "medium" }),
    label: (i) => `Form: ${fmtSigned(i.parsed.y)}`,
    afterLabel: (i) => (bars[i.dataIndex].warmup ? "Still building history, so form isn't meaningful yet" : formState(bars[i.dataIndex]).label),
  } };
  formOpts.scales.x.ticks.display = false;
  // look colors up once, not once per bar
  const stateColor = Object.fromEntries(FORM_STATES.map((st) => [st.key, cssVar(st.color)]));
  const warm = cssVar("--surface-3");
  $("form-legend").innerHTML = "<span class='lbl'>Form</span>" +
    FORM_STATES.map((st) => `<span style="--c:var(${st.color})">${st.label}</span>`).join("");
  drawChart("form", "form", {
    type: "bar",
    data: { labels: bars.map((d) => d.date), datasets: [{ label: "Form", data: bars.map((d) => d.form),
      backgroundColor: bars.map((d) => (d.warmup ? warm : stateColor[formState(d).key])), barPercentage: 1, categoryPercentage: 0.9 }] },
    options: formOpts,
  });
}

// Plain-language reading of the numbers, plus what resting would do.
function renderExplain() {
  if (!$("explain")) return;
  const today = state.load.at(-1);
  if (!today) { $("explain").innerHTML = `<p>Appears once workouts with heart rate are synced.</p>`; return; }
  const st = formState(today);
  const ago6 = state.load.at(-43);
  const trend = ago6 ? today.fitness - ago6.fitness : null;
  // Rest projection: no training, both averages decay
  let f = today.fitness, a = today.fatigue, freshDay = null;
  const proj = {};
  for (let d = 1; d <= 14; d++) {
    f -= f / 42; a -= a / 7;
    if (d === 3 || d === 7) proj[d] = { form: f - a, fitness: f };
    if (freshDay == null && (f - a) / f >= 0.10) freshDay = d;
  }
  const sign = fmtSigned;
  const scale = FORM_STATES.map((s) => `<div style="--c:var(${s.color})" class="${s === st ? "now" : ""}"><b>${s.label}</b>${
    s.key === "fresh" ? "above +10%" : s.key === "neutral" ? "−10% to +10%" : s.key === "productive" ? "−30% to −10%" : "below −30%"} of base</div>`).join("");
  $("explain").innerHTML = `
    <div class="verdict" style="--c:var(${textColor(st)})"><span class="big">${sign(today.form)}</span>
      <div><b>${warmingUp() ? "Getting started" : st.label}</b><span>${warmingUp() ? WARMUP_TEXT : rebuildingNote(st) || st.text}</span></div></div>
    <div>Base is <b>${today.fitness.toFixed(0)}</b>${trend == null ? "" : Math.abs(trend) < 1 ? ", about the same as 6 weeks ago"
      : `, ${trend > 0 ? "up" : "down"} ${Math.abs(trend).toFixed(0)} from 6 weeks ago`}. Fatigue is <b>${today.fatigue.toFixed(0)}</b>.
      ${warmingUp() ? "" : `If you rested completely, form would be <b>${sign(proj[3].form)}</b> in 3 days and <b>${sign(proj[7].form)}</b> in 7${
      freshDay && st.key !== "fresh" ? ` (fresh after about ${freshDay} day${freshDay > 1 ? "s" : ""})` : ""}, while base would slip to ${proj[7].fitness.toFixed(0)}.`}</div>
    ${warmingUp() ? "" : loadExtrasHtml()}
    <details class="more"><summary>What do base, fatigue and form mean?</summary>
      <div class="scale">${scale}</div>
      <p><b>Base</b> is the average training load you've carried per day over about 6 weeks: the training you've banked
      (often called "fitness" elsewhere; your running fitness itself is VO2max shape, at the top of Progress).
      <b>Fatigue</b> is the same over the last week: how tired that training has made you. Each workout's load comes from how long
      you spent at each heart rate, with hard minutes counting much more than easy ones.</p>
      <p><b>Monotony</b> is how similar your days were over the last week (average load over its spread). Varied days,
      hard and easy, keep it under 1.5; above 2, the same load day after day raises the risk of illness and overtraining.
      <b>Strain</b> is the week's load times its monotony.</p>
      <p><b>Form</b> is base minus fatigue. Building your base means carrying some fatigue; resting before a race (a taper)
      trades a little base for a lot of freshness.</p></details>`;
}

function loadExtrasHtml() {
  const x = loadExtras(state.load);
  if (!x) return "";
  const idle = !x.weekLoad;  // nothing in the last 7 days: there's no variety to judge
  const mono = idle ? ["", "no runs this week"] : x.monotony >= 2 ? ["warn", "too uniform"] : x.monotony >= 1.5 ? ["warn", "a bit uniform"] : ["good", "nicely varied"];
  return `<div class="kv load-kv">
    <div><span>Monotony</span><b class="${mono[0] === "warn" ? "warn-text" : ""}">${idle ? "–" : x.monotony.toFixed(1)}</b><small>${mono[1]}</small></div>
    <div><span>Strain</span><b>${Math.round(x.strain)}</b><small>this week's load ${Math.round(x.weekLoad)}</small></div>
    <div><span>To fresh</span><b>${x.restDays ? `${x.restDays} day${x.restDays > 1 ? "s" : ""}` : "now"}</b><small>of rest or easy running</small></div>
    <div><span>Today</span><b>≤ ${Math.round(x.balanced)}</b><small>load keeps you balanced</small></div>
  </div>`;
}

// Fitness now vs. earlier points and your all-time peak.
function renderCompare() {
  if (!$("compare")) return;
  if (!state.load.length) { $("compare").innerHTML = ""; return; }
  const byDate = new Map(state.load.map((d) => [d.date, d]));
  const at = (daysAgo) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); return byDate.get(isoDay(d)); };
  const peak = state.load.reduce((p, d) => (d.fitness > p.fitness ? d : p));
  const rows = [["Now", state.load.at(-1)], ["3 months ago", at(91)], ["6 months ago", at(182)], ["1 year ago", at(365)],
    ["2 years ago", at(730)], ["3 years ago", at(1095)], ["5 years ago", at(1826)]].filter(([, d]) => d);
  rows.push([`Peak (${new Date(peak.date + "T12:00").toLocaleDateString(undefined, { month: "short", year: "numeric" })})`, peak]);
  const now = Math.round(state.load.at(-1).fitness);
  $("compare").innerHTML = rows.map(([label, d], i) => {
    const diff = Math.round(d.fitness) - now;
    const vs = i === 0 ? "" : !diff ? "same as now" : `${Math.abs(diff)} ${diff > 0 ? "higher" : "lower"} than now`;
    return `<tr><td>${label}</td><td class="num"><b>${d.fitness.toFixed(0)}</b></td><td class="delta">${vs}</td></tr>`;
  }).join("");
}

// Click a week (or month) on a bar chart: list just those activities.
function showPeriod(b, i, extra = {}) {
  const from = b.list[i];
  const to = b.monthly ? new Date(from.getFullYear(), from.getMonth() + 1, 1) : new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7);
  const last = new Date(to); last.setDate(last.getDate() - 1);
  location.href = pageUrl("activities", { query: { from: isoDay(from), to: isoDay(last), ...extra } });
}
// Pointer cursor over clickable marks
const clickCursor = (e, els) => { e.native.target.style.cursor = els.length ? "pointer" : "default"; };

// ---------- consistency calendar ----------
function renderConsistency() {
  if (!$("cal")) return;
  // as many weeks as fit the card (up to a year)
  const step = matchMedia("(max-width: 600px)").matches ? 19 : 20;
  const weeks = Math.max(8, Math.min(53, Math.floor(($("cal").parentElement.clientWidth - 18) / step)));
  const thisWeek = startOfWeek(new Date());
  const first = new Date(thisWeek); first.setDate(first.getDate() - (weeks - 1) * 7);
  const byDay = new Map();
  for (const a of filtered()) {
    const day = a.start_time_local.slice(0, 10);
    const prev = byDay.get(day);
    if (!prev || (a.distance_m || 0) > (prev.distance_m || 0)) byDay.set(day, a);
  }
  const longest = Math.max(1, ...[...byDay.values()].map((a) => a.distance_m || 0));
  const today = isoDay(new Date());
  const cols = [];
  let prevMonth = null, lastLabel = -9;
  for (let w = 0; w < weeks; w++) {
    const start = new Date(first); start.setDate(start.getDate() + w * 7);
    const month = start.getMonth();
    // label the first week of each month, unless the previous label is too close
    const newMonth = month !== prevMonth && w - lastLabel >= 3;
    const label = newMonth ? start.toLocaleDateString(undefined, { month: "short" }) : "";
    if (newMonth) lastLabel = w;
    prevMonth = month;
    const cells = [];
    for (let k = 0; k < 7; k++) {
      const d = new Date(start); d.setDate(d.getDate() + k);
      const iso = isoDay(d);
      const a = byDay.get(iso);
      if (iso > today) { cells.push(`<i class="future"></i>`); continue; }
      if (!a) { cells.push(`<i title="${esc(fmtDate(iso))}: rest"></i>`); continue; }
      const size = 45 + 55 * Math.sqrt((a.distance_m || 0) / longest);
      const color = a.workout_type ? typeColor(a.workout_type) : "var(--z1)";
      cells.push(`<i class="run${a.has_streams ? " link" : ""}" data-id="${a.activity_id}" title="${esc(fmtDate(iso))}: ${esc(a.workout_label || prettyType(a.activity_type))}, ${esc(fmtDist(a.distance_m))}"><b style="--c:${color};--s:${size.toFixed(0)}%"></b></i>`);
    }
    cols.push(`<div class="col"><span class="m">${label}</span>${cells.join("")}</div>`);
  }
  $("cal").innerHTML = `<div class="col days"><span class="m"></span><i>M</i><i></i><i>W</i><i></i><i>F</i><i></i><i></i></div>` + cols.join("");
  // streaks: weeks in a row with 3+ runs (this week counts once it reaches 3)
  const counts = [];
  for (let w = 0; w < 52; w++) {
    const start = new Date(thisWeek); start.setDate(start.getDate() - w * 7);
    let n = 0;
    for (let k = 0; k < 7; k++) { const d = new Date(start); d.setDate(d.getDate() + k); if (byDay.has(isoDay(d))) n++; }
    counts.push(n);
  }
  let streak = 0;
  for (let w = counts[0] >= 3 ? 0 : 1; w < counts.length && counts[w] >= 3; w++) streak++;
  const recent = counts.slice(1, 13);
  const perWeek = recent.reduce((t, n) => t + n, 0) / (recent.length || 1);
  $("cons-stats").textContent = `${perWeek.toFixed(1)} ${state.type === "run" ? "runs" : "days"} a week lately` +
    (streak >= 2 ? ` · ${streak} weeks in a row with 3+` : "");
}
// "/" jumps to the activity search, like many Mac apps
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || !$("f-search") || e.target.closest("input, select, textarea")) return;
  e.preventDefault();
  $("f-search").focus();
  $("activities").scrollIntoView({ behavior: "smooth", block: "start" });
});
let calTimer;
window.addEventListener("resize", () => { clearTimeout(calTimer); calTimer = setTimeout(() => state.activities.length && renderConsistency(), 150); });
$("cal")?.addEventListener("click", (e) => {
  const cell = e.target.closest("i.run.link");
  if (cell) location.href = pageUrl("activity", { id: cell.dataset.id });
});

// ---------- volume ----------
function renderVolume() {
  if (!$("weekly")) return;
  const b = buckets();
  const totals = b.list.map(() => 0);
  for (const a of filtered()) {
    const i = b.indexOf(localDate(a.start_time_local));
    if (i != null) totals[i] += dist(a.distance_m);
  }
  const u = Units.get();
  $("volume-title").textContent = b.monthly ? "Monthly distance" : "Weekly distance";
  const avg = totals.reduce((s, v) => s + v, 0) / (totals.length || 1);
  $("volume-hint").textContent = `${act()} a bar to list those runs.`;
  $("vol-head").innerHTML = `<span class="big">${fmtNum(avg, 1)}<small>${u}</small></span><span class="dim">average per ${b.monthly ? "month" : "week"} ${state.range === "All" ? "since you started" : `over ${state.range}`}</span>`;
  const opts = chartBase();
  opts.plugins.tooltip = { callbacks: { title: (i) => `${b.monthly ? "" : "Week of "}${i[0].label}`,
    label: (i) => `${i.parsed.y.toFixed(1)} ${u}${i.dataIndex === totals.length - 1 ? " so far" : ""}` } };
  opts.scales.y.ticks.callback = (v) => `${v} ${u}`;
  opts.onClick = (e, els) => { if (els.length) showPeriod(b, els[0].index); };
  opts.onHover = clickCursor;
  opts.plugins.tooltip.callbacks.footer = () => `${act()} to list these ${state.type === "run" ? "runs" : "activities"}`;
  drawChart("weekly", "weekly", {
    type: "bar",
    // the current week or month is still in progress: drawn lighter
    data: { labels: b.labels, datasets: [{ data: totals, backgroundColor: ((c) => totals.map((_, i) => c + (i === totals.length - 1 ? "66" : "")))(cssVar("--pace")),
      borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", maxBarThickness: 18 }] },
    options: opts,
  });
}

// ---------- long runs ----------
// The longest run of each week: endurance for long races comes from these (see marathon shape).
function renderLongRuns() {
  if (!$("longruns")) return;
  const b = buckets();
  const longest = b.list.map(() => 0);
  for (const a of state.activities) {
    if (!isRun(a.activity_type)) continue;
    const i = b.indexOf(localDate(a.start_time_local));
    if (i != null) longest[i] = Math.max(longest[i], dist(a.distance_m));
  }
  const u = Units.get();
  const threshold = dist(13000);
  const target = state.perf?.marathon_shape ? dist(state.perf.marathon_shape.long_target_km * 1000) : null;
  $("longruns-hint").textContent = `Your longest run each ${b.monthly ? "month" : "week"}. Runs over ${fmtNum(threshold, u === "mi" ? 1 : 0)} ${u} (dashed line) build the endurance long races need${
    target ? `; the solid line is the long run a marathon at your fitness calls for (${fmtNum(target, 0)} ${u})` : ""}.`;
  const recent = longest.slice(-10).filter((v) => v > threshold).length;
  $("longruns-head").innerHTML = `<span class="big">${fmtNum(Math.max(...longest.slice(-4), 0), 1)}<small>${u}</small></span><span class="dim">longest in the last 4 ${b.monthly ? "months" : "weeks"}${b.monthly ? "" : ` · ${recent} long run${recent === 1 ? "" : "s"} in 10 weeks`}</span>`;
  const opts = chartBase();
  opts.scales.y.ticks.callback = (v) => `${v} ${u}`;
  opts.onClick = (e, els) => { if (els.length) showPeriod(b, els[0].index); };
  opts.onHover = clickCursor;
  opts.plugins.tooltip = { callbacks: { title: (i) => `${b.monthly ? "" : "Week of "}${i[0].label}`,
    label: (i) => (i.datasetIndex ? `${i.dataset.label}: ${i.parsed.y.toFixed(1)} ${u}` : `Longest run: ${i.parsed.y.toFixed(1)} ${u}`) } };
  const line = (label, v, color, dash) => ({ type: "line", label, data: b.list.map(() => v), borderColor: color, borderWidth: 1.5,
    borderDash: dash, pointRadius: 0, pointHoverRadius: 0 });
  drawChart("longruns", "longruns", {
    type: "bar",
    data: { labels: b.labels, datasets: [
      { data: longest, backgroundColor: longest.map((v) => cssVar(v > threshold ? "--pace" : "--surface-3")), borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", maxBarThickness: 18 },
      line("Counts as a long run above", threshold, cssVar("--text-muted"), [4, 3]),
      ...(target ? [line("Marathon long-run target", target, cssVar("--elev"), [])] : []),
    ] },
    options: opts,
  });
}

// ---------- intensity mix ----------
const MIX = [["Easy", "--z2"], ["Tempo", "--z3"], ["Threshold", "--z4"], ["VO2 max", "--z5"]];
function renderMix() {
  if (!$("mix")) return;
  const b = buckets();
  const mins = MIX.map(() => b.list.map(() => 0));
  for (const a of state.activities) {
    if (!isRun(a.activity_type) || !a.intensity_seconds) continue;
    const i = b.indexOf(localDate(a.start_time_local));
    if (i == null) continue;
    a.intensity_seconds.forEach((s, k) => { mins[k][i] += s / 60; });
  }
  const totals = MIX.map((_, k) => mins[k].reduce((t, v) => t + v, 0));
  const all = totals.reduce((t, v) => t + v, 0);
  const easy = all ? Math.round((totals[0] / all) * 100) : null;
  $("mix-legend").innerHTML = MIX.map(([l, c]) => `<span style="--c:var(${c})">${l}</span>`).join("") +
    "";
  $("mix-head").innerHTML = easy == null ? "" : `<span class="big">${easy}%<small>easy</small></span><span class="dim">${state.range === "All" ? "since you started" : `over ${state.range}`}</span>`;
  const opts = chartBase();
  opts.scales.x.stacked = true; opts.scales.y.stacked = true;
  opts.scales.y.ticks.callback = (v) => `${v} min`;
  opts.onClick = (e, els) => { if (els.length) showPeriod(b, els[0].index); };
  opts.onHover = clickCursor;
  opts.plugins.tooltip = { callbacks: {
    title: (i) => `${b.monthly ? "" : "Week of "}${i[0].label}`,
    label: (i) => {
      const total = mins.reduce((t, m) => t + m[i.dataIndex], 0) || 1;
      return `${i.dataset.label}: ${Math.round(i.parsed.y)} min (${Math.round((i.parsed.y / total) * 100)}%)`;
    },
  } };
  drawChart("mix", "mix", {
    type: "bar",
    data: { labels: b.labels,
      datasets: MIX.map(([label, c], k) => ({ label, data: mins[k], backgroundColor: cssVar(c),
        borderColor: cssVar("--surface-1"), borderWidth: { top: 2 }, maxBarThickness: 22 })) },
    options: opts,
  });
}

// Shared x axis for the date-based line/scatter charts
function timeAxis(opts) {
  opts.scales.x.type = "linear";
  opts.scales.x.min = rangeStart().getTime();
  opts.scales.x.max = Date.now();
  opts.scales.x.ticks.callback = (v) => fmtMonthYear(new Date(v));
}

// ---------- hot days on the fitness charts ----------
// Heat raises heart rate at any pace, so hot or humid runs show as orange triangles and are
// left out of the 30-day average: the line tracks fitness, not the weather.
const isHot = (a) => (a.weather?.heat_pct || 0) >= HOT_PCT;
const hotNote = (a) => (isHot(a) ? ` · hot day: ${fmtTemp(a.weather.temp_c)}, dew point ${fmtTemp(a.weather.dew_c)}` : "");
function coolTrend(all, pts) {
  const cool = all.filter((q) => !isHot(q.a));
  return pts.filter((p) => !isHot(p.a)).map((p) => {
    const win = cool.filter((q) => q.x <= p.x && q.x > p.x - 30 * 864e5);
    return { x: p.x, y: win.reduce((s, q) => s + q.y, 0) / win.length };
  });
}
function dotStyle(pts, color) {
  return {
    backgroundColor: pts.map((p) => (isHot(p.a) ? cssVar("--gap") + "cc" : color + "66")),
    pointStyle: pts.map((p) => (isHot(p.a) ? "triangle" : "circle")),
    pointRadius: pts.map((p) => (isHot(p.a) ? 4 : 3)), pointHoverRadius: 6,
  };
}
// a small key under a chart when it has hot-day dots
const hotKey = (pts) => (pts.some((p) => isHot(p.a)) ? `<span class="hot-key">▲ Hot or humid day, left out of the average</span>` : "");

// ---------- efficiency ----------
function renderEfficiency() {
  if (!$("efficiency")) return;
  const easyCeiling = state.settings ? 0.9 * state.settings.lthr : 999;
  const all = state.activities
    .filter((a) => isRun(a.activity_type) && a.efficiency && a.avg_hr && a.avg_hr < easyCeiling && !(a.cadence_lock > 0.2))
    .map((a) => ({ x: localDate(a.start_time_local).getTime(), y: a.efficiency, a }))
    .sort((p, q) => p.x - q.x);
  // 30-day rolling average, so the trend shows through day-to-day noise
  const start = rangeStart().getTime();
  const pts = all.filter((p) => p.x >= start);
  const trend = coolTrend(all, pts);
  const opts = chartBase();
  opts.interaction = { mode: "nearest", intersect: false };
  timeAxis(opts);
  opts.scales.y.ticks.callback = (v) => `${v.toFixed(2)} m`;
  // only a dot right under the pointer opens its run
  const dotsAt = (e, chart) => chart.getElementsAtEventForMode(e.native, "nearest", { intersect: true }, false).filter((el) => el.datasetIndex === 0);
  opts.onClick = (e, _, chart) => {
    const hit = dotsAt(e, chart)[0];
    if (hit) location.href = pageUrl("activity", { id: pts[hit.index].a.activity_id });
  };
  opts.onHover = (e, _, chart) => clickCursor(e, dotsAt(e, chart));
  opts.plugins.tooltip = { callbacks: {
    title: (i) => new Date(i[0].parsed.x).toLocaleDateString(undefined, { dateStyle: "medium" }),
    label: (i) => i.datasetIndex === 0
      ? `${i.raw.a.name}: ${i.parsed.y.toFixed(2)} m/beat at ${Math.round(i.raw.a.avg_hr)} bpm${hotNote(i.raw.a)}`
      : `30-day average: ${i.parsed.y.toFixed(2)} m/beat`,
  } };
  $("eff-head").innerHTML = trend.length > 1 ? headline(`${trend.at(-1).y.toFixed(2)}<small>m/beat</small>`,
    ((trend.at(-1).y / trend[0].y) - 1) * 100, (v) => `${Math.abs(v).toFixed(0)}%`, "30-day average") : "";
  $("eff-key").innerHTML = hotKey(pts);
  drawChart("efficiency", "efficiency", {
    type: "scatter",
    data: { datasets: [
      { data: pts, ...dotStyle(pts, cssVar("--pace")) },
      { type: "line", data: trend, borderColor: cssVar("--pace"), borderWidth: 2, pointRadius: 0, tension: 0.3, spanGaps: GAP_MS },
    ] },
    options: opts,
  });
}

// ---------- heart rate at a fixed pace ----------
function renderHrPace() {
  const card = $("hrpace-card");
  if (!card) return;
  const u = Units.get();
  const paces = hrPaces(state.activities, u);
  card.hidden = !paces.length;
  if (!paces.length) return;
  const pick = hrPaceChoice(paces, u);
  $("hrpace-pick").innerHTML = paces.map((p) => `<option value="${p.sec}"${p === pick ? " selected" : ""}>${fmtPace(p.mps, u)}</option>`).join("");
  $("hrpace-pick").onchange = (e) => { saveHrPace(Number(e.target.value), u); renderHrPace(); };
  const all = state.activities
    .filter((a) => a.hr_by_speed?.length && isRun(a.activity_type))
    .map((a) => ({ x: localDate(a.start_time_local).getTime(), y: hrAtPace(a.hr_by_speed, pick.mps), a }))
    .filter((p) => p.y != null)
    .sort((p, q) => p.x - q.x);
  const start = rangeStart().getTime();
  const pts = all.filter((p) => p.x >= start);
  const trend = coolTrend(all, pts);
  if (trend.length > 1) {
    const change = trend.at(-1).y - trend[0].y;
    const flat = Math.abs(change) < 1;
    const since = state.range === "All" ? "since you started" : `over ${state.range}`;
    // lower is better: the same pace at a lower heart rate
    $("hrpace-head").innerHTML = `<span class="big">${Math.round(trend.at(-1).y)}<small>bpm</small></span>
      <span class="chg ${!flat && change < 0 ? "up" : ""}">${flat ? "Steady" : `${change > 0 ? "▲" : "▼"} ${Math.round(Math.abs(change))} bpm`} ${since}</span>
      <span class="dim">30-day average at ${fmtPace(pick.mps, u)}</span>`;
  } else $("hrpace-head").innerHTML = "";
  const opts = chartBase();
  opts.interaction = { mode: "nearest", intersect: false };
  timeAxis(opts);
  // whole beats only, and at least 10 bpm tall, so a steady stretch doesn't repeat labels
  opts.scales.y.ticks.precision = 0;
  opts.scales.y.ticks.callback = (v) => `${Math.round(v)} bpm`;
  const ys = pts.map((p) => p.y);
  if (ys.length) { const mid = (Math.min(...ys) + Math.max(...ys)) / 2; opts.scales.y.suggestedMin = mid - 5; opts.scales.y.suggestedMax = mid + 5; }
  const dotsAt = (e, chart) => chart.getElementsAtEventForMode(e.native, "nearest", { intersect: true }, false).filter((el) => el.datasetIndex === 0);
  opts.onClick = (e, _, chart) => { const hit = dotsAt(e, chart)[0]; if (hit) location.href = pageUrl("activity", { id: pts[hit.index].a.activity_id }); };
  opts.onHover = (e, _, chart) => clickCursor(e, dotsAt(e, chart));
  opts.plugins.tooltip = { callbacks: {
    title: (i) => new Date(i[0].parsed.x).toLocaleDateString(undefined, { dateStyle: "medium" }),
    label: (i) => i.datasetIndex === 0 ? `${i.raw.a.name}: ${Math.round(i.parsed.y)} bpm at ${fmtPace(pick.mps, u)}${hotNote(i.raw.a)}`
      : `30-day average: ${Math.round(i.parsed.y)} bpm`,
  } };
  $("hrpace-key").innerHTML = hotKey(pts);
  drawChart("hrpace", "hrpace", {
    type: "scatter",
    data: { datasets: [
      { data: pts, ...dotStyle(pts, cssVar("--hr")) },
      { type: "line", data: trend, borderColor: cssVar("--hr"), borderWidth: 2, pointRadius: 0, tension: 0.3, spanGaps: GAP_MS },
    ] },
    options: opts,
  });
}

// ---------- running form (cadence and running dynamics on easy runs) ----------
const FORM = [
  { key: "cadence_spm", label: "Cadence", unit: "spm", digits: 0, better: 1,
    hint: "Steps per minute on easy runs. A slightly higher cadence usually means shorter, lighter steps and less load on each landing." },
  { key: "stride_cm", label: "Stride", unit: "", digits: 2, better: 1, stride: true,
    hint: "Average stride length on easy runs. Longer strides at the same effort come with fitness and strength; it also grows with pace." },
  { key: "ground_contact_ms", label: "Contact", unit: "ms", digits: 0, better: -1,
    hint: "Ground contact time on easy runs: how long each foot stays on the ground. Shorter usually means a more elastic, efficient stride." },
  { key: "vertical_ratio_pct", label: "Vert. ratio", unit: "%", digits: 1, better: -1,
    hint: "Vertical ratio on easy runs: bounce divided by stride length. Lower means less energy spent going up and down for each meter forward." },
];
let formBy = "cadence_spm";
try { formBy = localStorage.getItem("formBy") || formBy; } catch {}
function renderForm() {
  const card = $("form-card");
  if (!card) return;
  const easy = new Set(["easy", "recovery", "long", "easy_strides"]);
  const runs = state.activities.filter((a) => isRun(a.activity_type) && easy.has(a.workout_type));
  const have = FORM.filter((f) => runs.filter((a) => a[f.key]).length >= 5);
  card.hidden = !have.length;
  if (!have.length) return;
  if (!have.some((f) => f.key === formBy)) formBy = have[0].key;
  const f = FORM.find((x) => x.key === formBy);
  $("form-by").hidden = have.length < 2;
  $("form-by").innerHTML = have.map((x) => `<button data-k="${x.key}" aria-pressed="${x.key === formBy}">${x.label}</button>`).join("");
  $("form-by").onclick = (e) => {
    const k = e.target.closest("button")?.dataset.k;
    if (!k) return;
    formBy = k; try { localStorage.setItem("formBy", k); } catch {}
    renderForm();
  };
  $("form-hint").textContent = f.hint;
  const imperial = Units.get() === "mi";
  const unit = f.stride ? (imperial ? "ft" : "m") : f.unit;
  const conv = (v) => (f.stride ? (imperial ? v / 30.48 : v / 100) : v);
  const all = runs.filter((a) => a[f.key]).map((a) => ({ x: localDate(a.start_time_local).getTime(), y: conv(a[f.key]), a })).sort((p, q) => p.x - q.x);
  const start = rangeStart().getTime();
  const pts = all.filter((p) => p.x >= start);
  const trend = pts.map((p) => {
    const win = all.filter((q) => q.x <= p.x && q.x > p.x - 30 * 864e5);
    return { x: p.x, y: win.reduce((s, q) => s + q.y, 0) / win.length };
  });
  const fmt = (v) => fmtNum(v, f.digits);
  if (trend.length > 1) {
    const change = trend.at(-1).y - trend[0].y;
    const flat = Math.abs(change) < Math.max(Math.abs(trend[0].y) * 0.01, 10 ** -f.digits);
    const since = state.range === "All" ? "since you started" : `over ${state.range}`;
    $("form-head").innerHTML = `<span class="big">${fmt(trend.at(-1).y)}<small>${unit}</small></span>
      <span class="chg ${!flat && Math.sign(change) === f.better ? "up" : ""}">${flat ? "Steady" : `${change > 0 ? "▲" : "▼"} ${fmt(Math.abs(change))} ${unit}`} ${since}</span>
      <span class="dim">30-day average</span>`;
  } else $("form-head").innerHTML = "";
  const opts = chartBase();
  opts.interaction = { mode: "nearest", intersect: false };
  timeAxis(opts);
  opts.scales.y.ticks.precision = f.digits;
  opts.scales.y.ticks.callback = (v) => `${fmtNum(v, f.digits)} ${unit}`;
  const dotsAt = (e, chart) => chart.getElementsAtEventForMode(e.native, "nearest", { intersect: true }, false).filter((el) => el.datasetIndex === 0);
  opts.onClick = (e, _, chart) => { const hit = dotsAt(e, chart)[0]; if (hit) location.href = pageUrl("activity", { id: pts[hit.index].a.activity_id }); };
  opts.onHover = (e, _, chart) => clickCursor(e, dotsAt(e, chart));
  opts.plugins.tooltip = { callbacks: {
    title: (i) => new Date(i[0].parsed.x).toLocaleDateString(undefined, { dateStyle: "medium" }),
    label: (i) => i.datasetIndex === 0 ? `${i.raw.a.name}: ${fmt(i.parsed.y)} ${unit} at ${fmtPace(i.raw.a.avg_speed_mps)}`
      : `30-day average: ${fmt(i.parsed.y)} ${unit}`,
  } };
  drawChart("runform", "runform", {
    type: "scatter",
    data: { datasets: [
      { data: pts, backgroundColor: cssVar("--cadence") + "66", pointRadius: 3, pointHoverRadius: 5 },
      { type: "line", data: trend, borderColor: cssVar("--cadence"), borderWidth: 2, pointRadius: 0, tension: 0.3, spanGaps: GAP_MS },
    ] },
    options: opts,
  });
}

// Big current value plus its change over the selected range
function headline(value, change, fmt, what) {
  const since = state.range === "All" ? "since you started" : `over ${state.range}`;
  const flat = Math.abs(change) < 0.05;
  return `<span class="big">${value}</span><span class="chg ${change > 0 && !flat ? "up" : ""}">${flat ? "Steady" : `${change > 0 ? "▲" : "▼"} ${fmt(change)}`} ${since}</span>
    <span class="dim">${what}</span>`;
}

// ---------- VO2 max ----------
function renderVo2() {
  if (!$("vo2")) return;
  const sports = [["running", "Running", "--pace"], ["cycling", "Cycling", "--gap"]].filter(([k]) => state.vo2.some((r) => r.sport === k));
  $("vo2-legend").innerHTML = sports.length > 1 ? sports.map(([, l, c]) => `<span style="--c:var(${c})">${l}</span>`).join("") : "";
  const opts = chartBase();
  opts.interaction = { mode: "nearest", intersect: false };
  timeAxis(opts);
  opts.scales.y.grace = "10%";
  opts.plugins.tooltip = { callbacks: {
    title: (i) => new Date(i[0].parsed.x).toLocaleDateString(undefined, { dateStyle: "medium" }),
    label: (i) => `${i.dataset.label}: ${i.parsed.y.toFixed(1)}`,
  } };
  const run = state.vo2.filter((r) => r.sport === "running" && inRange(r.date));
  $("vo2-head").innerHTML = run.length > 1 ? headline(run.at(-1).value.toFixed(1), run.at(-1).value - run[0].value, (v) => v.toFixed(1), "running") : "";
  drawChart("vo2", "vo2", {
    type: "line",
    data: { datasets: sports.map(([k, label, c]) => ({
      label, borderColor: cssVar(c), backgroundColor: cssVar(c), borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.2, spanGaps: WATCH_GAP_MS,
      data: state.vo2.filter((r) => r.sport === k && inRange(r.date)).map((r) => ({ x: new Date(r.date + "T12:00").getTime(), y: r.value })),
    })) },
    options: opts,
  });
}

// ---------- records ----------
const span = (e) => (e.start_t != null ? `${Math.round(e.start_t)}-${Math.round(e.start_t + e.seconds)}` : "");
function renderRecords() {
  if (!$("records")) return;
  const entries = Object.entries(state.records);
  const showRange = rangeDays() != null;
  $("range-best-head").hidden = !showRange;
  $("range-best-head").textContent = `Best, ${state.range}`;
  $("records").innerHTML = entries.length ? entries.map(([label, list]) => {
    const best = list[0];
    const inR = list.find((e) => inRange(e.date));
    const rangeCell = !inR ? `<span class="dim">–</span>`
      : inR === best ? `<span class="dim">same</span>`
      : `<a href="${pageUrl("activity", { id: inR.activity_id, t: span(inR) })}">${fmtDuration(inR.seconds)}</a> <span class="dim when">${fmtMonthYear(localDate(inR.date))}</span>`;
    return `<tr class="clickable" tabindex="0" data-id="${best.activity_id}" data-t="${span(best)}">
      <td>${esc(label)}</td><td class="num"><b>${fmtDuration(best.seconds)}</b></td>
      <td class="num">${fmtPace(best.meters / best.seconds)}</td>
      <td>${fmtDate(best.date)}</td>
      ${showRange ? `<td class="num">${rangeCell}</td>` : ""}</tr>`;
  }).join("") : `<tr><td colspan="5" class="empty">Records appear after your runs are synced and analyzed.</td></tr>`;
}

// Best time at each distance, year by year: how each year compares, whichever watch it was on
const YEAR_DISTANCES = ["1 mile", "5 km", "10 km", "Half marathon", "Marathon"];
const YEAR_SHORT = { "1 mile": "Mile", "5 km": "5K", "10 km": "10K", "Half marathon": "Half", "Marathon": "Full" };  // fits a phone
function renderRecordsByYear() {
  if (!$("records-years")) return;
  const cols = YEAR_DISTANCES.filter((l) => state.records[l]?.length);
  const years = [...new Set(cols.flatMap((l) => state.records[l].map((e) => e.date.slice(0, 4))))].sort().reverse();
  $("records-years-fold").hidden = years.length < 2;
  if (years.length < 2) return;
  $("records-years-head").innerHTML = `<tr><th>Year</th>${cols.map((l) => `<th class="num"><span class="wide-only">${esc(l)}</span><span class="narrow-only">${YEAR_SHORT[l]}</span></th>`).join("")}</tr>`;
  $("records-years").innerHTML = years.map((y) => `<tr><td>${y}</td>${cols.map((l) => {
    const list = state.records[l];
    const e = list.find((x) => x.date.startsWith(y));  // fastest first, so the year's best
    if (!e) return `<td class="num dim">–</td>`;
    const t = fmtDuration(e.seconds);
    return `<td class="num"><a href="${pageUrl("activity", { id: e.activity_id, t: span(e) })}" title="${esc(fmtDate(e.date))}">${e === list[0] ? `<b>${t}</b>` : t}</a></td>`;
  }).join("")}</tr>`).join("");
}

// Longest run, biggest week and month: all-time, and the best within the chart range
function renderMilestones() {
  if (!$("milestones")) return;
  const runs = state.activities.filter((a) => isRun(a.activity_type) && a.distance_m);
  if (!runs.length) { $("milestones").innerHTML = ""; return; }
  const u = Units.get();
  const sum = (keyOf) => {
    const m = new Map();
    for (const a of runs) { const k = keyOf(localDate(a.start_time_local)); m.set(k, (m.get(k) || 0) + a.distance_m); }
    return [...m.entries()].map(([k, meters]) => ({ k, meters }));
  };
  const top = (list, pred = () => true) => list.filter(pred).reduce((b, x) => (!b || x.meters > b.meters ? x : b), null);
  const start = rangeStart();
  const longest = top(runs.map((a) => ({ k: a.start_time_local, meters: a.distance_m, a })));
  const longestR = top(runs.map((a) => ({ k: a.start_time_local, meters: a.distance_m, a })), (x) => localDate(x.k) >= start);
  const weeks = sum((d) => isoDay(startOfWeek(d))), months = sum((d) => isoDay(startOfMonth(d)));
  const inR = (x) => new Date(x.k + "T12:00") >= startOfWeek(start);
  const d = (m) => `${fmtNum(dist(m, u), 1)} ${u}`;
  const weekName = (k) => `week of ${new Date(k + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  const monthName = (k) => new Date(k + "T12:00").toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const runLink = (x) => (x.a.has_streams ? `<a href="${pageUrl("activity", { id: x.a.activity_id })}">${fmtDate(x.k)}</a>` : fmtDate(x.k));
  const rows = [
    ["Longest run", longest, runLink(longest), longestR],
    ["Biggest week", top(weeks), weekName(top(weeks).k), top(weeks, inR)],
    ["Biggest month", top(months), monthName(top(months).k), top(months, inR)],
  ];
  const showRange = rangeDays() != null;
  $("milestones").innerHTML = rows.map(([label, best, when, rangeBest]) => `<div>
      <span class="ml">${label}</span><b>${d(best.meters)}</b><span class="dim">${when}</span>
      ${showRange && rangeBest && rangeBest.meters < best.meters ? `<span class="dim">Best in ${state.range}: ${d(rangeBest.meters)}</span>` : ""}</div>`).join("");
}

// ---------- settings ----------
function renderSettings() {
  if (!$("settings")) return;
  const s = state.settings;
  if (!s) return;
  const form = $("settings");
  for (const key of ["max_hr", "resting_hr", "lthr"]) {
    const input = form.elements[key];
    const source = s.sources[key];
    // Only values you set go in the box; Garmin's and estimates show as the placeholder.
    input.value = source === "you" ? Math.round(s[key]) : "";
    input.placeholder = s[key] ? Math.round(s[key]) : "not set";
    const src = input.closest("label").querySelector(".src");
    if (src) src.textContent = { garmin: "from Garmin", estimated: "estimated", default: "default", you: "set by you" }[source] || "";
  }
  form.elements.zone_system.value = s.zone_system || "threshold";
  if ($("hr-sum")) $("hr-sum").textContent = [s.max_hr && `Max ${Math.round(s.max_hr)}`, s.lthr && `threshold ${Math.round(s.lthr)}`,
    `${s.zone_system === "garmin" ? "Garmin" : "threshold"} zones`].filter(Boolean).join(" · ");
  // One strip with each zone as wide as its heart-rate span (resting HR to max HR)
  const last = s.zones.length - 1;
  const spans = s.zones.map((z, i) => {
    const lo = i === 0 ? Math.min(z.high - 10, s.resting_hr || z.high - 40) : z.low;
    const hi = i === last ? Math.max(z.low + 5, s.max_hr || z.low + 15) : z.high;
    return Math.max(1, hi - lo);
  });
  $("zones").className = "zones compact";
  const overridden = s.zone_system === "garmin" && !s.zone_floors;
  $("zones").innerHTML = `<p class="hint" style="margin:14px 0 0">${zoneBasis(s)}.${overridden
    ? " Garmin's own zones only apply with Garmin's heart-rate values; clear your values above to use them again." : ""}</p>
    <div class="zone-strip" aria-hidden="true">${spans.map((w, i) => `<div style="flex:${w};--c:var(--z${i + 1})"></div>`).join("")}</div>` +
    s.zones.map((z, i) => `<div class="zone-row"><div><span class="swatch" style="--c:var(--z${i + 1})"></span>Z${i + 1} ${esc(z.name)}</div>
        <div class="bar"></div><div class="val">${zoneRange(s.zones, i)} bpm</div></div>`).join("");
}

$("settings")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = Object.fromEntries(["max_hr", "resting_hr", "lthr"].map((k) => [k, f[k].value ? Number(f[k].value) : null]));
  body.zone_system = f.zone_system.value;
  setStatus("Saving and re-analyzing your workouts…");
  try {
    await busy(e.target.querySelector("button[type=submit]"), "Saving…", async () => {
      state.settings = await getJSON("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      await load();
    });
    setStatus("Settings saved. Zones and training load updated.");
  } catch (err) { setStatus(err.message, true); }
});
