// Workout detail: against your other runs (the last of the same kind, recent sessions, same route) and previous / next.

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

// ---------- recent sessions of the same kind: is this workout getting easier? ----------
const REP_KINDS = new Set(["intervals_vo2", "intervals_threshold", "speed"]);
const STEADY_KINDS = new Set(["tempo", "threshold", "progression", "long", "race", "fartlek"]);
function renderKind(all) {
  const card = $("kind-card"), a = D.activity, w = D.metrics?.workout;
  const kind = w?.type;
  const reps = REP_KINDS.has(kind);
  if (!kind || !(reps || STEADY_KINDS.has(kind)) || !isRun(a.activity_type)) { card.hidden = true; return; }
  const same = all.filter((x) => x.workout_type === kind && isRun(x.activity_type) && (!reps || x.reps?.mps))
    .sort((p, q) => q.start_time_local.localeCompare(p.start_time_local));   // newest first
  const i = same.findIndex((x) => x.activity_id === activityId);
  if (i < 0 || same.length < 2) { card.hidden = true; return; }
  const self = same[i];
  const shown = same.slice(Math.max(0, i - 2), Math.max(0, i - 2) + 8);
  const u = Units.get();
  const label = /^.[a-z]/.test(w.label) ? w.label[0].toLowerCase() + w.label.slice(1) : w.label;
  $("kind-title").textContent = `Your ${label} sessions`;
  // this one against the median of the three before it
  const before = same.slice(i + 1, i + 4);
  const speed = (x) => (reps ? x.reps.mps : x.avg_speed_mps);
  const hr = (x) => (reps ? x.reps.hr : x.avg_hr);
  const med = (vals) => { const v = vals.filter(Boolean).sort((p, q) => p - q); return v.length ? v[Math.floor(v.length / 2)] : null; };
  let head = "";
  const ms = med(before.map(speed)), mh = med(before.map(hr));
  if (before.length && ms && speed(self)) {
    const dp = Math.round(paceSeconds(speed(self)) - paceSeconds(ms));
    const dh = hr(self) && mh ? Math.round(hr(self) - mh) : null;
    const pace = Math.abs(dp) < 2 ? "Same pace" : `${fmtDuration(Math.abs(dp))} /${u} ${dp < 0 ? "faster" : "slower"}`;
    const beat = dh == null ? "" : Math.abs(dh) < 1 ? ", same heart rate" : `, ${Math.abs(dh)} bpm ${dh < 0 ? "lower" : "higher"} heart rate`;
    const better = dp <= 0 && (dh == null || dh <= 0) && (dp < -1 || (dh != null && dh < 0));
    head = `<span class="${better ? "chg up" : ""}">${reps && Math.abs(dp) >= 2 ? "Reps " : ""}${pace}${beat}</span>
      <span class="dim">vs. your ${before.length === 1 ? "previous session" : `previous ${before.length}`}</span>`;
  }
  $("kind-head").innerHTML = head;
  $("kind-cols").innerHTML = reps
    ? `<th>Date</th><th class="num">Reps</th><th class="num">Rep pace</th><th class="num">Rep HR</th>`
    : `<th>Date</th><th class="num">Distance</th><th class="num">Pace</th><th class="num">Avg HR</th>`;
  $("kind-rows").innerHTML = shown.map((x) => {
    const date = x === self ? "<b>This run</b>"
      : `<a href="${pageUrl("activity", { id: x.activity_id })}">${esc(fmtDate(x.start_time_local, { month: "short", day: "numeric", year: "2-digit" }))}</a>`;
    return `<tr class="${x === self ? "this" : ""}"><td>${date}</td>${reps
      ? `<td class="num">${x.reps.n} × ${fmtDuration(x.reps.seconds)}</td><td class="num">${fmtPace(x.reps.mps, u, false)}</td><td class="num">${x.reps.hr || "–"}</td>`
      : `<td class="num">${fmtDist(x.distance_m)}</td><td class="num">${fmtPace(x.avg_speed_mps, u, false)}</td><td class="num">${x.avg_hr ? Math.round(x.avg_hr) : "–"}</td>`}</tr>`;
  }).join("");
  card.hidden = false;
}

// ---------- same route: your other runs along the same line ----------
const M_LAT = 111320;
function nearTrack(p, track, tol) {
  // distance from point p to the nearest segment of track, in meters (flat-earth, fine at these scales)
  const kx = M_LAT * Math.cos(p[0] * Math.PI / 180);
  for (let i = 1; i < track.length; i++) {
    const ax = (track[i - 1][1] - p[1]) * kx, ay = (track[i - 1][0] - p[0]) * M_LAT;
    const bx = (track[i][1] - p[1]) * kx, by = (track[i][0] - p[0]) * M_LAT;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    const x = ax + t * dx, y = ay + t * dy;
    if (x * x + y * y <= tol * tol) return true;
  }
  return false;
}
function samples(track, n) {
  return Array.from({ length: n }, (_, k) => track[Math.round(k * (track.length - 1) / (n - 1))]);
}
const meters = (a, b) => Math.hypot((a[0] - b[0]) * M_LAT, (a[1] - b[1]) * M_LAT * Math.cos(a[0] * Math.PI / 180));
function sameRoute(track, other) {
  if (meters(track[0], other[0]) > 250 || meters(track.at(-1), other.at(-1)) > 250) return false;
  return samples(track, 16).every((p) => nearTrack(p, other, 120)) && samples(other, 16).every((p) => nearTrack(p, track, 120));
}

