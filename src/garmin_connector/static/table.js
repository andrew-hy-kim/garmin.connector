// The activity list: filters, sorting and paging.

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
      && (t.source === "all" || (t.source === "apple") === isApple(a.activity_id))
      && (!q || `${a.name || ""} ${a.workout_label || ""} ${prettyType(a.activity_type)} ${isApple(a.activity_id) ? "apple watch" : ""}`.toLowerCase().includes(q));
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
  const filtering = t.search || t.workout !== "all" || t.source !== "all" || t.when !== "any" || t.sort !== "start_time_local" || t.dir !== -1;
  $("f-clear").hidden = !filtering;
  // Which watch: only worth a menu once there are Apple Watch workouts too
  $("f-source").hidden = !state.activities.some((a) => isApple(a.activity_id));
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
    return `<tr class="group"><td colspan="12"><b>${weekName(k)}</b><span>${fmtNum(dist(w.m), 1)} ${Units.get()} · ${w.n} ${w.n === 1 ? (state.type === "run" ? "run" : "activity") : (state.type === "run" ? "runs" : "activities")}</span></td></tr>`;
  };
  $("rows").innerHTML = list.length ? list.map((a) => `${header(a)}<tr class="${a.has_streams ? "clickable" : ""}" ${a.has_streams ? 'tabindex="0"' : ""} data-id="${a.activity_id}">
      <td>${byDate ? fmtDate(a.start_time_local, { weekday: "short", month: "short", day: "numeric" }) : fmtDate(a.start_time_local)}</td>
      <td class="name">${esc(a.name)}${isApple(a.activity_id) ? ' <span class="badge">Apple Watch</span>' : ""}</td>
      <td>${a.workout_label ? tagHtml(a.workout_label, QUALITY.has(a.workout_type), a.workout_type) : `<span class="dim">${esc(prettyType(a.activity_type))}</span>`}</td>
      <td class="num">${fmtDist(a.distance_m)}</td>
      <td class="num">${fmtDuration(a.duration_s)}</td>
      <td class="num">${a.weather?.temp_c != null ? `<span class="narrow-only wx${isHot(a) ? " hot" : ""}">${fmtTemp(a.weather.temp_c)} · </span>` : ""}${fmtPaceOrSpeed(a.avg_speed_mps, a.activity_type)}</td>
      <td class="num">${a.avg_hr ? Math.round(a.avg_hr) : ""}</td>
      <td>${a.has_streams && a.avg_hr ? `<span class="badge">${a.external_hr ? "Arm band" : "Wrist"}</span>` : ""}</td>
      <td class="num">${a.trimp != null ? Math.round(a.trimp) : ""}</td>
      <td class="num">${a.decoupling_pct != null ? a.decoupling_pct.toFixed(1) + "%" : ""}</td>
      <td class="num">${a.vo2max_eff != null ? a.vo2max_eff.toFixed(1) : ""}</td>
      <td class="wx">${a.weather?.indoor ? '<span class="dim">Indoor</span>' : weatherShort(a.weather)}</td>
    </tr>`).join("")
    : `<tr><td colspan="12" class="empty">${state.activities.length ? "No activities match these filters." : "No activities yet. Click <b>Sync now</b>, or run <code>garmin sync</code>."}</td></tr>`;
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
  if (q.get("type")) state.type = q.get("type");
  $("f-workout").innerHTML = WORKOUT_FILTERS.map(([k, label]) => `<option value="${k}">${label}</option>`).join("");
  $("f-workout").value = t.workout;
  $("f-source").addEventListener("change", (e) => { t.source = e.target.value; update(); });
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
    Object.assign(t, { search: "", workout: "all", source: "all", when: "any", from: "", to: "", sort: "start_time_local", dir: -1 });
    $("f-sort").value = "start_time_local:-1";
    $("f-search").value = ""; $("f-workout").value = "all"; $("f-source").value = "all"; $("f-when").value = "any";
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
