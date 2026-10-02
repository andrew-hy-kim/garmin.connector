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
  const load = today ? [
    `<div class="tile"><div class="label">Fitness</div><div class="value">${today.fitness.toFixed(0)}</div><div class="sub">${delta("fitness", true)}</div></div>`,
    `<div class="tile"><div class="label">Fatigue</div><div class="value">${today.fatigue.toFixed(0)}</div><div class="sub">${delta("fatigue")}</div></div>`,
    `<div class="tile state" style="--c:var(${st.color})"><div class="label">Form</div><div class="value">${(today.form > 0 ? "+" : "") + today.form.toFixed(0)}</div><div class="sub">${st.label}</div></div>`,
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
  Object.assign(state.table, { when: "custom", from: tile.dataset.from, to: isoDay(new Date()), page: 0 });
  $("f-when").value = "custom"; $("f-custom").hidden = false;
  $("f-from").value = state.table.from; $("f-to").value = state.table.to;
  renderTable();
  $("activities").scrollIntoView({ behavior: "smooth", block: "start" });
}
$("tiles").addEventListener("click", tileFilter);
$("tiles").addEventListener("keydown", tileFilter);

// ---------- training load ----------
function renderLoad() {
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
    <div class="verdict" style="--c:var(${st.color})"><span class="big">${sign(today.form)}</span>
      <div><b>${st.label}</b><span>${st.text}</span></div></div>
    <div class="scale">${scale}</div>
    <div>Fitness is <b>${today.fitness.toFixed(0)}</b>${trend == null ? "" : Math.abs(trend) < 1 ? ", about the same as 6 weeks ago"
      : `, ${trend > 0 ? "up" : "down"} ${Math.abs(trend).toFixed(0)} from 6 weeks ago`}. Fatigue is <b>${today.fatigue.toFixed(0)}</b>.
      If you rested completely, form would be <b>${sign(proj[3].form)}</b> in 3 days and <b>${sign(proj[7].form)}</b> in 7${
      freshDay && st.key !== "fresh" ? ` (fresh after about ${freshDay} day${freshDay > 1 ? "s" : ""})` : ""}, while fitness would slip to ${proj[7].fitness.toFixed(0)}.</div>
    <details class="more"><summary>What do fitness, fatigue and form mean?</summary>
      <p><b>Fitness</b> is the average training load you've carried per day over about 6 weeks: the endurance you've banked.
      <b>Fatigue</b> is the same over the last week: how tired that training has made you. Each workout's load comes from how long
      you spent at each heart rate, with hard minutes counting much more than easy ones.</p>
      <p><b>Form</b> is fitness minus fatigue. Building fitness means carrying some fatigue; resting before a race (a taper)
      trades a little fitness for a lot of freshness.</p></details>`;
}

// Fitness now vs. earlier points and your all-time peak.
function renderCompare() {
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
  Object.assign(state.table, { when: "custom", from: isoDay(from), to: isoDay(last), page: 0 });
  $("f-when").value = "custom"; $("f-custom").hidden = false;
  $("f-from").value = state.table.from; $("f-to").value = state.table.to;
  renderTable();
  $("activities").scrollIntoView({ behavior: "smooth", block: "start" });
}
// Pointer cursor over clickable marks
const clickCursor = (e, els) => { e.native.target.style.cursor = els.length ? "pointer" : "default"; };

// ---------- consistency calendar ----------
function renderConsistency() {
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
let calTimer;
window.addEventListener("resize", () => { clearTimeout(calTimer); calTimer = setTimeout(() => state.activities.length && renderConsistency(), 150); });
$("cal").addEventListener("click", (e) => {
  const cell = e.target.closest("i.run.link");
  if (cell) location.href = pageUrl("activity", { id: cell.dataset.id });
});

// ---------- volume ----------
function renderVolume() {
  const b = buckets();
  const totals = b.list.map(() => 0);
  for (const a of filtered()) {
    const i = b.indexOf(localDate(a.start_time_local));
    if (i != null) totals[i] += dist(a.distance_m);
  }
  const u = Units.get();
  $("volume-title").textContent = b.monthly ? "Monthly distance" : "Weekly distance";
  const avg = totals.reduce((s, v) => s + v, 0) / (totals.length || 1);
  $("volume-hint").textContent = `Average ${avg.toFixed(1)} ${u} per ${b.monthly ? "month" : "week"} in this range. ${matchMedia("(hover: hover)").matches ? "Click" : "Tap"} a bar to list those runs.`;
  const opts = chartBase();
  opts.plugins.tooltip = { callbacks: { title: (i) => `${b.monthly ? "" : "Week of "}${i[0].label}`,
    label: (i) => `${i.parsed.y.toFixed(1)} ${u}${i.dataIndex === totals.length - 1 ? " so far" : ""}` } };
  opts.scales.y.ticks.callback = (v) => `${v} ${u}`;
  opts.onClick = (e, els) => { if (els.length) showPeriod(b, els[0].index); };
  opts.onHover = clickCursor;
  opts.plugins.tooltip.callbacks.footer = () => `Click to list these ${state.type === "run" ? "runs" : "activities"}`;
  drawChart("weekly", "weekly", {
    type: "bar",
    // the current week or month is still in progress: drawn lighter
    data: { labels: b.labels, datasets: [{ data: totals, backgroundColor: ((c) => totals.map((_, i) => c + (i === totals.length - 1 ? "66" : "")))(cssVar("--pace")),
      borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", maxBarThickness: 18 }] },
    options: opts,
  });
}

// ---------- intensity mix ----------
const MIX = [["Easy", "--z2"], ["Tempo", "--z3"], ["Threshold", "--z4"], ["VO2 max", "--z5"]];
function renderMix() {
  const b = buckets();
  const mins = MIX.map(() => b.list.map(() => 0));
  for (const a of state.activities) {
    if (!isRun(a.activity_type) || !a.intensity_seconds) continue;
    const i = b.indexOf(localDate(a.start_time_local));
    if (i == null) continue;
    a.intensity_seconds.forEach((s, k) => { mins[k][i] += s / 60; });
  }
  $("mix-legend").innerHTML = MIX.map(([l, c]) => `<span style="--c:var(${c})">${l}</span>`).join("");
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
  drawChart("efficiency", "efficiency", {
    type: "scatter",
    data: { datasets: [
      { data: pts, backgroundColor: cssVar("--pace") + "66", pointRadius: 3, pointHoverRadius: 5 },
      { type: "line", data: trend, borderColor: cssVar("--pace"), borderWidth: 2, pointRadius: 0, tension: 0.3 },
    ] },
    options: opts,
  });
}

// ---------- VO2 max ----------
function renderVo2() {
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

$("settings").addEventListener("change", async (e) => {
  if (!PHONE || e.target.name !== "zone_system") return;
  const value = e.target.value;
  window.PhoneData.setZoneSystem(value === state.settings.mac_zone_system ? null : value);
  state.settings = await getJSON("/api/settings");
  renderSettings();
});

$("settings").addEventListener("submit", async (e) => {
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
      && (!q || (a.name || "").toLowerCase().includes(q));
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
  const lastWeek = isoDay(new Date(startOfWeek(new Date()).getTime() - 7 * 864e5));
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
    return `<tr class="group"><td colspan="10"><b>${weekName(k)}</b><span>${fmtNum(dist(w.m), 1)} ${Units.get()} · ${w.n} ${w.n === 1 ? (state.type === "run" ? "run" : "activity") : (state.type === "run" ? "runs" : "activities")}</span></td></tr>`;
  };
  $("rows").innerHTML = list.length ? list.map((a) => `${header(a)}<tr class="${a.has_streams ? "clickable" : ""}" ${a.has_streams ? 'tabindex="0"' : ""} data-id="${a.activity_id}">
      <td>${byDate ? fmtDate(a.start_time_local, { weekday: "short", month: "short", day: "numeric" }) : fmtDate(a.start_time_local)}</td>
      <td class="name">${esc(a.name)}</td>
      <td>${a.workout_label ? tagHtml(a.workout_label, QUALITY.has(a.workout_type), a.workout_type) : `<span class="dim">${esc(prettyType(a.activity_type))}</span>`}</td>
      <td class="num">${fmtDist(a.distance_m)}</td>
      <td class="num">${fmtDuration(a.duration_s)}</td>
      <td class="num">${fmtPaceOrSpeed(a.avg_speed_mps, a.activity_type)}</td>
      <td class="num">${a.avg_hr ? Math.round(a.avg_hr) : ""}</td>
      <td>${a.has_streams ? `<span class="badge">${a.external_hr ? "Arm band" : "Wrist"}</span>` : ""}</td>
      <td class="num">${a.trimp != null ? Math.round(a.trimp) : ""}</td>
      <td class="num">${a.decoupling_pct != null ? a.decoupling_pct.toFixed(1) + "%" : ""}</td>
    </tr>`).join("")
    : `<tr><td colspan="10" class="empty">${state.activities.length ? "No activities match these filters." : "No activities yet. Click <b>Sync now</b>, or run <code>garmin-connector sync</code>."}</td></tr>`;
  $("pager").innerHTML = all.length > PAGE_SIZE ? `
    <span>${t.page * PAGE_SIZE + 1}–${Math.min(all.length, (t.page + 1) * PAGE_SIZE)} of ${all.length}</span>
    <button data-p="-1" ${t.page === 0 ? "disabled" : ""}>‹ Newer</button>
    <button data-p="1" ${t.page >= pages - 1 ? "disabled" : ""}>Older ›</button>` : "";
}

function setupTable() {
  const t = state.table;
  $("f-workout").innerHTML = WORKOUT_FILTERS.map(([k, label]) => `<option value="${k}">${label}</option>`).join("");
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

for (const id of ["rows", "records"]) {
  $(id).addEventListener("click", (e) => {
    const row = e.target.closest("tr.clickable");
    if (row && !e.target.closest("a")) location.href = pageUrl("activity", { id: row.dataset.id, t: row.dataset.t });
  });
  $(id).addEventListener("keydown", (e) => {
    const row = e.target.closest("tr.clickable");
    if (row && e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); location.href = pageUrl("activity", { id: row.dataset.id, t: row.dataset.t }); }
  });
}

// ---------- page ----------
function populateTypes() {
  const types = [...new Set(state.activities.map((a) => a.activity_type).filter((t) => t && !isRun(t)))].sort();
  $("type").innerHTML = `<option value="run">Running</option><option value="all">All activities</option>` +
    types.map((t) => `<option value="${esc(t)}">${esc(prettyType(t))}</option>`).join("");
  $("type").value = state.type;
}

// Everything that depends on the time range
function renderCharts() {
  renderMilestones();
  renderLoad(); renderVolume(); renderMix(); renderEfficiency(); renderVo2(); renderRecords();
}

// Did you run on day k of the plan week starting `start`?
function ranOn(start, k) {
  const d = new Date(start + "T12:00"); d.setDate(d.getDate() + k);
  const iso = isoDay(d);
  return state.activities.some((a) => isRun(a.activity_type) && a.start_time_local.startsWith(iso));
}

// This week of the training plan, or a prompt to set one up.
function renderWeekPlan() {
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
    <div class="this-week">${w.days.map((d, k) => `<div class="${d.type === "rest" ? "rest" : ""} ${!upcoming && !finished && k === todayIdx ? "today" : ""}"
        style="${d.type === "rest" ? "" : `--c:${typeColor(d.type)}`}">
      <b>${d.day}${ranOn(w.start, k) ? ` <span class="tick" title="Done">✓</span>` : ""}</b><span>${esc(d.title)}</span><span class="m">${d.minutes ? `${d.minutes} min` : ""}</span></div>`).join("")}</div>`;
}

