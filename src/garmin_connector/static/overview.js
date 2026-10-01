// Overview page: training load, weekly volume, efficiency, VO2 max, records, activity list.

const PAGE_SIZE = 25;
const state = { activities: [], vo2: [], load: [], records: {}, settings: null, type: "run", shown: PAGE_SIZE };
const charts = {};

const filtered = () => state.activities.filter((a) =>
  state.type === "all" ? true : state.type === "run" ? isRun(a.activity_type) : a.activity_type === state.type);

function startOfWeek(d) { // Monday
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function drawChart(key, canvasId, config) {
  charts[key]?.destroy();
  charts[key] = new Chart($(canvasId), config);
}

// ---------- tiles ----------
function renderTiles() {
  const now = new Date();
  const periods = [
    ["This week", startOfWeek(now)],
    ["This month", new Date(now.getFullYear(), now.getMonth(), 1)],
    ["This year", new Date(now.getFullYear(), 0, 1)],
  ];
  const u = Units.get();
  const volume = periods.map(([label, from]) => {
    const list = filtered().filter((a) => localDate(a.start_time_local) >= from);
    const meters = list.reduce((t, a) => t + (a.distance_m || 0), 0);
    const secs = list.reduce((t, a) => t + (a.duration_s || 0), 0);
    return `<div class="tile"><div class="label">${label}</div>
      <div class="value">${dist(meters).toFixed(1)} ${u}</div>
      <div class="sub">${list.length} ${list.length === 1 ? "activity" : "activities"} · ${fmtDuration(secs) || "0:00"}</div></div>`;
  });
  const today = state.load.at(-1);
  const load = today ? [
    ["Fitness", today.fitness.toFixed(0), "6-week load"],
    ["Fatigue", today.fatigue.toFixed(0), "7-day load"],
    ["Form", (today.form > 0 ? "+" : "") + today.form.toFixed(0), today.form < -25 ? "Very fatigued" : today.form < -10 ? "Building fitness" : today.form <= 5 ? "Balanced" : "Fresh"],
  ].map(([l, v, s]) => `<div class="tile"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`) : [];
  $("tiles").innerHTML = [...volume, ...load].join("");
}

// ---------- training load ----------
function renderLoad() {
  const recent = state.load.slice(-182);
  const labels = recent.map((d) => new Date(d.date + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  const opts = chartBase();
  opts.plugins.tooltip = { callbacks: { label: (i) => `${i.dataset.label}: ${i.parsed.y.toFixed(0)}` } };
  drawChart("load", "load", {
    type: "line",
    data: { labels, datasets: [
      { label: "Fitness", data: recent.map((d) => d.fitness), borderColor: cssVar("--fitness"), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4 },
      { label: "Fatigue", data: recent.map((d) => d.fatigue), borderColor: cssVar("--fatigue"), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4 },
    ] },
    options: opts,
  });

  const formOpts = chartBase();
  formOpts.plugins.tooltip = { callbacks: { label: (i) => `Form: ${i.parsed.y > 0 ? "+" : ""}${i.parsed.y.toFixed(0)}` } };
  formOpts.scales.x.ticks.display = false;
  const fresh = cssVar("--fitness"), tired = cssVar("--hr");
  drawChart("form", "form", {
    type: "bar",
    data: { labels, datasets: [{ label: "Form", data: recent.map((d) => d.form),
      backgroundColor: recent.map((d) => (d.form >= 0 ? fresh : tired)), barPercentage: 1, categoryPercentage: 0.9 }] },
    options: formOpts,
  });
}

// ---------- weekly distance ----------
function renderWeekly() {
  const weeks = [];
  const w = startOfWeek(new Date());
  for (let i = 0; i < 26; i++) { weeks.unshift(new Date(w)); w.setDate(w.getDate() - 7); }
  const totals = new Map(weeks.map((d) => [d.getTime(), 0]));
  for (const a of filtered()) {
    const key = startOfWeek(localDate(a.start_time_local)).getTime();
    if (totals.has(key)) totals.set(key, totals.get(key) + dist(a.distance_m));
  }
  const u = Units.get();
  const opts = chartBase();
  opts.plugins.tooltip = { callbacks: { title: (i) => `Week of ${i[0].label}`, label: (i) => `${i.parsed.y.toFixed(1)} ${u}` } };
  opts.scales.y.ticks.callback = (v) => `${v} ${u}`;
  drawChart("weekly", "weekly", {
    type: "bar",
    data: { labels: weeks.map((d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" })),
      datasets: [{ data: [...totals.values()], backgroundColor: cssVar("--pace"), borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", maxBarThickness: 18 }] },
    options: opts,
  });
}

// ---------- efficiency ----------
function renderEfficiency() {
  const easyCeiling = state.settings ? state.settings.zones[1].high : 999;
  const pts = state.activities
    .filter((a) => isRun(a.activity_type) && a.efficiency && a.avg_hr && a.avg_hr < easyCeiling && !(a.cadence_lock > 0.2))
    .map((a) => ({ x: localDate(a.start_time_local).getTime(), y: a.efficiency, a }))
    .sort((p, q) => p.x - q.x);
  // 30-day rolling average, so the trend shows through day-to-day noise
  const trend = pts.map((p) => {
    const win = pts.filter((q) => q.x <= p.x && q.x > p.x - 30 * 864e5);
    return { x: p.x, y: win.reduce((s, q) => s + q.y, 0) / win.length };
  });
  const opts = chartBase();
  opts.interaction = { mode: "nearest", intersect: false };
  opts.scales.x.type = "linear";
  opts.scales.x.ticks.callback = (v) => new Date(v).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  if (pts.length) Object.assign(opts.scales.x, { min: pts[0].x, max: pts.at(-1).x });
  opts.scales.y.ticks.callback = (v) => `${v.toFixed(2)} m`;
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
  opts.scales.x.type = "linear";
  opts.scales.x.ticks.callback = (v) => new Date(v).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  opts.scales.y.grace = "10%";
  opts.plugins.tooltip = { callbacks: {
    title: (i) => new Date(i[0].parsed.x).toLocaleDateString(undefined, { dateStyle: "medium" }),
    label: (i) => `${i.dataset.label}: ${i.parsed.y.toFixed(1)}`,
  } };
  drawChart("vo2", "vo2", {
    type: "line",
    data: { datasets: sports.map(([k, label, c]) => ({
      label, borderColor: cssVar(c), backgroundColor: cssVar(c), borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.2,
      data: state.vo2.filter((r) => r.sport === k).map((r) => ({ x: new Date(r.date + "T12:00").getTime(), y: r.value })),
    })) },
    options: opts,
  });
}

// ---------- records ----------
function renderRecords() {
  const entries = Object.entries(state.records);
  $("records").innerHTML = entries.length ? entries.map(([label, list]) => {
    const best = list[0], second = list[1];
    return `<tr class="clickable" data-id="${best.activity_id}">
      <td>${esc(label)}</td><td class="num"><b>${fmtDuration(best.seconds)}</b></td>
      <td class="num">${fmtPace(best.meters / best.seconds)}</td>
      <td>${fmtDate(best.date)}</td>
      <td class="num">${second ? fmtDuration(second.seconds) : ""}</td></tr>`;
  }).join("") : `<tr><td colspan="5" class="empty">Records appear after your runs are synced and analyzed.</td></tr>`;
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
    const label = { garmin: "Garmin", estimated: "est.", default: "default" }[source];
    input.placeholder = s[key] && label ? `${Math.round(s[key])} (${label})` : "not set";
  }
  $("zones").innerHTML = `<p class="hint" style="margin-top:12px">${zoneBasis(s)}.</p>` +
    s.zones.map((z, i) => {
      const range = i === 0 ? `< ${z.high}` : i === s.zones.length - 1 ? `≥ ${z.low}` : `${z.low}–${z.high - 1}`;
      return `<div class="zone-row"><div>Z${i + 1} ${esc(z.name)}</div>
        <div class="bar"><div style="width:100%;background:var(--z${i + 1})"></div></div><div class="val">${range} bpm</div></div>`;
    }).join("");
}

$("settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = Object.fromEntries(["max_hr", "resting_hr", "lthr"].map((k) => [k, f[k].value ? Number(f[k].value) : null]));
  setStatus("Saving and re-analyzing…");
  try {
    state.settings = await getJSON("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await load();
    setStatus("Settings saved. Zones and training load updated.");
  } catch (err) { setStatus(err.message, true); }
});

// ---------- activities ----------
function renderTable() {
  const all = filtered(), list = all.slice(0, state.shown);
  $("more").hidden = all.length <= state.shown;
  $("more").textContent = `Show more (${all.length - state.shown} older)`;
  $("rows").innerHTML = list.length ? list.map((a) => `<tr class="${a.has_streams ? "clickable" : ""}" data-id="${a.activity_id}">
      <td>${fmtDate(a.start_time_local)}</td>
      <td class="name">${esc(a.name)}</td>
      <td>${esc(prettyType(a.activity_type))}</td>
      <td class="num">${fmtDist(a.distance_m)}</td>
      <td class="num">${fmtDuration(a.duration_s)}</td>
      <td class="num">${fmtPaceOrSpeed(a.avg_speed_mps, a.activity_type)}</td>
      <td class="num">${a.avg_hr ? Math.round(a.avg_hr) : ""}</td>
      <td>${a.has_streams ? `<span class="badge">${a.external_hr ? "Arm band / strap" : "Wrist"}</span>` : ""}</td>
      <td class="num">${a.trimp != null ? Math.round(a.trimp) : ""}</td>
      <td class="num">${a.decoupling_pct != null ? a.decoupling_pct.toFixed(1) + "%" : ""}</td>
    </tr>`).join("")
    : `<tr><td colspan="10" class="empty">No activities yet. Click <b>Sync now</b>, or run <code>garmin-connector sync</code>.</td></tr>`;
}

for (const id of ["rows", "records"]) {
  $(id).addEventListener("click", (e) => {
    const row = e.target.closest("tr.clickable");
    if (row) location.href = `/activity/${row.dataset.id}`;
  });
}

// ---------- page ----------
function populateTypes() {
  const types = [...new Set(state.activities.map((a) => a.activity_type).filter((t) => t && !isRun(t)))].sort();
  $("type").innerHTML = `<option value="run">Running</option><option value="all">All activities</option>` +
    types.map((t) => `<option value="${esc(t)}">${esc(prettyType(t))}</option>`).join("");
  $("type").value = state.type;
}

function render() {
  renderTiles(); renderLoad(); renderWeekly(); renderEfficiency(); renderVo2(); renderRecords(); renderSettings(); renderTable();
}

async function load() {
  const [acts, vo2, loadSeries, records, settings] = await Promise.all(
    ["/api/activities", "/api/vo2max", "/api/training-load", "/api/records", "/api/settings"].map((u) => getJSON(u)));
  Object.assign(state, { activities: acts, vo2, load: loadSeries, records, settings });
  populateTypes(); render();
}

$("sync").addEventListener("click", async () => {
  $("sync").disabled = true;
  setStatus("Syncing with Garmin Connect… (the first sync downloads every workout and can take a while)");
  try {
    const r = await getJSON("/api/sync", { method: "POST" });
    setStatus(`Synced ${r.activities} activities, downloaded ${r.fit_files} workout files, analyzed ${r.analyzed}.`);
    await load();
  } catch (err) { setStatus(err.message, true); }
  finally { $("sync").disabled = false; }
});

$("type").addEventListener("change", (e) => { state.type = e.target.value; state.shown = PAGE_SIZE; render(); });
$("more").addEventListener("click", () => { state.shown += 50; renderTable(); });
unitsToggle($("units"), render);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
load().catch((err) => setStatus(`Couldn't load data: ${err.message}`, true));
