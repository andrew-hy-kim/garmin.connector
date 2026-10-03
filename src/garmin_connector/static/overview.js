// Overview page: training load, volume, intensity, efficiency, VO2 max, records, activity list.

const PAGE_SIZE = 10;
const RANGES = [["3M", 91], ["6M", 182], ["1Y", 365], ["2Y", 730], ["5Y", 1826], ["All", null]];
const state = {
  activities: [], vo2: [], load: [], records: {}, settings: null, insights: [], type: "run",
  range: (() => { try { return localStorage.getItem("range") || "1Y"; } catch { return "1Y"; } })(),
  table: { search: "", workout: "all", when: "any", from: "", to: "", sort: "start_time_local", dir: -1, page: 0 },
};

// Form as a share of fitness -> state. Mirrors insights.FORM_STATES.
const FORM_STATES = [
  { key: "fresh", min: 0.10, label: "Fresh", color: "--fitness", text: "Rested. Good for racing; weeks of this means losing fitness." },
  { key: "neutral", min: -0.10, label: "Maintaining", color: "--elev", text: "Training and recovery balanced." },
  { key: "productive", min: -0.30, label: "Productive training", color: "--gap", text: "Carrying the fatigue that builds fitness." },
  { key: "overreaching", min: -Infinity, label: "Overreaching", color: "--hr", text: "Fatigue far above fitness; recover before more hard work." },
];
// Orange is too light for text on white; its numbers use the darker warning orange
const textColor = (st) => (st.key === "productive" ? "--warn-c" : st.color);
const formState = (d) => FORM_STATES.find((s) => (d.fitness > 1 ? d.form / d.fitness : 0) >= s.min);
const charts = {};

const filtered = () => state.activities.filter((a) =>
  state.type === "all" ? true : state.type === "run" ? isRun(a.activity_type) : a.activity_type === state.type);

function startOfWeek(d) { // Monday
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function drawChart(key, canvasId, config) {
  charts[key]?.destroy();
  charts[key] = new Chart($(canvasId), config);
}

// ---------- time range ----------
function rangeDays() { return (RANGES.find(([k]) => k === state.range) || RANGES[2])[1]; }

// First day shown on the charts.
function rangeStart() {
  const days = rangeDays();
  if (days) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - days + 1); return d; }
  const first = state.activities.at(-1);
  return first ? localDate(first.start_time_local) : new Date();
}
const inRange = (dateStr) => localDate(dateStr) >= rangeStart();

// Weekly bars up to about a year, monthly beyond that.
function buckets() {
  const start = rangeStart(), now = new Date();
  const monthly = (now - start) / 864e5 > 400;
  const keyOf = monthly ? startOfMonth : startOfWeek;
  const list = [];
  for (let d = keyOf(start); d <= now; d = monthly ? new Date(d.getFullYear(), d.getMonth() + 1, 1) : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7)) {
    list.push(d);
  }
  const index = new Map(list.map((d, i) => [d.getTime(), i]));
  const label = (d) => (monthly ? fmtMonthYear(d) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  return { monthly, list, labels: list.map(label), indexOf: (date) => index.get(keyOf(date).getTime()) };
}

function setupRange() {
  const el = $("range");
  if (!el) return;
  el.innerHTML = RANGES.map(([k]) => `<button data-r="${k}">${k}</button>`).join("");
  const sync = () => el.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.r === state.range));
  el.addEventListener("click", (e) => {
    if (!e.target.dataset.r) return;
    state.range = e.target.dataset.r;
    try { localStorage.setItem("range", state.range); } catch {}
    sync(); renderCharts();
    if (state.table.when === "range") { state.table.page = 0; renderTable(); }
  });
  sync();
}

// ---------- tiles ----------
function renderTiles() {
  if (!$("tiles")) return;
  const now = new Date();
  const week = startOfWeek(now);
  const periods = [
    ["This week", week, new Date(week.getFullYear(), week.getMonth(), week.getDate() - 7), "last week"],
    ["This month", startOfMonth(now), new Date(now.getFullYear(), now.getMonth() - 1, 1), "last month"],
    ["This year", new Date(now.getFullYear(), 0, 1), new Date(now.getFullYear() - 1, 0, 1), "last year"],
  ];
  const u = Units.get();
  const noun = (n) => (state.type === "run" ? (n === 1 ? "run" : "runs") : n === 1 ? "activity" : "activities");
  const total = (from, to) => {
    const list = filtered().filter((a) => { const d = localDate(a.start_time_local); return d >= from && (!to || d < to); });
    return { n: list.length, meters: list.reduce((t, a) => t + (a.distance_m || 0), 0), secs: list.reduce((t, a) => t + (a.duration_s || 0), 0) };
  };
  const distText = (m) => { const v = dist(m); return fmtNum(v, v >= 100 ? 0 : 1); };
  // With a plan running, this week's tile gets a ring: minutes done vs planned
  const planWeek = state.plan?.progress?.find((w) => w.status === "current");
  const volume = periods.map(([label, from, prevFrom, prevName], i) => {
    const t = total(from);
    const prev = total(prevFrom, from);
    let sub = t.n ? `${t.n} ${noun(t.n)} · ${fmtTotal(t.secs)}`
      : `Nothing yet${prev.n ? ` · ${prevName} ${distText(prev.meters)} ${u}` : ""}`;
    let ring = "";
    if (i === 0 && planWeek) {
      const share = Math.min(1, planWeek.done_minutes / (planWeek.planned_minutes || 1));
      ring = progressRing(share);
      sub = `${planWeek.done_minutes} of ${planWeek.planned_minutes} min planned`;
    }
    return `<div class="tile link ${ring ? "with-ring" : ""}" role="button" tabindex="0" data-from="${isoDay(from)}" title="List these ${noun(2)}"><div><div class="label">${label}</div>
      <div class="value">${distText(t.meters)}<small>${u}</small></div><div class="sub">${sub}</div></div>${ring}</div>`;
  });
  const today = state.load.at(-1);
  const weekAgo = state.load.at(-8);
  const delta = (k, goodWhenUp) => {
    if (!weekAgo) return "";
    const d = Math.round(today[k] - weekAgo[k]);
    if (!d) return "Same as last week";
    return `<span class="${goodWhenUp && d > 0 ? "up" : ""}">${d > 0 ? "▲" : "▼"} ${Math.abs(d)}</span> vs last week`;
  };
  const st = today && formState(today);
  const load = today && !$("readiness") ? [
    `<div class="tile"><div class="label">Fitness</div><div class="value">${today.fitness.toFixed(0)}</div><div class="sub">${delta("fitness", true)}</div></div>`,
    `<div class="tile"><div class="label">Fatigue</div><div class="value">${today.fatigue.toFixed(0)}</div><div class="sub">${delta("fatigue")}</div></div>`,
    `<div class="tile state" style="--c:var(${textColor(st)})"><div class="label">Form</div><div class="value">${(today.form > 0 ? "+" : "") + today.form.toFixed(0)}</div><div class="sub">${st.label}</div></div>`,
  ] : [];
  $("tiles").innerHTML = [...volume, ...load].join("");
  $("tiles").classList.toggle("six", volume.length + load.length === 6);
}

// A small Apple-Activity-style ring for a 0..1 share
function progressRing(share) {
  const r = 17, c = 2 * Math.PI * r;
  return `<svg class="ring" viewBox="0 0 44 44" role="img" aria-label="${Math.round(share * 100)}% of planned minutes">
    <circle cx="22" cy="22" r="${r}" fill="none" stroke="var(--fill-strong)" stroke-width="6"/>
    <circle cx="22" cy="22" r="${r}" fill="none" stroke="var(--good)" stroke-width="6" stroke-linecap="round"
      stroke-dasharray="${(share * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 22 22)"/></svg>`;
}

