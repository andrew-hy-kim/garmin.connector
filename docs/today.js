// Summary tiles (volume, cross-training, calories), the cross-training and calorie charts, sync trouble.

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
  const distText = (m) => { const v = dist(m); return fmtNum(v, v >= 100 || !v ? 0 : 1); };
  const volume = periods.map(([label, from, prevFrom, prevName], i) => {
    const t = total(from);
    const prev = total(prevFrom, from);
    let sub = t.n ? `${t.n} ${noun(t.n)} · ${fmtTotal(t.secs)}`
      : `Nothing yet${prev.n ? ` · ${prevName} ${distText(prev.meters)} ${u}` : ""}`;
    return `<div class="tile link" role="button" tabindex="0" data-from="${isoDay(from)}" title="List these ${noun(2)}"><div><div class="label">${label}</div>
      <div class="value">${distText(t.meters)}<small>${u}</small></div><div class="sub">${sub}</div></div></div>`;
  });
  const cross = state.type === "run" ? [crossTile(week, new Date(week.getFullYear(), week.getMonth(), week.getDate() - 7))] : [];
  $("tiles").innerHTML = [...volume, ...cross, calorieTile()].join("");
}


// ---------- cross-training ----------
// Everything that isn't a run, in four groups (it already counts toward base and fatigue)
const CROSS = [
  { label: "Strength", color: "--cadence", test: (t) => /strength|hiit|weight/.test(t), one: "strength", many: "strength" },
  { label: "Cycling", color: "--gap", test: (t) => /cycl|bik/.test(t), one: "ride", many: "rides" },
  { label: "Hiking & walking", color: "--z3", test: (t) => /hik|walk/.test(t), one: "hike or walk", many: "hikes & walks" },
  { label: "Yoga & other", color: "--elev", test: () => true, one: "other", many: "other" },
];
const crossGroup = (a) => (isRun(a.activity_type) ? -1 : CROSS.findIndex((g) => g.test(a.activity_type || "")));

function crossTile(from, prevFrom) {
  const sum = (lo, hi) => {
    const n = CROSS.map(() => 0);
    let secs = 0;
    for (const a of state.activities) {
      const g = crossGroup(a), d = localDate(a.start_time_local);
      if (g < 0 || d < lo || (hi && d >= hi)) continue;
      n[g]++; secs += a.duration_s || 0;
    }
    return { n, secs, count: n.reduce((t, v) => t + v, 0) };
  };
  const t = sum(from), prev = sum(prevFrom, from);
  const sub = t.count ? CROSS.map((g, k) => (t.n[k] ? `${t.n[k]} ${t.n[k] === 1 ? g.one : g.many}` : "")).filter(Boolean).join(" · ")
    : `Nothing yet${prev.count ? ` · last week ${fmtTotal(prev.secs)}` : ""}`;
  return `<div class="tile cross"><div><div class="label">Cross-training this week</div>
    <div class="value">${t.count ? fmtTotal(t.secs) : "0"}</div><div class="sub">${sub}</div></div></div>`;
}

function renderCross() {
  if (!$("cross")) return;
  const b = buckets();
  const hours = CROSS.map(() => b.list.map(() => 0));
  let sessions = 0;
  for (const a of state.activities) {
    const g = crossGroup(a);
    if (g < 0) continue;
    const i = b.indexOf(localDate(a.start_time_local));
    if (i == null) continue;
    hours[g][i] += (a.duration_s || 0) / 3600;
    sessions++;
  }
  const total = hours.flat().reduce((t, v) => t + v, 0);
  $("cross-card").hidden = !sessions;
  if (!sessions) return;
  const per = b.monthly ? "month" : "week";
  $("cross-legend").innerHTML = CROSS.map((g) => `<span style="--c:var(${g.color})">${g.label}</span>`).join("");
  $("cross-head").innerHTML = `<span class="big">${fmtNum(total / b.list.length, 1)}<small>h</small></span><span class="dim">a ${per} · ${sessions} sessions ${state.range === "All" ? "since you started" : `over ${state.range}`}</span>`;
  const opts = chartBase();
  opts.scales.x.stacked = true; opts.scales.y.stacked = true;
  opts.scales.y.ticks.callback = (v) => `${v} h`;
  opts.onClick = (e, els) => { if (els.length) showPeriod(b, els[0].index, { type: "all" }); };
  opts.onHover = clickCursor;
  opts.plugins.tooltip = { callbacks: {
    title: (i) => `${b.monthly ? "" : "Week of "}${i[0].label}`,
    label: (i) => (i.parsed.y ? `${i.dataset.label}: ${fmtTotal(i.parsed.y * 3600)}` : null),
  } };
  drawChart("cross", "cross", {
    type: "bar",
    data: { labels: b.labels,
      datasets: CROSS.map((g, k) => ({ label: g.label, data: hours[k], backgroundColor: cssVar(g.color),
        borderColor: cssVar("--surface-1"), borderWidth: { top: 2 }, maxBarThickness: 22 })) },
    options: opts,
  });
}