let routeAll = false, ROUTE = null;
const ordinal = (n) => {
  const tens = n % 100, ones = n % 10;
  return `${n}${tens >= 11 && tens <= 13 ? "th" : ones === 1 ? "st" : ones === 2 ? "nd" : ones === 3 ? "rd" : "th"}`;
};
async function findSameRoute(all) {
  const a = D.activity;
  if (!isRun(a.activity_type) || !a.distance_m) return;
  const tracks = (await getJSON("/api/heatmap").catch(() => null)) || [];
  const byId = new Map(tracks.map((t) => [t.id, t.track]));
  const mine = byId.get(activityId);
  if (!mine) return;
  const matches = all.filter((x) => x.activity_id !== activityId && isRun(x.activity_type) && byId.has(x.activity_id)
    && Math.abs(x.distance_m - a.distance_m) / a.distance_m < 0.08 && sameRoute(mine, byId.get(x.activity_id)));
  if (!matches.length) return;
  const self = all.find((x) => x.activity_id === activityId) || a;
  ROUTE = { self, runs: [self, ...matches].sort((p, q) => (p.start_time_local < q.start_time_local ? 1 : -1)) };
  drawSameRoute();
}

function drawSameRoute() {
  if (!ROUTE) return;
  const { self, runs } = ROUTE;
  const secs = (x) => x.moving_duration_s || x.duration_s;
  const byTime = [...runs].sort((p, q) => secs(p) - secs(q));
  const best = byTime[0];
  // rank among runs of the same kind: an easy run against easy runs, a workout against workouts
  const EASY = ["easy", "recovery", "long", "easy_strides"];
  const kindOf = (x) => (EASY.includes(x.workout_type) ? "easy" : x.workout_type ? "hard" : "other");
  const kin = byTime.filter((x) => kindOf(x) === kindOf(self));
  const rank = kin.indexOf(self) + 1;
  const kinWord = kindOf(self) === "easy" ? "easy runs" : kindOf(self) === "hard" ? "workouts" : "runs";
  $("same-route").hidden = false;
  $("route-hint").textContent = `Your runs that followed this route, start to finish, within a few percent of this distance. Moving time, so stops don't count.`;
  const bestText = best === self ? "this run is your route record" : `route record ${fmtDuration(secs(best))} on ${esc(fmtDate(best.start_time_local, { month: "short", day: "numeric", year: "numeric" }))}`;
  const rankText = kin.length < 2 || kin.length === runs.length && rank === 1 ? "" :
    rank === 1 ? `fastest of your ${kin.length} ${kinWord} here · ` : `${ordinal(rank)} fastest of your ${kin.length} ${kinWord} here · `;
  $("route-head").innerHTML = `<span class="big">${runs.length}<small>runs</small></span><span class="dim">${rankText}${bestText}</span>`;
  $("route-pace-h").textContent = `Pace /${Units.get()}`;
  const show = routeAll ? runs : runs.slice(0, 8);
  $("route-rows").innerHTML = show.map((x) => `<tr class="${x === self ? "this" : ""}" data-id="${x.activity_id}">
      <td>${x === self ? "<b>This run</b>" : `<a href="${pageUrl("activity", { id: x.activity_id })}">${esc(fmtDate(x.start_time_local, { month: "short", day: "numeric", year: "2-digit" }))}</a>`}</td>
      <td class="wide-only">${x.workout_label ? tagHtml(x.workout_label, false, x.workout_type) : ""}</td>
      <td class="num">${fmtDuration(secs(x))}${x === best ? ' <span class="best">best</span>' : ""}</td>
      <td class="num">${fmtPace(x.distance_m / secs(x), undefined, false)}</td>
      <td class="num">${x.avg_hr ? Math.round(x.avg_hr) : "–"}</td>
      <td class="num wide-only">${x.efficiency ? x.efficiency.toFixed(2) : "–"}</td></tr>`).join("");
  const more = $("route-more");
  more.hidden = runs.length <= 8;
  more.textContent = routeAll ? "Show fewer" : `Show all ${runs.length}`;
  more.onclick = () => { routeAll = !routeAll; drawSameRoute(); };
}

let allActivities = null; // the activity list, for the comparison line and older/newer
async function renderPrevNext() {
  const all = allActivities = await getJSON("/api/activities");
  renderTiles(); // now with heart rate at your usual pace
  renderComparison(all);
  renderKind(all);
  findSameRoute(all).catch(() => {});
  const list = all.filter((a) => a.has_streams);
  const i = list.findIndex((a) => a.activity_id === activityId);
  if (i < 0) return;
  const link = (a, text, rel) => (a ? `<a href="${pageUrl("activity", { id: a.activity_id })}" rel="${rel}" title="${esc(a.name)} · ${esc(fmtDate(a.start_time_local))}">${text}</a>` : `<span class="off">${text}</span>`);
  // the list is newest first
  $("pn").innerHTML = link(list[i + 1], "‹ Older", "prev") + link(list[i - 1], "Newer ›", "next");
}