// Volume tiles open the activity list filtered to that week, month or year
function tileFilter(e) {
  const tile = e.target.closest(".tile.link");
  if (!tile || (e.type === "keydown" && e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  location.href = pageUrl("activities", { query: { from: tile.dataset.from, to: isoDay(new Date()) } });
}
$("tiles")?.addEventListener("click", tileFilter);
$("tiles")?.addEventListener("keydown", tileFilter);

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
      { label: "Fitness", data: recent.map((d) => d.fitness), borderColor: cssVar("--fitness"), backgroundColor: cssVar("--fitness") + "1f",
        fill: "origin", borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 4, order: 0 },
      // Fatigue jumps every workout; drawn lighter so the slower fitness trend stays readable
      { label: "Fatigue", data: recent.map((d) => d.fatigue), borderColor: cssVar("--fatigue") + "b3", borderWidth: 1.5,
        pointRadius: 0, pointHoverRadius: 4, order: 1 },
    ] },
    options: opts,
  });

  // Fitness needs about 6 weeks of history before form means anything; grey out that stretch.
  const warmupEnd = state.load.length ? isoDay(new Date(new Date(state.load[0].date + "T12:00").getTime() + 42 * 864e5)) : "";
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
    label: (i) => `Form: ${i.parsed.y > 0 ? "+" : ""}${i.parsed.y.toFixed(0)}`,
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
  const sign = (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}`;
  const scale = FORM_STATES.map((s) => `<div style="--c:var(${s.color})" class="${s === st ? "now" : ""}"><b>${s.label}</b>${
    s.key === "fresh" ? "above +10%" : s.key === "neutral" ? "−10% to +10%" : s.key === "productive" ? "−30% to −10%" : "below −30%"} of fitness</div>`).join("");
  $("explain").innerHTML = `
    <div class="verdict" style="--c:var(${textColor(st)})"><span class="big">${sign(today.form)}</span>
      <div><b>${st.label}</b><span>${st.text}</span></div></div>
    <div class="scale">${scale}</div>
    <div>Fitness is <b>${today.fitness.toFixed(0)}</b>${trend == null ? "" : Math.abs(trend) < 1 ? ", about the same as 6 weeks ago"
      : `, ${trend > 0 ? "up" : "down"} ${Math.abs(trend).toFixed(0)} from 6 weeks ago`}. Fatigue is <b>${today.fatigue.toFixed(0)}</b>.
      If you rested completely, form would be <b>${sign(proj[3].form)}</b> in 3 days and <b>${sign(proj[7].form)}</b> in 7${
      freshDay && st.key !== "fresh" ? ` (fresh after about ${freshDay} day${freshDay > 1 ? "s" : ""})` : ""}, while fitness would slip to ${proj[7].fitness.toFixed(0)}.</div>
    ${loadExtrasHtml()}
    <details class="more"><summary>What do fitness, fatigue and form mean?</summary>
      <p><b>Fitness</b> is the average training load you've carried per day over about 6 weeks: the endurance you've banked.
      <b>Fatigue</b> is the same over the last week: how tired that training has made you. Each workout's load comes from how long
      you spent at each heart rate, with hard minutes counting much more than easy ones.</p>
      <p><b>Monotony</b> is how similar your days were over the last week (average load over its spread). Varied days,
      hard and easy, keep it under 1.5; above 2, the same load day after day raises the risk of illness and overtraining.
      <b>Strain</b> is the week's load times its monotony.</p>
      <p><b>Form</b> is fitness minus fatigue. Building fitness means carrying some fatigue; resting before a race (a taper)
      trades a little fitness for a lot of freshness.</p></details>`;
}

function loadExtrasHtml() {
  const x = loadExtras(state.load);
  if (!x) return "";
  const mono = x.monotony >= 2 ? ["warn", "too uniform"] : x.monotony >= 1.5 ? ["warn", "a bit uniform"] : ["good", "nicely varied"];
  return `<div class="kv load-kv">
    <div><span>Monotony</span><b class="${mono[0] === "warn" ? "warn-text" : ""}">${x.monotony.toFixed(1)}</b><small>${mono[1]}</small></div>
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
function showPeriod(b, i) {
  const from = b.list[i];
  const to = b.monthly ? new Date(from.getFullYear(), from.getMonth() + 1, 1) : new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7);
  const last = new Date(to); last.setDate(last.getDate() - 1);
  location.href = pageUrl("activities", { query: { from: isoDay(from), to: isoDay(last) } });
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
  const trend = pts.map((p) => {
    const win = all.filter((q) => q.x <= p.x && q.x > p.x - 30 * 864e5);
    return { x: p.x, y: win.reduce((s, q) => s + q.y, 0) / win.length };
  });
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
      ? `${i.raw.a.name}: ${i.parsed.y.toFixed(2)} m/beat at ${Math.round(i.raw.a.avg_hr)} bpm`
      : `30-day average: ${i.parsed.y.toFixed(2)} m/beat`,
  } };
  $("eff-head").innerHTML = trend.length > 1 ? headline(`${trend.at(-1).y.toFixed(2)}<small>m/beat</small>`,
    ((trend.at(-1).y / trend[0].y) - 1) * 100, (v) => `${Math.abs(v).toFixed(0)}%`, "30-day average") : "";
  drawChart("efficiency", "efficiency", {
    type: "scatter",
    data: { datasets: [
      { data: pts, backgroundColor: cssVar("--pace") + "66", pointRadius: 3, pointHoverRadius: 5 },
      { type: "line", data: trend, borderColor: cssVar("--pace"), borderWidth: 2, pointRadius: 0, tension: 0.3 },
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
      label, borderColor: cssVar(c), backgroundColor: cssVar(c), borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.2,
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
  if (PHONE) renderPhoneZoneChoice(form, s);
  // One strip with each zone as wide as its heart-rate span (resting HR to max HR)
  const last = s.zones.length - 1;
  const spans = s.zones.map((z, i) => {
    const lo = i === 0 ? Math.min(z.high - 10, s.resting_hr || z.high - 40) : z.low;
    const hi = i === last ? Math.max(z.low + 5, s.max_hr || z.low + 15) : z.high;
    return Math.max(1, hi - lo);
  });
  $("zones").className = "zones compact";
  const overridden = s.zone_system === "garmin" && !s.zone_floors && !PHONE;
  $("zones").innerHTML = `<p class="hint" style="margin:14px 0 0">${zoneBasis(s)}.${overridden
    ? " Garmin's own zones only apply with Garmin's heart-rate values; clear your values above to use them again." : ""}</p>
    <div class="zone-strip" aria-hidden="true">${spans.map((w, i) => `<div style="flex:${w};--c:var(--z${i + 1})"></div>`).join("")}</div>` +
    s.zones.map((z, i) => `<div class="zone-row"><div><span class="swatch" style="--c:var(--z${i + 1})"></span>Z${i + 1} ${esc(z.name)}</div>
        <div class="bar"></div><div class="val">${zoneRange(s.zones, i)} bpm</div></div>`).join("");
}

// On the phone, heart-rate values are view-only but the zone system can be switched here.
function renderPhoneZoneChoice(form, s) {
  form.querySelectorAll("input").forEach((el) => { el.disabled = true; });
  const select = form.elements.zone_system;
  const options = s.zone_options;
  select.disabled = !options;
  const garminOpt = select.querySelector('option[value="garmin"]');
  garminOpt.disabled = !!options && !options.garmin;
  garminOpt.textContent = options && !options.garmin ? "Garmin (not available)" : "Garmin";
  const names = { threshold: "threshold-based (COROS-style)", garmin: "Garmin's" };
  let note;
  if (!options) {
    note = "To switch zones on the phone, update the app on your Mac (rerun the setup line) and sync once, then tap Update here.";
  } else if (s.zone_system !== s.mac_zone_system) {
    note = `Showing ${names[s.zone_system]} zones on this phone. Your Mac uses ${names[s.mac_zone_system]} zones; change it in the Mac dashboard too if you want both to match.`;
  } else {
    note = "Heart-rate values are set on your Mac. You can switch zones here; the choice is saved on this phone.";
  }
  $("phone-zone-note").textContent = note;
}

$("settings")?.addEventListener("change", async (e) => {
  if (!PHONE || e.target.name !== "zone_system") return;
  const value = e.target.value;
  window.PhoneData.setZoneSystem(value === state.settings.mac_zone_system ? null : value);
  state.settings = await getJSON("/api/settings");
  renderSettings();
});

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

// ---------- activities ----------
const WORKOUT_FILTERS = [
  ["all", "All types", null],
  ["easy", "Easy & recovery", ["easy", "recovery", "easy_strides"]],
  ["long", "Long runs", ["long"]],
  ["quality", "Any hard session", [...QUALITY]],
  ["tempo", "Tempo & threshold", ["tempo", "threshold", "progression", "intervals_threshold"]],
  ["vo2", "VO2 max & speed", ["intervals_vo2", "speed", "fartlek"]],
  ["race", "Races", ["race"]],
];

function tableRows() {
  const t = state.table;
  const types = (WORKOUT_FILTERS.find(([k]) => k === t.workout) || WORKOUT_FILTERS[0])[2];
  const now = new Date();
  let from = null, to = null;
  if (t.when === "range") from = rangeStart();
  else if (t.when === "30" || t.when === "90") { from = new Date(); from.setDate(from.getDate() - Number(t.when)); }
  else if (t.when === "year") from = new Date(now.getFullYear(), 0, 1);
  else if (t.when === "lastyear") { from = new Date(now.getFullYear() - 1, 0, 1); to = new Date(now.getFullYear(), 0, 1); }
  else if (t.when === "custom") {
    if (t.from) from = new Date(t.from + "T00:00");
    if (t.to) { to = new Date(t.to + "T00:00"); to.setDate(to.getDate() + 1); }
  }
  const q = t.search.trim().toLowerCase();
  const rows = filtered().filter((a) => {
    const d = localDate(a.start_time_local);
    return (!from || d >= from) && (!to || d < to) && (!types || types.includes(a.workout_type))
      && (!q || `${a.name || ""} ${a.workout_label || ""} ${prettyType(a.activity_type)}`.toLowerCase().includes(q));
  });
  const key = t.sort;
  rows.sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * t.dir;
  });
  return rows;
}

function renderTable() {
  if (!$("rows")) return;
  const t = state.table;
  const all = tableRows();
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  t.page = Math.min(t.page, pages - 1);
  const list = all.slice(t.page * PAGE_SIZE, (t.page + 1) * PAGE_SIZE);
  const meters = all.reduce((s, a) => s + (a.distance_m || 0), 0);
  const secs = all.reduce((s, a) => s + (a.duration_s || 0), 0);
  // Clear only shows when a filter is on
  const filtering = t.search || t.workout !== "all" || t.when !== "any" || t.sort !== "start_time_local" || t.dir !== -1;
  $("f-clear").hidden = !filtering;
  const sortValue = `${t.sort}:${t.dir}`;
  $("f-sort").value = [...$("f-sort").options].some((o) => o.value === sortValue) ? sortValue : "";
  $("f-summary").textContent = all.length
    ? `${fmtNum(all.length)} ${all.length === 1 ? "activity" : "activities"} · ${fmtNum(dist(meters), 1)} ${Units.get()} · ${fmtTotal(secs)}`
    : "No activities match these filters.";
  document.querySelectorAll("#table-head th.sortable").forEach((th) =>
    th.setAttribute("aria-sort", th.dataset.sort === t.sort ? (t.dir > 0 ? "ascending" : "descending") : "none"));
  // Sorted by date: group rows under week headings with that week's totals
  const byDate = t.sort === "start_time_local";
  const weekKey = (a) => isoDay(startOfWeek(localDate(a.start_time_local)));
  const weekTotals = new Map();
  if (byDate) for (const a of all) {
    const k = weekKey(a), w = weekTotals.get(k) || { n: 0, m: 0 };
    w.n += 1; w.m += a.distance_m || 0; weekTotals.set(k, w);
  }
  const thisWeek = isoDay(startOfWeek(new Date()));
  const lw = startOfWeek(new Date()); lw.setDate(lw.getDate() - 7); // calendar days, safe across clock changes
  const lastWeek = isoDay(lw);
  const weekName = (k) => {
    if (k === thisWeek) return "This week";
    if (k === lastWeek) return "Last week";
    const start = new Date(k + "T12:00"), end = new Date(start.getTime() + 6 * 864e5);
    const sameYear = start.getFullYear() === new Date().getFullYear();
    const f = (d, y) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(y ? { year: "numeric" } : {}) });
    return `${f(start)} – ${f(end, !sameYear)}`;
  };
  let lastKey = null;
  const header = (a) => {
    if (!byDate) return "";
    const k = weekKey(a);
    if (k === lastKey) return "";
    lastKey = k;
    const w = weekTotals.get(k);
    return `<tr class="group"><td colspan="11"><b>${weekName(k)}</b><span>${fmtNum(dist(w.m), 1)} ${Units.get()} · ${w.n} ${w.n === 1 ? (state.type === "run" ? "run" : "activity") : (state.type === "run" ? "runs" : "activities")}</span></td></tr>`;
  };
  $("rows").innerHTML = list.length ? list.map((a) => `${header(a)}<tr class="${a.has_streams ? "clickable" : ""}" ${a.has_streams ? 'tabindex="0"' : ""} data-id="${a.activity_id}">
      <td>${byDate ? fmtDate(a.start_time_local, { weekday: "short", month: "short", day: "numeric" }) : fmtDate(a.start_time_local)}</td>
      <td class="name">${esc(a.name)}</td>
      <td>${a.workout_label ? tagHtml(a.workout_label, QUALITY.has(a.workout_type), a.workout_type) : `<span class="dim">${esc(prettyType(a.activity_type))}</span>`}</td>
      <td class="num">${fmtDist(a.distance_m)}</td>
      <td class="num">${fmtDuration(a.duration_s)}</td>
      <td class="num">${fmtPaceOrSpeed(a.avg_speed_mps, a.activity_type)}</td>
      <td class="num">${a.avg_hr ? Math.round(a.avg_hr) : ""}</td>
      <td>${a.has_streams && a.avg_hr ? `<span class="badge">${a.external_hr ? "Arm band" : "Wrist"}</span>` : ""}</td>
      <td class="num">${a.trimp != null ? Math.round(a.trimp) : ""}</td>
      <td class="num">${a.decoupling_pct != null ? a.decoupling_pct.toFixed(1) + "%" : ""}</td>
      <td class="num">${a.vo2max_eff != null ? a.vo2max_eff.toFixed(1) : ""}</td>
    </tr>`).join("")
    : `<tr><td colspan="11" class="empty">${state.activities.length ? "No activities match these filters." : "No activities yet. Click <b>Sync now</b>, or run <code>garmin-connector sync</code>."}</td></tr>`;
  $("pager").innerHTML = all.length > PAGE_SIZE ? `
    <span>${t.page * PAGE_SIZE + 1}–${Math.min(all.length, (t.page + 1) * PAGE_SIZE)} of ${all.length}</span>
    <button data-p="-1" ${t.page === 0 ? "disabled" : ""}>‹ Newer</button>
    <button data-p="1" ${t.page >= pages - 1 ? "disabled" : ""}>Older ›</button>` : "";
}

