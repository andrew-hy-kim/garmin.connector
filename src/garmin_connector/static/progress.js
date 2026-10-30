// Progress: race predictor, statistics, progress status, where to improve, training paces.

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
  $("races-hint").textContent = rp.vo2max
    ? `From your VO2max shape (${rp.vo2max.toFixed(1)}${state.perf?.vo2max_as_of ? `, as of ${fmtDate(state.perf.vo2max_as_of, { month: "short", day: "numeric" })}` : ""}) and marathon shape (${rp.marathon_shape}%). ${act()} a row for your fastest recent stretch at that distance.`
    : `From your fastest stretches in the last ${rp.window_days} days, scaled to each distance. ${act()} a row to see the stretch it's based on.`;
  // negative = faster, which is good: shown as time taken off (−) or added (+)
  const change = (s) => (s == null ? `<span class="dim">–</span>` : Math.abs(s) < 5 ? `<span class="dim">same</span>`
    : `<span class="chg ${s < 0 ? "up" : ""}" title="${s < 0 ? "Faster" : "Slower"} than ${months} months ago">${s < 0 ? "−" : "+"}${fmtDuration(Math.abs(s))}</span>`);
  const dash = `<span class="dim">–</span>`;
  $("races").innerHTML = rp.races.map((r) => {
    const main = r.fitness_seconds || r.seconds;
    const chg = r.fitness_seconds ? r.fitness_change_s : r.change_s;
    const e = r.basis;
    const garmin = r.garmin_seconds ? fmtDuration(r.garmin_seconds) : dash;
    // held back by endurance: today's time, and what your speed supports once endurance catches up
    const potential = r.endurance_limited && r.potential_seconds
      ? `<span class="potential" title="What your VO2max supports with the endurance for it; your training paces use this">${fmtDuration(r.potential_seconds)} with the endurance</span>` : "";
    const attrs = e ? `class="clickable" tabindex="0" data-id="${e.activity_id}" data-t="${span(e)}" title="${esc(`Fastest stretch: your ${e.label} ${e.race ? "race" : "effort"} on ${fmtDate(e.date, { month: "short", day: "numeric" })}`)}"` : "";
    return `<tr ${attrs}><td>${esc(r.race)}</td>
      <td class="num">${main ? `<b>${fmtDuration(main)}</b>` : dash}${potential}</td><td class="num">${main ? fmtPace(r.meters / main) : ""}</td>
      <td class="num">${main ? change(chg) : ""}</td><td class="num">${garmin}</td></tr>`;
  }).join("");
  const limited = rp.races.some((r) => r.endurance_limited);
  $("races-foot").innerHTML = [
    limited ? `Long races are held back by endurance: the second time is what your speed supports once weekly distance and long runs catch up, and it's the one your training paces use.` : "",
    rp.garmin_date ? `Garmin's prediction as of ${esc(fmtDate(rp.garmin_date, { month: "short", day: "numeric" }))}.` : "",
  ].filter(Boolean).join(" ");
  $("races-foot").hidden = !$("races-foot").innerHTML;
}