function render() {
  renderToday();
  renderConsistency();
  // Nothing synced yet: a welcome card instead of empty charts
  const empty = !state.activities.length;
  document.body.classList.toggle("no-data", empty);
  $("welcome").hidden = !empty || PHONE;
  renderTiles(); renderNotes($("notes"), state.insights); renderWeekPlan(); renderExplain(); renderCompare();
  renderCharts(); renderSettings(); renderTable();
}

async function load() {
  const [acts, vo2, loadSeries, records, settings, notes, plan] = await Promise.all(
    ["/api/activities", "/api/vo2max", "/api/training-load", "/api/records", "/api/settings", "/api/insights", "/api/plan"].map((u) => getJSON(u)));
  Object.assign(state, { activities: acts, vo2, load: loadSeries, records, settings, insights: notes, plan });
  populateTypes(); render(); ready();
  setupAiBox($("ai"), "overview");
}

$("welcome-sync").addEventListener("click", () => $("sync").click());
$("sync").addEventListener("click", async () => {
  $("welcome-sync").disabled = true;
  $("welcome-sync").textContent = "Syncing… this can take a few minutes the first time";
  setStatus("Syncing with Garmin Connect…");
  try {
    const before = state.activities.length;
    await busy($("sync"), "Syncing…", () => getJSON("/api/sync", { method: "POST" }));
    await load();
    const added = state.activities.length - before;
    setStatus(added > 0 ? `Synced ${added} new ${added === 1 ? "activity" : "activities"}.` : "You're up to date. No new activities.");
  } catch (err) { setStatus(err.message, true); }
  finally { $("welcome-sync").disabled = false; $("welcome-sync").textContent = "Sync with Garmin"; }
});

$("type").addEventListener("change", (e) => { state.type = e.target.value; state.table.page = 0; render(); });
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