function setupTable() {
  if (!$("rows")) return;
  const t = state.table;
  // Opened with filters from another page (a tile on Today, a bar on Progress)
  const q = new URLSearchParams(location.search);
  if (q.get("from") || q.get("to")) Object.assign(t, { when: "custom", from: q.get("from") || "", to: q.get("to") || "" });
  if (q.get("workout")) t.workout = q.get("workout");
  $("f-workout").innerHTML = WORKOUT_FILTERS.map(([k, label]) => `<option value="${k}">${label}</option>`).join("");
  $("f-workout").value = t.workout;
  if (t.when === "custom") { $("f-when").value = "custom"; $("f-custom").hidden = false; $("f-from").value = t.from; $("f-to").value = t.to; }
  const update = () => { t.page = 0; renderTable(); };
  let timer;
  $("f-search").addEventListener("input", (e) => { clearTimeout(timer); timer = setTimeout(() => { t.search = e.target.value; update(); }, 150); });
  $("f-workout").addEventListener("change", (e) => { t.workout = e.target.value; update(); });
  $("f-sort").addEventListener("change", (e) => {
    const [key, dir] = e.target.value.split(":");
    t.sort = key; t.dir = Number(dir); update();
  });
  $("f-when").addEventListener("change", (e) => { t.when = e.target.value; $("f-custom").hidden = t.when !== "custom"; update(); });
  $("f-from").addEventListener("change", (e) => { t.from = e.target.value; update(); });
  $("f-to").addEventListener("change", (e) => { t.to = e.target.value; update(); });
  $("f-clear").addEventListener("click", () => {
    Object.assign(t, { search: "", workout: "all", when: "any", from: "", to: "", sort: "start_time_local", dir: -1 });
    $("f-sort").value = "start_time_local:-1";
    $("f-search").value = ""; $("f-workout").value = "all"; $("f-when").value = "any";
    $("f-from").value = ""; $("f-to").value = ""; $("f-custom").hidden = true;
    update();
  });
  $("table-head").addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    if (t.sort === th.dataset.sort) t.dir = -t.dir;
    else { t.sort = th.dataset.sort; t.dir = th.dataset.sort === "name" || th.dataset.sort === "workout_label" ? 1 : -1; }
    update();
  });
  $("pager").addEventListener("click", (e) => {
    const step = Number(e.target.dataset.p);
    if (!step) return;
    t.page += step; renderTable();
    $("activities").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

for (const id of ["rows", "records", "races", "recent-list"]) {
  $(id)?.addEventListener("click", (e) => {
    const row = e.target.closest("tr.clickable");
    if (row && !e.target.closest("a")) location.href = pageUrl("activity", { id: row.dataset.id, t: row.dataset.t });
  });
  $(id)?.addEventListener("keydown", (e) => {
    const row = e.target.closest("tr.clickable");
    if (row && e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); location.href = pageUrl("activity", { id: row.dataset.id, t: row.dataset.t }); }
  });
}

// ---------- page ----------
function populateTypes() {
  if (!$("type")) return;
  const types = [...new Set(state.activities.map((a) => a.activity_type).filter((t) => t && !isRun(t)))].sort();
  $("type").innerHTML = `<option value="run">Running</option><option value="all">All activities</option>` +
    types.map((t) => `<option value="${esc(t)}">${esc(prettyType(t))}</option>`).join("");
  $("type").value = state.type;
}

// Everything that depends on the time range
function renderCharts() {
  renderMilestones();
  renderLoad(); renderVolume(); renderMix(); renderEfficiency(); renderVo2(); renderLongRuns(); renderRecords(); renderPerf(); renderRecovery(); renderGear();
}

// Did you run on day k of the plan week starting `start`?
function ranOn(start, k) {
  const d = new Date(start + "T12:00"); d.setDate(d.getDate() + k);
  const iso = isoDay(d);
  return state.activities.some((a) => isRun(a.activity_type) && a.start_time_local.startsWith(iso));
}

// This week of the training plan, or a prompt to set one up.
// Today's planned session, front and centre
function todayCard(d, done) {
  if (!d) return "";
  if (d.type === "rest") return `<div class="today-card rest"><span class="eyebrow">Today</span><b>Rest or cross-train</b>
    <span class="dim">Recovery is when the training sinks in.</span></div>`;
  const target = sessionTarget(d);
  return `<div class="today-card" style="--c:${typeColor(d.type)}">
    <span class="eyebrow">Today${done ? ` · <span class="tick">✓ Done</span>` : ""}</span>
    <b>${esc(d.title)}${d.minutes ? ` · ${d.minutes} min` : ""}</b>
    ${sessionDetails(d) ? `<span>${esc(sessionDetails(d))}</span>` : ""}${target ? `<span class="dim">${esc(target)}</span>` : ""}</div>`;
}

function renderWeekPlan() {
  if (!$("week-plan")) return;
  const el = $("week-plan");
  const p = state.plan && state.plan.plan;
  if (!p) {
    el.innerHTML = `<h2>Training plan</h2><p class="hint" style="margin:0">Pick a goal (aerobic base, VO2 max, threshold,
      coming back from a break…) and get a week-by-week plan built from your recent training.
      ${PHONE ? "Set one up in the dashboard on your Mac." : `<a href="${pageUrl("plan", { new: true })}">Set one up →</a>`}</p>`;
    return;
  }
  const prog = state.plan.progress;
  const i = Math.max(0, prog.findIndex((w) => w.status === "current"));
  const upcoming = prog.every((w) => w.status === "upcoming");
  const finished = prog.every((w) => w.status === "past");
  const w = p.weeks[finished ? p.weeks.length - 1 : upcoming ? 0 : i], pr = prog[w.week - 1];
  const todayIdx = (new Date().getDay() + 6) % 7;
  const startText = new Date(p.start + "T12:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  el.innerHTML = `<div class="toolbar"><h2 style="margin:0">${finished ? "Plan finished" : upcoming ? "Your plan" : "This week's plan"}</h2>
      <span class="spacer"></span><a href="${pageUrl("plan")}">Full plan ›</a></div>
    <p class="hint" style="margin:0"><b class="plan-goal">${esc(p.goal_label)}</b> · week ${w.week} of ${p.weeks.length}${upcoming ? `, starts ${startText}` : ""}
      · ${esc(w.focus)} · ${w.minutes} min planned${pr.status === "upcoming" ? ""
      : ` · ${pr.done_minutes} min done, ${pr.done_runs}/${pr.planned_runs} runs`}${finished ? ". Pick a new goal on the plan page." : ""}</p>
    ${!upcoming && !finished && !$("readiness") ? todayCard(w.days[todayIdx], ranOn(w.start, todayIdx)) : ""}
    <div class="this-week">${w.days.map((d, k) => `<div class="${d.type === "rest" ? "rest" : ""} ${!upcoming && !finished && k === todayIdx ? "today" : ""}"
        style="${d.type === "rest" ? "" : `--c:${typeColor(d.type)}`}">
      <b>${d.day}${ranOn(w.start, k) ? ` <span class="tick" title="Done">✓</span>` : ""}</b><span>${esc(d.title)}</span><span class="m">${d.minutes ? `${d.minutes} min` : ""}</span></div>`).join("")}</div>`;
}

// ---------- race predictor ----------
// The main prediction comes from VO2max shape and marathon shape (RUNALYZE's model); your
// fastest recent efforts scaled to each distance, and Garmin's prediction, sit alongside.
function renderRaces() {
  if (!$("races")) return;
  const rp = state.races;
  const card = $("races-card");
  card.hidden = !rp || !rp.races.some((r) => r.fitness_seconds || r.seconds || r.garmin_seconds);
  if (card.hidden) return;
  const months = Math.round(rp.trend_days / 30);
  $("races-chg-h").innerHTML = `vs ${months}<span class="wide-only"> months ago</span><span class="narrow-only"> mo</span>`;
  const table = $("races").closest("table");
  table.classList.toggle("no-garmin", !rp.races.some((r) => r.garmin_seconds));
  table.classList.toggle("no-effort", !rp.races.some((r) => r.seconds));
  $("races-hint").textContent = rp.vo2max
    ? `From your VO2max shape (${rp.vo2max.toFixed(1)}) and marathon shape (${rp.marathon_shape}%): long races are held back when your endurance is short of what they need. ${act()} a row to see your fastest recent stretch at that distance.`
    : `From your fastest stretches in the last ${rp.window_days} days, scaled to each distance. ${act()} a row to see the stretch it's based on.`;
  // negative = faster, which is good
  const change = (s) => (s == null ? `<span class="dim">–</span>` : Math.abs(s) < 5 ? `<span class="dim">same</span>`
    : `<span class="chg ${s < 0 ? "up" : ""}">${s < 0 ? "▼" : "▲"} ${fmtDuration(Math.abs(s))}</span>`);
  const dash = `<span class="dim">–</span>`;
  $("races").innerHTML = rp.races.map((r) => {
    const main = r.fitness_seconds || r.seconds;
    const chg = r.fitness_seconds ? r.fitness_change_s : r.change_s;
    const e = r.basis;
    const effort = r.seconds ? fmtDuration(r.seconds) : dash;
    const garmin = r.garmin_seconds ? fmtDuration(r.garmin_seconds) : dash;
    const mark = r.endurance_limited ? ` <span class="caveat" aria-label="limited by endurance, see note">*</span>` : "";
    const attrs = e ? `class="clickable" tabindex="0" data-id="${e.activity_id}" data-t="${span(e)}" title="${esc(`Fastest stretch: your ${e.label} ${e.race ? "race" : "effort"} on ${fmtDate(e.date, { month: "short", day: "numeric" })}`)}"` : "";
    return `<tr ${attrs}><td>${esc(r.race)}${mark}</td>
      <td class="num">${main ? `<b>${fmtDuration(main)}</b>` : dash}</td><td class="num">${main ? fmtPace(r.meters / main) : ""}</td>
      <td class="num">${main ? change(chg) : ""}</td><td class="num">${effort}</td><td class="num">${garmin}</td></tr>`;
  }).join("");
  const limited = rp.races.some((r) => r.endurance_limited);
  $("races-foot").innerHTML = [
    limited ? `<span class="caveat">*</span> Held back by endurance: your training so far supports these distances less well than your speed does. More weekly distance and long runs close the gap.` : "",
    rp.garmin_date ? `Garmin's prediction as of ${esc(fmtDate(rp.garmin_date, { month: "short", day: "numeric" }))}.` : "",
  ].filter(Boolean).join(" ");
  $("races-foot").hidden = !$("races-foot").innerHTML;
}

// ---------- suggested next workouts (in Coach notes) ----------
const NEXT_COUNTS = [3, 5, 7];
const nextCount = () => { try { return Number(localStorage.getItem("nextCount")) || 3; } catch { return 3; } };

function renderNextUp() {
  if (!$("next-up")) return;
  const el = $("next-up");
  const sg = state.suggestions;
  if (!sg || !sg.workouts.length) {
    el.innerHTML = sg && sg.basis ? `<h3 class="sub-h" style="margin-top:4px">Your next workouts</h3><p class="hint">${esc(sg.basis)}</p>` : "";
    return;
  }
  const n = Math.min(nextCount(), sg.workouts.length);
  const today = isoDay(new Date());
  const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return isoDay(d); })();
  const when = (w) => (w.date === today ? "Today" : w.date === tomorrow ? "Tomorrow"
    : new Date(w.date + "T12:00").toLocaleDateString(undefined, { weekday: "short" }));

  el.innerHTML = `<div class="toolbar" style="margin:4px 0 2px">
      <h3 class="sub-h" style="margin:0">Your next ${n === 1 ? "workout" : `${n} workouts`}</h3><span class="spacer"></span>
      <div class="seg" role="group" aria-label="How many workouts to suggest">${NEXT_COUNTS.map((c) =>
        `<button data-n="${c}" aria-pressed="${c === nextCount()}">${c}</button>`).join("")}</div></div>
    <p class="hint" style="margin-bottom:8px">${esc(sg.basis)}</p>
    <div class="nx-list">${sg.workouts.slice(0, n).map((w, k) => `<div class="nx" style="--c:${typeColor(w.type)}">
      <div class="when"><b>${when(w)}</b><span>${new Date(w.date + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></div>
      <div class="what"><b>${esc(w.title)}</b>${sessionDetails(w) ? `<div class="d">${esc(sessionDetails(w))}</div>` : ""}
        ${sessionTarget(w) ? `<div class="tgt">${esc(sessionTarget(w))}</div>` : ""}${
        k && sg.workouts[k - 1].why === w.why ? "" : `<div class="why">${esc(w.why)}</div>`}</div>
      <div class="mins">${w.minutes} min</div></div>`).join("")}</div>`;
}
$("next-up")?.addEventListener("click", (e) => {
  const n = Number(e.target.dataset.n);
  if (!n) return;
  try { localStorage.setItem("nextCount", n); } catch {}
  renderNextUp();
});

// ---------- statistics: totals by year, month or week ----------
let statsBy = (() => { try { return localStorage.getItem("statsBy") || "year"; } catch { return "year"; } })();
function renderStats() {
  const el = $("stats");
  if (!el) return;
  const u = Units.get();
  const runs = filtered();
  const keyOf = { year: (d) => `${d.getFullYear()}`, month: (d) => isoDay(startOfMonth(d)), week: (d) => isoDay(startOfWeek(d)) }[statsBy];
  const groups = new Map();
  for (const a of runs) {
    const d = localDate(a.start_time_local), k = keyOf(d);
    const g = groups.get(k) || { k, d, n: 0, m: 0, s: 0, moving: 0, hrS: 0, hrT: 0, up: 0, longest: 0, vo2: 0, vo2T: 0 };
    const secs = a.moving_duration_s || a.duration_s || 0;
    g.n++; g.m += a.distance_m || 0; g.s += a.duration_s || 0; g.moving += a.distance_m ? secs : 0;
    if (a.avg_hr) { g.hrS += a.avg_hr * secs; g.hrT += secs; }
    g.up += a.elevation_gain_m || 0; g.longest = Math.max(g.longest, a.distance_m || 0);
    if (a.vo2max_eff) { g.vo2 += a.vo2max_eff * secs; g.vo2T += secs; }
    groups.set(k, g);
  }
  const limit = { year: 99, month: 24, week: 26 }[statsBy];
  const rows = [...groups.values()].sort((a, b) => (a.k < b.k ? 1 : -1)).slice(0, limit);
  const best = Math.max(...rows.map((g) => g.m), 1);
  const label = (g) => statsBy === "year" ? g.k : statsBy === "month"
    ? g.d.toLocaleDateString(undefined, { month: "short", year: "numeric" })
    : `Week of ${new Date(g.k + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" })}`;
  const range = (g) => {
    if (statsBy === "year") return [`${g.k}-01-01`, `${g.k}-12-31`];
    const start = new Date(g.k + "T12:00");
    const end = statsBy === "month" ? new Date(start.getFullYear(), start.getMonth() + 1, 0) : new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    return [g.k, isoDay(end)];
  };
  $("stats-period-h").textContent = { year: "Year", month: "Month", week: "Week" }[statsBy];
  $("stats-hint").textContent = `${state.type === "run" ? "Your running" : "Your activities"} ${{ year: "by year", month: "over the last 24 months", week: "over the last 26 weeks" }[statsBy]}; the bar shows distance against your biggest ${statsBy}. ${act()} a row to list its runs.`;
  el.innerHTML = rows.map((g) => {
    const [from, to] = range(g);
    return `<tr class="clickable" tabindex="0" data-from="${from}" data-to="${to}">
      <td><b>${esc(label(g))}</b></td><td class="num">${fmtNum(g.n)}</td>
      <td class="num"><span class="sbar" style="width:${Math.round((g.m / best) * 56)}px"></span>${fmtNum(dist(g.m, u), dist(g.m, u) >= 100 ? 0 : 1)} ${u}</td>
      <td class="num">${fmtTotal(g.s)}</td><td class="num">${g.moving && g.m ? fmtPace(g.m / g.moving) : ""}</td>
      <td class="num">${g.hrT ? Math.round(g.hrS / g.hrT) : ""}</td><td class="num">${g.up ? fmtElev(g.up) : ""}</td>
      <td class="num">${fmtDist(g.longest, u, 1)}</td><td class="num">${g.vo2T ? (g.vo2 / g.vo2T).toFixed(1) : ""}</td></tr>`;
  }).join("") || `<tr><td colspan="9" class="empty">Nothing yet.</td></tr>`;
}
$("stats-by")?.addEventListener("click", (e) => {
  const by = e.target.dataset.by;
  if (!by) return;
  statsBy = by;
  try { localStorage.setItem("statsBy", by); } catch {}
  $("stats-by").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.by === by));
  renderStats();
});
$("stats-by")?.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.by === statsBy));
const openPeriod = (e) => {
  const row = e.target.closest("tr[data-from]");
  if (!row || (e.type === "keydown" && e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  location.href = pageUrl("activities", { query: { from: row.dataset.from, to: row.dataset.to } });
};
$("stats")?.addEventListener("click", openPeriod);
$("stats")?.addEventListener("keydown", openPeriod);

// ---------- Today: readiness, latest run, recent activities ----------
// Monotony and strain over the last 7 days, rest days until fresh, and the most load you
// can do today and stay balanced (RUNALYZE's calculations; same model as the charts).
function loadExtras(series) {
  if (!series || series.length < 7) return null;
  const week = series.slice(-7).map((d) => d.load);
  const avg = week.reduce((a, b) => a + b, 0) / 7;
  const sd = Math.sqrt(week.reduce((a, b) => a + (b - avg) ** 2, 0) / 7);
  const monotony = sd ? Math.min(10, avg / sd) : avg ? 10 : 0;
  const { fitness, fatigue } = series.at(-1);
  const la = 1 / 7, lc = 1 / 42;
  const restDays = fatigue > fitness && fatigue > 0 ? Math.ceil(Math.log(Math.max(1, fitness) / fatigue) / Math.log((1 - la) / (1 - lc))) : 0;
  const balanced = Math.max(0, (fitness * (1 - lc) - fatigue * (1 - la)) / (la - lc));
  return { monotony, strain: avg * 7 * monotony, weekLoad: avg * 7, restDays, balanced };
}

// Today's session: from the plan, else the first suggested workout if it's for today
function todaysSession() {
  const p = state.plan?.plan, prog = state.plan?.progress;
  if (p && prog) {
    const i = prog.findIndex((w) => w.status === "current");
    if (i >= 0) {
      const k = (new Date().getDay() + 6) % 7;
      return { session: p.weeks[i].days[k], from: "plan", done: ranOn(p.weeks[i].start, k) };
    }
  }
  const w = state.suggestions?.workouts?.[0];
  if (w && w.date === isoDay(new Date())) return { session: w, from: "suggestion", done: false };
  if (w) return { session: w, from: "next", done: false };
  return null;
}

const READY = {
  fresh: ["Fresh", "A good day for a hard session or a race."],
  neutral: ["Balanced", "Train normally: an easy run or your planned workout."],
  productive: ["Building", "You're carrying useful fatigue. Keep today easy unless a workout is planned."],
  overreaching: ["Tired", "Fatigue is high. Rest, or keep it short and very easy."],
};

function renderReadiness() {
  const el = $("readiness");
  if (!el) return;
  const today = state.load.at(-1);
  if (!today) { el.hidden = true; return; }
  el.hidden = false;
  const st = formState(today);
  const [word, advice] = READY[st.key];
  const x = loadExtras(state.load);
  const t = todaysSession();
  const sign = (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}`;
  const facts = [
    `Fitness <b>${today.fitness.toFixed(0)}</b>`, `Fatigue <b>${today.fatigue.toFixed(0)}</b>`,
    x && x.restDays ? `<b>${x.restDays}</b> easy day${x.restDays > 1 ? "s" : ""} to fresh` : "",
    x ? `Up to <b>${Math.round(x.balanced)}</b> load today stays balanced` : "",
  ].filter(Boolean);
  let session = "";
  if (t) {
    const d = t.session;
    session = d.type === "rest"
      ? `<div class="rd-session"><span class="eyebrow">Today${t.from === "plan" ? " · plan" : ""}</span><b>Rest or cross-train</b><span class="dim">Recovery is when the training sinks in.</span></div>`
      : `<div class="rd-session" style="--c:${typeColor(d.type)}"><span class="eyebrow">${t.from === "next"
          ? `Next up · ${esc(new Date(d.date + "T12:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }))}`
          : `Today${t.from === "plan" ? " · plan" : " · suggested"}`}${t.done ? ` · <span class="tick">✓ Done</span>` : ""}</span>
        <b>${esc(d.title)}${d.minutes ? ` · ${d.minutes} min` : ""}</b>${sessionDetails(d) ? `<span>${esc(sessionDetails(d))}</span>` : ""}
        ${sessionTarget(d) ? `<span class="dim">${esc(sessionTarget(d))}</span>` : ""}</div>`;
  }
  // recovery from the watch, when it records it
  const h = state.health;
  const recovery = [];
  if (h) {
    if (h.resting_hr) {
      const d = h.resting_hr_normal ? Math.round(h.resting_hr - h.resting_hr_normal) : 0;
      recovery.push(`Resting HR <b>${Math.round(h.resting_hr)}</b>${d >= 3 ? ` <em class="up-bad">+${d}</em>` : ""}`);
    }
    if (h.hrv) {
      const low = h.hrv_low && h.hrv < h.hrv_low;
      recovery.push(`HRV <b>${Math.round(h.hrv)}</b> ms${low ? ` <em class="up-bad">low</em>` : ""}`);
    }
    if (h.sleep_s) recovery.push(`Sleep <b>${fmtTotal(h.sleep_s)}</b>${h.sleep_score ? ` · ${Math.round(h.sleep_score)}` : ""}`);
    if (h.readiness) recovery.push(`Garmin readiness <b>${Math.round(h.readiness)}</b>`);
  }
  // recovery signals off your normal outrank what the training load says
  const strained = h && h.flags && h.flags.length;
  el.innerHTML = `<div class="rd-main" style="--c:var(${strained ? "--warn-c" : textColor(st)})">
      <span class="eyebrow">Readiness</span>
      <div class="rd-word"><b>${strained ? "Recovering" : word}</b><span class="rd-form" title="Form: fitness minus fatigue">Form ${sign(today.form)}</span></div>
      <p>${strained ? `${esc(h.flags.join(". "))}. Your training load says ${word.toLowerCase()}, but your body may still be recovering: keep today easy.` : advice}</p>
      <div class="rd-facts">${facts.map((f) => `<span>${f}</span>`).join("")}</div>
      ${recovery.length ? `<div class="rd-facts rd-recovery">${recovery.map((f) => `<span>${f}</span>`).join("")}</div>` : ""}
    </div>${session}`;
}

// A route drawn from the workout's GPS points: no map tiles needed, so it works offline
function routeSvg(lat, lon, color) {
  const pts = lat.map((y, i) => [lon[i], y]).filter(([x, y]) => x != null && y != null);
  if (pts.length < 2) return "";
  const k = Math.cos((pts[0][1] * Math.PI) / 180);
  const xs = pts.map((p) => p[0] * k), ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const span = Math.max(x1 - x0, y1 - y0) || 1, W = 100, pad = 6;
  const sx = (x) => pad + ((x - x0) / span) * (W - 2 * pad) + ((span - (x1 - x0)) / span) * (W - 2 * pad) / 2;
  const sy = (y) => pad + ((y1 - y) / span) * (W - 2 * pad) + ((span - (y1 - y0)) / span) * (W - 2 * pad) / 2;
  const step = Math.max(1, Math.floor(pts.length / 400));
  const d = pts.filter((_, i) => i % step === 0).map(([x, y], i) => `${i ? "L" : "M"}${sx(x * k).toFixed(1)} ${sy(y).toFixed(1)}`).join("");
  return `<svg class="mini-route" viewBox="0 0 ${W} ${W}" role="img" aria-label="Route"><path d="${d}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

let latestShown = null;
async function renderLatest() {
  const el = $("latest");
  if (!el) return;
  const a = state.activities.find((x) => isRun(x.activity_type)) || state.activities[0];
  if (!a) { el.hidden = true; return; }
  el.hidden = false;
  const u = Units.get();
  const color = a.workout_type ? typeColor(a.workout_type) : "var(--z2)";
  const stats = [
    ["Distance", fmtDist(a.distance_m)], ["Time", fmtDuration(a.moving_duration_s || a.duration_s)],
    [PACE_TYPES.test(a.activity_type || "") ? "Pace" : "Speed", fmtPaceOrSpeed(a.avg_speed_mps, a.activity_type)],
    ["Avg HR", a.avg_hr ? `${Math.round(a.avg_hr)} bpm` : ""], ["Load", a.trimp != null ? Math.round(a.trimp) : ""],
    ["VO2max", a.vo2max_eff ? a.vo2max_eff.toFixed(1) : ""],
  ].filter(([, v]) => v !== "" && v != null);
  const when = fmtDate(a.start_time_local, { weekday: "long", month: "short", day: "numeric" });
  const href = a.has_streams ? pageUrl("activity", { id: a.activity_id }) : null;
  el.innerHTML = `<div class="toolbar"><h2 style="margin:0">Latest run</h2><span class="spacer"></span>${href ? `<a href="${href}">Details ›</a>` : ""}</div>
    <div class="latest">
      <div class="latest-route" id="latest-route"></div>
      <div class="latest-main">
        <div class="latest-title"><b>${esc(a.name || prettyType(a.activity_type))}</b> ${a.workout_label ? tagHtml(a.workout_label, QUALITY.has(a.workout_type), a.workout_type) : ""}</div>
        <div class="dim">${esc(when)}</div>
        <div class="latest-stats">${stats.map(([k, v]) => `<div><span>${k}</span><b>${esc(String(v))}</b></div>`).join("")}</div>
        <div class="notes compact" id="latest-notes"></div>
      </div>
    </div>`;
  if (!a.has_streams) return;
  // the route and the run's coach notes come with its details
  const id = a.activity_id;
  latestShown = id;
  try {
    const d = await getJSON(`/api/activities/${id}`);
    if (latestShown !== id) return;
    if (d.streams?.lat) $("latest-route").innerHTML = routeSvg(d.streams.lat, d.streams.lon, color);
    const notes = (d.insights || []).filter((n) => !n.title.startsWith("Tagged:")).slice(0, 2);
    if (notes.length) renderNotes($("latest-notes"), notes);
  } catch {}
  $("latest-route").hidden = !$("latest-route").innerHTML;
}

function renderRecent() {
  const el = $("recent-list");
  if (!el) return;
  const list = filtered().slice(0, 6);
  el.innerHTML = list.length ? `<table class="recent-table"><tbody>${list.map((a) => `<tr class="${a.has_streams ? "clickable" : ""}" ${a.has_streams ? 'tabindex="0"' : ""} data-id="${a.activity_id}">
      <td class="when">${esc(fmtDate(a.start_time_local, { weekday: "short", month: "short", day: "numeric" }))}</td>
      <td class="name">${esc(a.name)}${a.workout_label ? `<div>${tagHtml(a.workout_label, QUALITY.has(a.workout_type), a.workout_type)}</div>` : ""}</td>
      <td class="num">${fmtDist(a.distance_m)}</td>
      <td class="num">${fmtPaceOrSpeed(a.avg_speed_mps, a.activity_type)}</td>
      <td class="num">${a.avg_hr ? `${Math.round(a.avg_hr)} bpm` : ""}</td></tr>`).join("")}</tbody></table>`
    : `<p class="hint">No activities yet.</p>`;
}

// ---------- Progress: shoes ----------
function renderGear() {
  const card = $("gear-card");
  if (!card) return;
  const list = state.gear || [];
  card.hidden = !list.length;
  if (!list.length) return;
  const u = Units.get();
  const row = (g) => {
    const share = g.share == null ? null : Math.min(1, g.share);
    const level = g.share >= 1 ? "over" : g.share >= 0.85 ? "near" : "";
    return `<div class="gear-row ${g.retired ? "retired" : ""}">
      <div class="g-name"><b>${esc(g.name)}</b><span class="dim">${[g.type, g.since ? `since ${fmtDate(g.since, { month: "short", year: "numeric" })}` : "", g.retired ? "retired" : ""].filter(Boolean).join(" · ")}</span></div>
      <div class="g-bar ${level}">${share == null ? "" : `<i style="width:${(share * 100).toFixed(0)}%"></i>`}</div>
      <div class="g-num"><b>${fmtNum(dist(g.total_m, u), 0)} ${u}</b>${g.limit_m ? `<span class="dim"> of ${fmtNum(dist(g.limit_m, u), 0)}</span>` : ""}
        <span class="dim">${g.activities ? `${fmtNum(g.activities)} runs` : ""}${g.month_m ? ` · ${fmtNum(dist(g.month_m, u), 0)} ${u} this month` : g.last_used ? ` · last ${fmtDate(g.last_used, { month: "short", day: "numeric" })}` : ""}</span></div>
    </div>`;
  };
  const active = list.filter((g) => !g.retired), retired = list.filter((g) => g.retired);
  $("gear").innerHTML = active.map(row).join("") +
    (retired.length ? `<details class="more"><summary>${retired.length} retired</summary>${retired.map(row).join("")}</details>` : "");
}

// ---------- Progress: recovery (resting HR, HRV, sleep) ----------
function renderRecovery() {
  const card = $("recovery-card");
  if (!card) return;
  const h = state.health;
  card.hidden = !h || !h.history?.length;
  if (card.hidden) return;
  const hist = h.history.filter((d) => inRange(d.date));
  const avg = (k, n) => { const v = h.history.slice(-n).map((d) => d[k]).filter(Boolean); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const rhr7 = avg("resting_hr", 7), hrv7 = avg("hrv", 7), sleep7 = avg("sleep_s", 7);
  $("recovery-kv").innerHTML = [
    ["Resting HR", rhr7 ? `${Math.round(rhr7)} bpm` : "–", h.resting_hr_normal ? `7-day average; your normal is ${Math.round(h.resting_hr_normal)}` : "7-day average"],
    ["HRV", hrv7 ? `${Math.round(hrv7)} ms` : "–", h.hrv_low ? `7-day average; normal range ${Math.round(h.hrv_low)}–${Math.round(h.hrv_high)}` : "7-day average"],
    ["Sleep", sleep7 ? fmtTotal(sleep7) : "–", "a night, over the last week"],
    ["Readiness", h.readiness ? `${Math.round(h.readiness)}` : "–", "Garmin's training readiness today"],
  ].map(([k, v, sub]) => `<div><span>${k}</span><b>${v}</b><small>${esc(sub)}</small></div>`).join("");
  const opts = chartBase();
  opts.interaction = { mode: "index", intersect: false };
  timeAxis(opts);
  opts.scales.y.title = { display: false };
  opts.scales.y.ticks.callback = (v) => `${v}`;
  opts.scales.y2 = { position: "right", grid: { display: false }, border: { display: false }, ticks: { color: cssVar("--text-muted"), callback: (v) => `${v} ms` } };
  opts.scales.y3 = { display: false, min: 0, max: 30 * 3600 };
  opts.plugins.tooltip = { callbacks: {
    title: (i) => new Date(i[0].parsed.x).toLocaleDateString(undefined, { dateStyle: "medium" }),
    label: (i) => (i.dataset.label === "Sleep" ? `Sleep: ${fmtTotal(i.parsed.y)}` : /range|night/.test(i.dataset.label) ? null
      : `${i.dataset.label} (7-day avg): ${Math.round(i.parsed.y)}${i.dataset.label === "HRV" ? " ms" : " bpm"}`),
  } };
  const pt = (k) => hist.filter((d) => d[k]).map((d) => ({ x: new Date(d.date + "T12:00").getTime(), y: d[k] }));
  // a 7-day average shows the trend through the night-to-night noise
  const smooth = (k) => { const p = pt(k); return p.map((q, i) => { const w = p.slice(Math.max(0, i - 6), i + 1); return { x: q.x, y: w.reduce((t, r) => t + r.y, 0) / w.length }; }); };
  const band = cssVar("--pace");
  drawChart("recovery", "recovery", {
    type: "line",
    data: { datasets: [
      { label: "HRV range low", yAxisID: "y2", data: pt("hrv_low"), borderWidth: 0, pointRadius: 0, fill: false },
      { label: "HRV range high", yAxisID: "y2", data: pt("hrv_high"), borderWidth: 0, pointRadius: 0, backgroundColor: band + "1c", fill: "-1" },
      { label: "Resting HR", data: smooth("resting_hr"), borderColor: cssVar("--hr"), borderWidth: 2.2, pointRadius: 0, tension: 0.3 },
      { label: "HRV", yAxisID: "y2", data: smooth("hrv"), borderColor: band, borderWidth: 2.2, pointRadius: 0, tension: 0.3 },
      { type: "scatter", label: "Resting HR (night)", data: pt("resting_hr"), backgroundColor: cssVar("--hr") + "40", pointRadius: 1.5 },
      { type: "scatter", label: "HRV (night)", yAxisID: "y2", data: pt("hrv"), backgroundColor: band + "40", pointRadius: 1.5 },
      { type: "bar", label: "Sleep", yAxisID: "y3", data: pt("sleep_s"), backgroundColor: cssVar("--elev") + "55", barPercentage: 1, categoryPercentage: 1, order: 9 },
    ] },
    options: opts,
  });
}

// ---------- Progress: VO2max shape, marathon shape, training paces ----------
function renderPerf() {
  const el = $("perf");
  if (!el) return;
  const p = state.perf;
  if (!p || !p.vo2max) {
    el.innerHTML = `<h2>Running fitness</h2><p class="hint">Appears once you have a few runs with heart rate.</p>`;
    $("paces-card") && ($("paces-card").hidden = true);
    return;
  }
  const ms = p.marathon_shape;
  const watch = state.vo2.filter((r) => r.sport === "running").at(-1);
  const chg = p.vo2max_change_4w;
  const shapeFor = (pct) => (pct >= 100 ? "the marathon" : pct >= 42 ? "the half marathon" : pct >= 17 ? "10K" : "5K");
  const u = Units.get();
  el.innerHTML = `<h2>Running fitness</h2>
    <p class="hint">Estimated from every run's pace and heart rate, like RUNALYZE does it${p.calibrated_by ? ", calibrated by your best race" : ""}.</p>
    <div class="perf-grid">
      <div class="perf-item">
        <span class="label">VO2max shape</span>
        <span class="big">${p.vo2max.toFixed(1)}</span>
        <span class="sub">${chg == null ? "" : Math.abs(chg) < 0.2 ? "Steady over 4 weeks" : `<span class="${chg > 0 ? "up" : ""}">${chg > 0 ? "▲" : "▼"} ${Math.abs(chg).toFixed(1)}</span> over 4 weeks`}${watch ? ` · watch says ${watch.value.toFixed(0)}` : ""}</span>
      </div>
      <div class="perf-item">
        <span class="label">Marathon shape</span>
        <span class="big">${ms.percent}<small>%</small></span>
        <span class="sub">Enough endurance for ${shapeFor(ms.percent)}</span>
        <div class="meter" role="img" aria-label="${ms.percent}% of marathon endurance"><div style="width:${Math.min(100, ms.percent)}%"></div>
          <i style="left:17%" title="10K"></i><i style="left:42.5%" title="Half"></i></div>
      </div>
      <div class="perf-item">
        <span class="label">Weekly distance</span>
        <span class="big">${fmtNum(dist(ms.weekly_km * 1000), 1)}<small>${u}</small></span>
        <span class="sub">${ms.weekly_percent}% of the ${fmtNum(dist(ms.weekly_target_km * 1000), 0)} ${u} a week a marathon at your VO2max calls for</span>
      </div>
      <div class="perf-item">
        <span class="label">Long runs</span>
        <span class="big">${ms.long_runs}</span>
        <span class="sub">over ${fmtNum(dist(13000), 1)} ${u} in 10 weeks; the target is about ${fmtNum(dist(ms.long_target_km * 1000), 0)} ${u}</span>
      </div>
    </div>
    <div class="legend" style="margin-top:14px"><span style="--c:var(--pace)">VO2max shape</span><span style="--c:var(--gap)">Watch VO2max</span><span style="--c:var(--elev)">Marathon shape %</span></div>
    <div class="chart-box"><canvas id="perf-chart" role="img" aria-label="VO2max shape and marathon shape over time"></canvas></div>
    <details class="more"><summary>How these are worked out</summary>
      <p><b>VO2max shape</b> is the average of each run's effective VO2max over 30 days, weighted by duration. For each run, your pace says how much oxygen it took, and your heart rate as a share of your max says what share of your maximum that was. Your watch's estimate is shown for comparison.</p>
      <p><b>Marathon shape</b> asks whether your training has the endurance for long races: your weekly distance over 6 months (two thirds) and your long runs over 13 km in the last 10 weeks (one third), against targets that grow with your VO2max. A 10K needs 17 %, a half marathon 42 %, a marathon 100 %. The race predictor uses both.</p></details>`;
  const h = p.history.filter((d) => inRange(d.date));
  const opts = chartBase();
  opts.interaction = { mode: "nearest", intersect: false };
  timeAxis(opts);
  opts.scales.y.grace = "8%";
  opts.scales.y2 = { position: "right", grid: { display: false }, border: { display: false }, min: 0,
    ticks: { color: cssVar("--text-muted"), callback: (v) => `${v}%` } };
  opts.plugins.tooltip = { callbacks: {
    title: (i) => new Date(i[0].parsed.x).toLocaleDateString(undefined, { dateStyle: "medium" }),
    label: (i) => `${i.dataset.label}: ${i.parsed.y.toFixed(i.datasetIndex === 2 ? 0 : 1)}${i.datasetIndex === 2 ? "%" : ""}`,
  } };
  drawChart("perf", "perf-chart", {
    type: "line",
    data: { datasets: [
      { label: "VO2max shape", data: h.map((d) => ({ x: new Date(d.date + "T12:00").getTime(), y: d.vo2max })),
        borderColor: cssVar("--pace"), borderWidth: 2.5, pointRadius: 0, tension: 0.25 },
      { label: "Watch VO2max", data: state.vo2.filter((r) => r.sport === "running" && inRange(r.date)).map((r) => ({ x: new Date(r.date + "T12:00").getTime(), y: r.value })),
        borderColor: cssVar("--gap"), borderWidth: 1.5, pointRadius: 0, borderDash: [4, 3], tension: 0.2 },
      { label: "Marathon shape", yAxisID: "y2", data: h.map((d) => ({ x: new Date(d.date + "T12:00").getTime(), y: d.marathon_shape })),
        borderColor: cssVar("--elev"), backgroundColor: cssVar("--elev") + "22", fill: "origin", borderWidth: 1.5, pointRadius: 0, tension: 0.25 },
    ] },
    options: opts,
  });
  renderPaces();
}

function renderPaces() {
  const el = $("paces");
  if (!el) return;
  const p = state.perf;
  $("paces-card").hidden = !p?.paces?.length;
  if (!p?.paces?.length) return;
  $("paces-hint").textContent = `From your VO2max shape of ${p.vo2max.toFixed(1)}, using Jack Daniels' training intensities. As your fitness changes, so do these.`;
  const zone = { easy: 2, marathon: 3, threshold: 4, interval: 5, repetition: 5 };
  el.innerHTML = p.paces.map((z) => `<div class="pace-row" style="--c:var(--z${zone[z.key]})">
      <b>${z.label}</b><span class="pace-range">${fmtPace(z.slow_mps, undefined, false)}–${fmtPace(z.fast_mps)}</span><span class="dim">${esc(z.about)}</span></div>`).join("");
}

function render() {
  // Nothing synced yet: a welcome card instead of empty charts (set first, so cards have their width)
  const empty = !state.activities.length;
  document.body.classList.toggle("no-data", empty);
  if ($("welcome")) $("welcome").hidden = !empty || PHONE;
  renderToday();
  renderReadiness(); renderLatest(); renderConsistency();
  renderTiles(); renderNextUp(); renderRaces(); renderWeekPlan(); renderExplain(); renderCompare();
  if ($("notes")) renderNotes($("notes"), $("readiness") ? state.insights.filter((n) => !n.title.startsWith("Form:")) : state.insights);
  renderRecent(); renderCharts(); renderStats(); renderSettings(); renderTable();
}

async function load() {
  const [acts, vo2, loadSeries, records, settings, notes, plan, suggestions, races, perf, health, gear] = await Promise.all(
    ["/api/activities", "/api/vo2max", "/api/training-load", "/api/records", "/api/settings", "/api/insights", "/api/plan"].map((u) => getJSON(u))
      .concat(["/api/suggestions", "/api/race-predictions", "/api/performance", "/api/health", "/api/gear"].map((u) => getJSON(u).catch(() => null))));
  Object.assign(state, { activities: acts, vo2, load: loadSeries, records, settings, insights: notes, plan, suggestions, races, perf, health, gear });
  populateTypes(); render(); ready();
  // Phone: confirm a data import that just happened
  try {
    const imp = JSON.parse(sessionStorage.getItem("phoneImported") || "null");
    sessionStorage.removeItem("phoneImported");
    if (imp) setStatus(imp.added == null ? `Imported ${fmtNum(imp.total)} activities.`
      : imp.added ? `Updated: ${imp.added} new ${imp.added === 1 ? "activity" : "activities"}.` : "Updated. You were already up to date.");
  } catch {}
  if ($("ai")) setupAiBox($("ai"), "overview");
}

$("welcome-sync")?.addEventListener("click", () => $("sync").click());
$("sync")?.addEventListener("click", async () => {
  const welcome = $("welcome-sync") || {};
  welcome.disabled = true;
  welcome.textContent = "Syncing… this can take a few minutes the first time";
  setStatus("Syncing with Garmin Connect…");
  try {
    const before = state.activities.length;
    await busy($("sync"), "Syncing…", () => getJSON("/api/sync", { method: "POST" }));
    await load();
    const added = state.activities.length - before;
    setStatus(added > 0 ? `Synced ${added} new ${added === 1 ? "activity" : "activities"}.` : "You're up to date. No new activities.");
  } catch (err) { setStatus(err.message, true); }
  finally { welcome.disabled = false; welcome.textContent = "Sync with Garmin"; }
});

$("type")?.addEventListener("change", (e) => { state.type = e.target.value; state.table.page = 0; render(); });
function renderToday() {
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const last = state.activities.find((a) => isRun(a.activity_type));
  let ago = "";
  if (last) {
    const days = Math.round((new Date(isoDay(new Date()) + "T12:00") - new Date(last.start_time_local.slice(0, 10) + "T12:00")) / 864e5);
    ago = days <= 0 ? "Last run today" : days === 1 ? "Last run yesterday" : `Last run ${days} days ago`;
  }
  $("today").textContent = ago ? `${today} · ${ago}` : today;
}
setupRange();
setupTable();
unitsToggle($("units"), render);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
load().catch((err) => { ready(); setStatus(`Couldn't load data: ${err.message}`, true); });