// ---------- statistics: totals by year, month or week ----------
let statsBy = (() => { try { return localStorage.getItem("statsBy") || "year"; } catch { return "year"; } })();
// Distance so far this year, day by day, against last year and your best year
function renderYearToDate() {
  const box = $("ytd");
  if (!box) return;
  const u = Units.get();
  const now = new Date(), year = now.getFullYear();
  const dayOf = (d) => Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / 864e5);
  const today = dayOf(now);
  const byYear = new Map();
  for (const a of filtered()) {
    const d = localDate(a.start_time_local), y = d.getFullYear();
    if (!byYear.has(y)) byYear.set(y, new Array(366).fill(0));
    byYear.get(y)[dayOf(d)] += a.distance_m || 0;
  }
  const cum = (days, upTo = 365) => { let t = 0; return days.slice(0, upTo + 1).map((m) => (t += m, dist(t, u))); };
  // A year your history starts partway through (after January) would compare unfairly; leave it out
  const firstYear = Math.min(...byYear.keys());
  if (firstYear < year && byYear.get(firstYear).slice(0, 31).every((m) => !m)) byYear.delete(firstYear);
  const mine = byYear.get(year), last = byYear.get(year - 1);
  box.hidden = !mine;
  if (box.hidden) return;
  const ytd = cum(mine, today);
  const nowDist = ytd.at(-1);
  const others = [...byYear.keys()].filter((y) => y < year - 1);
  const best = others.sort((a, b) => cum(byYear.get(b)).at(-1) - cum(byYear.get(a)).at(-1))[0];
  const lastCum = last ? cum(last) : null;
  const yearDays = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
  const pace = nowDist / (today + 1) * yearDays;
  let vs = "";
  if (lastCum) {
    const diff = nowDist - lastCum[today];
    vs = ` · <span class="chg ${diff >= 0 ? "up" : ""}">${fmtNum(Math.abs(diff), 0)} ${u} ${diff >= 0 ? "ahead of" : "behind"}</span> ${year - 1} by this date`;
  }
  $("ytd-head").innerHTML = `<span class="big">${fmtNum(nowDist, 0)}<small>${u}</small></span><span class="dim">this year${vs} · on pace for ${fmtNum(pace, 0)} ${u}</span>`;
  const sets = [{ label: `${year}`, data: ytd, borderColor: cssVar("--accent"), borderWidth: 2.5 }];
  if (lastCum) sets.push({ label: `${year - 1}`, data: lastCum, borderColor: cssVar("--text-muted"), borderWidth: 1.5 });
  if (best) sets.push({ label: `${best} (best)`, data: cum(byYear.get(best)), borderColor: cssVar("--elev"), borderWidth: 1.5, borderDash: [4, 3] });
  sets.forEach((s) => Object.assign(s, { pointRadius: 0, pointHoverRadius: 3, tension: 0, fill: false }));
  $("ytd-legend").hidden = sets.length < 2;
  $("ytd-legend").innerHTML = sets.map((s) => `<span style="--c:${s.borderColor}">${esc(s.label)}</span>`).join("");
  const opts = chartBase();
  const monthStart = [...Array(12).keys()].map((m) => dayOf(new Date(year, m, 1)));
  opts.scales.x = { ...opts.scales.x, type: "linear", min: 0, max: 365,
    afterBuildTicks: (ax) => { ax.ticks = monthStart.map((v) => ({ value: v })); },
    ticks: { ...opts.scales.x.ticks, autoSkip: true, callback: (v) => new Date(year, 0, 1 + v).toLocaleDateString(undefined, { month: "short" }) } };
  opts.scales.y.ticks.callback = (v) => `${fmtNum(v)} ${u}`;
  opts.plugins.tooltip = { callbacks: {
    title: (i) => new Date(year, 0, 1 + i[0].parsed.x).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    label: (i) => `${i.dataset.label}: ${fmtNum(i.parsed.y, 0)} ${u}` } };
  drawChart("ytd", "ytd-chart", { type: "line", data: { datasets: sets.map((s) => ({ ...s, data: s.data.map((y, x) => ({ x, y })) })) }, options: opts });
}