// Where training load comes from over the range: runs by workout tag, then the cross-training groups
function renderLoadSources() {
  if (!$("load-sources")) return;
  const runs = new Map(), cross = CROSS.map(() => 0);
  let total = 0;
  for (const a of state.activities) {
    if (!a.trimp || !inRange(a.start_time_local)) continue;
    total += a.trimp;
    const g = crossGroup(a);
    if (g >= 0) { cross[g] += a.trimp; continue; }
    const key = a.workout_label || "Other runs";
    const r = runs.get(key) || { load: 0, color: a.workout_type ? typeColor(a.workout_type) : "var(--z1)" };
    r.load += a.trimp;
    runs.set(key, r);
  }
  $("load-sources-fold").hidden = !total;
  if (!total) return;
  const runTotal = [...runs.values()].reduce((t, r) => t + r.load, 0);
  const pct = (v) => (v / total) * 100;
  const row = (label, load, color, cls = "") => `<tr class="${cls}"><td>${esc(label)}</td>
    <td class="bar"><i style="--w:${pct(load).toFixed(1)}%;--c:${color}"></i></td>
    <td class="num">${pct(load) < 1 ? "<1" : Math.round(pct(load))}%</td></tr>`;
  const rows = [];
  if (runTotal) {
    rows.push(row("Running", runTotal, "var(--pace)", "group"));
    for (const [label, r] of [...runs].sort((x, y) => y[1].load - x[1].load)) rows.push(row(label, r.load, r.color, "sub"));
  }
  CROSS.map((g, k) => [g, cross[k]]).filter(([, v]) => v).sort((x, y) => y[1] - x[1])
    .forEach(([g, v]) => rows.push(row(g.label, v, `var(${g.color})`, "group")));
  $("load-sources-range").textContent = state.range === "All" ? "since you started" : `over ${state.range}`;
  $("load-sources").innerHTML = rows.join("");
}

// ---------- active calories ----------
// What workouts burned beyond resting (Garmin's estimate; rougher for anything but runs)
const KCAL = [
  { label: "Running", color: "--pace", test: (a) => isRun(a.activity_type) },
  { label: "Cross-training", color: "--cadence", test: () => true },
];
const kcalGroup = (a) => KCAL.findIndex((g) => g.test(a));

function calorieTile() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 6);
  let todayKcal = 0, weekKcal = 0;
  for (const a of state.activities) {
    const d = localDate(a.start_time_local);
    if (d < weekAgo || !a.active_calories) continue;
    weekKcal += a.active_calories;
    if (d >= today) todayKcal += a.active_calories;
  }
  return `<div class="tile kcal" title="Estimated by your watch; rougher for strength and other cross-training">
    <div class="label">Active calories today</div>
    <div class="value">${fmtNum(todayKcal)}<small>kcal</small></div>
    <div class="sub">7-day average ${fmtNum(weekKcal / 7)} a day</div></div>`;
}

function renderCalories() {
  if (!$("kcal")) return;
  const b = buckets();
  const kcal = KCAL.map(() => b.list.map(() => 0));
  let any = false;
  for (const a of state.activities) {
    if (!a.active_calories || !inRange(a.start_time_local)) continue;
    const i = b.indexOf(localDate(a.start_time_local));
    if (i == null) continue;
    kcal[kcalGroup(a)][i] += a.active_calories;
    any = true;
  }
  $("kcal-card").hidden = !any;
  if (!any) return;
  // Each bar is a daily average, so weeks and months read the same (the current one counts only days so far)
  const now = new Date(), start = rangeStart();
  const days = b.list.map((from, i) => {
    const to = b.list[i + 1] || new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return Math.max(1, Math.round((to - Math.max(from, start)) / 864e5));
  });
  const perDay = kcal.map((row) => row.map((v, i) => Math.round(v / days[i])));
  const total = kcal.flat().reduce((t, v) => t + v, 0);
  const allDays = days.reduce((t, v) => t + v, 0);
  $("kcal-legend").innerHTML = KCAL.map((g) => `<span style="--c:var(${g.color})">${g.label}</span>`).join("");
  $("kcal-head").innerHTML = `<span class="big">${fmtNum(total / allDays)}<small>kcal</small></span><span class="dim">a day on average ${state.range === "All" ? "since you started" : `over ${state.range}`}</span>`;
  const opts = chartBase();
  opts.scales.x.stacked = true; opts.scales.y.stacked = true;
  opts.scales.y.ticks.callback = (v) => `${fmtNum(v)}`;
  opts.onClick = (e, els) => { if (els.length) showPeriod(b, els[0].index, { type: "all" }); };
  opts.onHover = clickCursor;
  opts.plugins.tooltip = { callbacks: {
    title: (i) => `${b.monthly ? "" : "Week of "}${i[0].label}: kcal a day`,
    label: (i) => (i.parsed.y ? `${i.dataset.label}: ${fmtNum(i.parsed.y)}` : null),
    footer: (i) => `${fmtNum(i.reduce((t, x) => t + x.parsed.y, 0))} kcal a day`,
  } };
  drawChart("kcal", "kcal", {
    type: "bar",
    data: { labels: b.labels,
      datasets: KCAL.map((g, k) => ({ label: g.label, data: perDay[k], backgroundColor: cssVar(g.color),
        borderColor: cssVar("--surface-1"), borderWidth: { top: 2 }, maxBarThickness: 22 })) },
    options: opts,
  });
}

// ---------- sync trouble ----------
// A sync that failed since the last good one: say so on the home page, with what to do about it
async function renderSyncAlert() {
  const el = $("sync-alert");
  if (!el || PHONE) return;
  let st = {};
  try { st = await getJSON("/api/sync"); } catch {}
  el.hidden = !st.error;
  if (!st.error) return;
  const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const msg = esc(st.error).replace(/`([^`]+)`/g, "<code>$1</code>");
  el.innerHTML = `<b>Syncing isn't working.</b> ${msg}<div class="sub">Last try ${when(st.error_at)}` +
    `${st.ok_at ? ` · last good sync ${when(st.ok_at)}` : ""}</div>`;
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


// ---------- load extras ----------
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
