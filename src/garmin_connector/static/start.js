// Puts the Progress and Activities pages together: loads the data, renders, wires the
// controls. Loaded last, after the files that define each part.

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
  renderRecordsByYear();
  renderTrend(); renderLoad(); renderVolume(); renderMix(); renderCross(); renderCalories(); renderLoadSources(); renderEfficiency(); renderHrPace(); renderForm(); renderVo2(); renderRecords(); renderPerf(); renderFocus();
  // "More charts" only when one of them has something to show
  const more = $("more-charts");
  if (more) more.hidden = [...more.querySelectorAll(".grid > .card")].every((c) => c.hidden);
}


// Jump links on Progress: hide the ones with nothing to show, mark the section you're reading
function updateJump() {
  const nav = document.querySelector(".jump");
  if (!nav) return;
  nav.querySelectorAll("a[data-needs]").forEach((a) => { a.hidden = !$(a.dataset.needs) || $(a.dataset.needs).hidden; });
  if (nav.dataset.watching) return;
  nav.dataset.watching = "1";
  const links = [...nav.querySelectorAll("a")];
  let frame = 0;
  const mark = () => {
    const line = nav.getBoundingClientRect().bottom + 40;
    let current = links[0];
    for (const a of links) {
      const t = $(a.getAttribute("href").slice(1));
      if (t && !t.hidden && t.getBoundingClientRect().top <= line) current = a;
    }
    // at the very bottom, the last section counts even if it never reaches the line
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) current = links.filter((a) => !a.hidden).at(-1);
    links.forEach((a) => a.setAttribute("aria-current", a === current ? "true" : "false"));
    current.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  addEventListener("scroll", () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(mark); }, { passive: true });
  mark();
}

function render() {
  // Nothing synced yet: a welcome card instead of empty charts (set first, so cards have their width)
  const empty = !state.activities.length;
  document.body.classList.toggle("no-data", empty);
  if ($("welcome")) $("welcome").hidden = !empty;
  renderToday();
  renderLatest(); renderConsistency();
  renderTiles(); renderRaces(); renderExplain(); renderCompare();
  // form and monotony are day-to-day readiness numbers; they stay in the Base, fatigue & form fold
  if ($("notes")) renderNotes($("notes"), state.insights.filter((n) => !/^(Form|Monotony)\b/.test(n.title)), undefined, 3);
  renderCharts(); renderStats(); renderSettings(); renderTable(); updateJump();
}

async function load() {
  const [acts, vo2, loadSeries, records, settings, notes, races, perf, focus] = await Promise.all(
    ["/api/activities", "/api/vo2max", "/api/training-load", "/api/records", "/api/settings", "/api/insights"].map((u) => getJSON(u))
      .concat(["/api/race-predictions", "/api/performance", "/api/focus"].map((u) => getJSON(u).catch(() => null))));
  Object.assign(state, { activities: acts, vo2, load: loadSeries, records, settings, insights: notes, races, perf, focus });
  populateTypes(); render(); ready(); renderSyncAlert();
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
  } catch (err) { setStatus(err.message, true); renderSyncAlert(); }
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