function renderStats() {
  renderYearToDate();
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


// ---------- Progress: are you getting fitter? ----------
// Four signals over fixed windows (not the chart range): VO2max shape over 4 weeks, heart rate at
// your usual pace and easy-run efficiency (last 4 weeks against the 8 before), and training load
// (fitness) against 4 weeks ago. Each says better, worse or no change; together, one word.
function trendSignals() {
  const out = [];
  const p = state.perf;
  if (p?.vo2max && !p.vo2max_as_of && p.vo2max_change_4w != null) {
    const c = p.vo2max_change_4w;
    out.push({ dir: c >= 0.5 ? 1 : c <= -0.5 ? -1 : 0, text: `VO2max shape <b>${c >= 0 ? "+" : "−"}${Math.abs(c).toFixed(1)}</b> in 4 weeks` });
  }
  const now = Date.now(), day = 864e5;
  const windows = (vals) => {
    const recent = vals.filter(([x]) => x > now - 28 * day).map(([, v]) => v);
    const before = vals.filter(([x]) => x <= now - 28 * day && x > now - 84 * day).map(([, v]) => v);
    if (recent.length < 3 || before.length < 3) return null;
    const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    return [avg(recent), avg(before)];
  };
  const runs = state.activities.filter((a) => isRun(a.activity_type));
  const u = Units.get();
  const pick = hrPaceChoice(hrPaces(state.activities, u), u);
  if (pick) {
    const w = windows(runs.filter((a) => a.hr_by_speed?.length && !isHot(a))
      .map((a) => [localDate(a.start_time_local).getTime(), hrAtPace(a.hr_by_speed, pick.mps)]).filter(([, v]) => v != null));
    if (w) {
      const d = Math.round(w[0] - w[1]);
      out.push({ dir: d <= -2 ? 1 : d >= 2 ? -1 : 0, text: `Heart rate at ${fmtPace(pick.mps, u)} ${d ? `<b>${d > 0 ? "+" : "−"}${Math.abs(d)}</b> bpm` : "<b>unchanged</b>"}` });
    }
  }
  const easyCeiling = state.settings ? 0.9 * state.settings.lthr : 999;
  const w = windows(runs.filter((a) => a.efficiency && a.avg_hr && a.avg_hr < easyCeiling && !(a.cadence_lock > 0.2) && !isHot(a))
    .map((a) => [localDate(a.start_time_local).getTime(), a.efficiency]));
  if (w) {
    const c = (w[0] / w[1] - 1) * 100;
    out.push({ dir: c >= 2 ? 1 : c <= -2 ? -1 : 0, text: `Efficiency <b>${c >= 0 ? "+" : "−"}${Math.abs(c).toFixed(0)}%</b>` });
  }
  const load = state.load || [];
  if (load.length > 28 && load.at(-29).fitness > 5) {
    const c = (load.at(-1).fitness / load.at(-29).fitness - 1) * 100;
    out.push({ dir: c >= 5 ? 1 : c <= -10 ? -1 : 0, text: `Training load <b>${c >= 0 ? "+" : "−"}${Math.abs(c).toFixed(0)}%</b> in 4 weeks` });
  }
  return out;
}

function renderTrend() {
  const el = $("trend");
  if (!el) return;
  const signals = trendSignals();
  const up = signals.filter((x) => x.dir > 0).length, down = signals.filter((x) => x.dir < 0).length;
  const rebuilding = (state.insights || []).some((n) => n.title.startsWith("Rebuilding after"));
  if (!rebuilding && signals.length < 2) { el.hidden = true; return; }
  el.hidden = false;
  let word, line, color;
  if (rebuilding) {
    [word, color, line] = ["Rebuilding", "--info", "Fitness dropped during your break. It comes back faster than it took to build."];
  } else if (up >= 2 && up > down) {
    [word, color, line] = ["Improving", "--good", "You're getting fitter. What you're doing is working."];
  } else if (down >= 2 && down > up) {
    [word, color, line] = ["Slipping", "--warn-c", "Your fitness is drifting down over the last month."];
  } else if (up > down) {
    [word, color, line] = ["Edging up", "--good", "Small gains, not a clear trend yet."];
  } else {
    [word, color, line] = ["Holding steady", "--elev", "You're keeping your fitness, but not building it."];
  }
  // the next step: the area that holds you back most, from Where to improve
  const improving = word === "Improving";
  const area = (state.focus || []).find((a) => a.level === "focus" && a.action) || (!improving && (state.focus || []).find((a) => a.action));
  const step = area ? unitText(area.action)
    : rebuilding ? "Run three or more times a week, all easy, and add a little each week."
    : improving ? "Keep it consistent: steady weeks, mostly easy, one or two harder sessions."
    : "Run a little more each week, mostly easy, with one harder session a week.";
  el.innerHTML = `<div class="rd-main" style="--c:var(${color})">
      <span class="eyebrow">Progress</span>
      <div class="rd-word"><b>${word}</b></div>
      <p>${line}</p>
      ${signals.length ? `<div class="rd-facts">${signals.map((x) => `<span class="${x.dir > 0 ? "good" : x.dir < 0 ? "bad" : ""}">${x.text}</span>`).join("")}</div>` : ""}
    </div>
    <div class="rd-session" style="--c:var(${color})"><span class="eyebrow">${improving ? "To keep improving" : "To improve"}${area ? ` · ${esc(area.title)}` : ""}</span>
      <span>${esc(step)}</span>
      ${area && $("focus-card") ? `<a class="go" href="#focus-card">Where to improve ›</a>` : ""}</div>`;
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
  const color = a.workout_type ? typeColor(a.workout_type) : "var(--z2)";
  const stats = [
    ["Distance", fmtDist(a.distance_m)], ["Time", fmtDuration(a.moving_duration_s || a.duration_s)],
    [PACE_TYPES.test(a.activity_type || "") ? "Pace" : "Speed", fmtPaceOrSpeed(a.avg_speed_mps, a.activity_type)],
    ["Avg HR", a.avg_hr ? `${Math.round(a.avg_hr)} bpm` : ""], ["Load", a.trimp != null ? Math.round(a.trimp) : ""],
    ["VO2max", a.vo2max_eff ? a.vo2max_eff.toFixed(1) : ""],
    ["Weather", weatherShort(a.weather)],
  ].filter(([, v]) => v !== "" && v != null);
  const when = fmtDate(a.start_time_local, { weekday: "long", month: "short", day: "numeric" });
  const href = a.has_streams ? pageUrl("activity", { id: a.activity_id }) : null;
  el.innerHTML = `<div class="toolbar"><h2 style="margin:0">Latest run</h2><span class="spacer"></span>${href ? `<a href="${href}">Details ›</a>` : ""}</div>
    <div class="latest">
      <div class="latest-route" id="latest-route"></div>
      <div class="latest-main">
        <div class="latest-title"><b>${esc(a.name || prettyType(a.activity_type))}</b> ${a.workout_label ? tagHtml(a.workout_label, QUALITY.has(a.workout_type), a.workout_type) : ""}</div>
        <div class="dim">${esc(when)}</div>
        <div class="latest-stats">${stats.map(([k, v]) => `<div><span>${k}</span><b>${esc(String(v)).replace(/ (\/?[a-z]+)$/, "<small>$1</small>")}</b></div>`).join("")}</div>
        <div class="notes compact" id="latest-notes"></div>
      </div>
    </div>`;
  if (!a.has_streams) { $("latest-route").hidden = true; return; }
  // the route and the run's coach notes come with its details
  const id = a.activity_id;
  latestShown = id;
  try {
    const d = await getJSON(`/api/activities/${id}`);
    if (latestShown !== id) return;
    if (d.streams?.lat) $("latest-route").innerHTML = routeSvg(d.streams.lat, d.streams.lon, color);
    const notes = (d.insights || []).filter((n) => !/^(Tagged|Run\/walk):/.test(n.title)).slice(0, 2);
    if (notes.length) renderNotes($("latest-notes"), notes);
  } catch {}
  $("latest-route").hidden = !$("latest-route").innerHTML;
}

// ---------- Progress: where to improve ----------
const FOCUS_LABEL = { focus: "Work on", ok: "Fine", strength: "Strength" };
function renderFocus() {
  const list = state.focus || [];
  const card = $("focus-card");
  if (!card) return;
  card.hidden = !list.length;
  if (!list.length) return;
  $("focus").innerHTML = list.map((a) => `<div class="focus-row lvl-${esc(a.level)}">
      <div class="f-body">
        <div class="f-head"><span class="f-pill">${FOCUS_LABEL[a.level] || ""}</span><b>${esc(a.title)}</b><span class="f-headline">${esc(unitText(a.headline))}</span></div>
        <div class="f-detail">${esc(unitText(a.detail))}</div>
        ${a.action ? `<div class="f-action"><b>Next step:</b> ${esc(unitText(a.action))}</div>` : ""}
      </div></div>`).join("");
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
        <span class="sub">${p.vo2max_as_of ? `As of ${esc(fmtDate(p.vo2max_as_of, { month: "short", day: "numeric" }))}: no continuous runs since to update it` : chg == null ? "" : Math.abs(chg) < 0.2 ? "Steady over 4 weeks" : `<span class="${chg > 0 ? "up" : ""}">${chg > 0 ? "▲" : "▼"} ${Math.abs(chg).toFixed(1)}</span> over 4 weeks`}${watch ? ` · watch says ${watch.value.toFixed(0)}` : ""}</span>
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
      <p><b>Marathon shape</b> asks whether your training has the endurance for long races: your weekly distance over 6 months (two thirds) and your long runs over ${fmtNum(dist(13000), 1)} ${u} in the last 10 weeks (one third), against targets that grow with your VO2max. A 10K needs 17 %, a half marathon 42 %, a marathon 100 %. The race predictor uses both.</p></details>`;
  const h = p.history.filter((d) => inRange(d.date));
  const opts = chartBase();
  opts.interaction = { mode: "nearest", intersect: false };
  timeAxis(opts);
  opts.scales.y.grace = "8%";
  // at least 6 points of VO2max on the axis, so a drop of one or two doesn't look like a cliff
  const vals = h.map((d) => d.vo2max).concat(state.vo2.filter((r) => r.sport === "running" && inRange(r.date)).map((r) => r.value));
  if (vals.length) {
    const lo = Math.min(...vals), hi = Math.max(...vals), mid = (lo + hi) / 2;
    if (hi - lo < 6) { opts.scales.y.suggestedMin = Math.floor(mid - 3); opts.scales.y.suggestedMax = Math.ceil(mid + 3); }
  }
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
        borderColor: cssVar("--pace"), borderWidth: 2.5, pointRadius: h.length < 3 ? 4 : 0, tension: 0.25, spanGaps: GAP_MS },
      { label: "Watch VO2max", data: state.vo2.filter((r) => r.sport === "running" && inRange(r.date)).map((r) => ({ x: new Date(r.date + "T12:00").getTime(), y: r.value })),
        borderColor: cssVar("--gap"), borderWidth: 1.5, pointRadius: 0, borderDash: [4, 3], tension: 0.2, spanGaps: WATCH_GAP_MS },
      { label: "Marathon shape", yAxisID: "y2", data: h.map((d) => ({ x: new Date(d.date + "T12:00").getTime(), y: d.marathon_shape })),
        borderColor: cssVar("--elev"), backgroundColor: cssVar("--elev") + "22", fill: "origin", borderWidth: 1.5, pointRadius: 0, tension: 0.25, spanGaps: GAP_MS },
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
  $("paces-hint").textContent = `From your VO2max shape of ${p.vo2max.toFixed(1)}${p.vo2max_as_of ? ` (as of ${fmtDate(p.vo2max_as_of, { month: "short", day: "numeric" })})` : ""}, using Jack Daniels' training intensities. As your fitness changes, so do these.`;
  const zone = { easy: 2, marathon: 3, threshold: 4, interval: 5, repetition: 5 };
  const easy = p.paces.find((z) => z.key === "easy"), thr = p.paces.find((z) => z.key === "threshold");
  if ($("paces-sum")) $("paces-sum").textContent = easy && thr
    ? `Easy ${fmtPace(easy.fast_mps, undefined, false)}–${fmtPace(easy.slow_mps)} · threshold ${fmtPace(thr.fast_mps, undefined, false)}–${fmtPace(thr.slow_mps)}` : "";
  // marathon pace is your potential; when endurance holds a marathon back, say what today's would be
  const mara = (p.races || []).find((r) => r.race === "Marathon");
  const maraNote = mara?.limited_by_endurance && mara.seconds
    ? ` A marathon today: about ${fmtPace(mara.meters / mara.seconds)}, until your endurance catches up (see Race predictor).` : "";
  el.innerHTML = p.paces.map((z) => `<div class="pace-row" style="--c:var(--z${zone[z.key]})">
      <b>${z.label}</b><span class="pace-range">${fmtPace(z.fast_mps, undefined, false)}–${fmtPace(z.slow_mps)}</span><span class="dim">${esc(z.about)}${z.key === "marathon" ? esc(maraNote) : ""}</span></div>`).join("");
}
