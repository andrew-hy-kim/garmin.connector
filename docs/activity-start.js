// Workout detail: renders the page and wires its controls. Loaded last.

// ---------------------------------------------------------------- page

function renderAll() {
  if (D.streams) { derive(); }
  renderHeader(); renderTagline(); renderWarnings(); renderTiles(); renderConditions(); renderZones(); if (S) renderPaceZones(); else $("pace-zones-card").hidden = true;
  renderLaps(); renderSplits(); renderEfforts(); drawSameRoute(); if (allActivities) renderKind(allActivities);
  renderNotes($("notes"), (D.insights || []).filter((n) => !n.title.startsWith("Tagged:")), "Nothing stands out in this workout.");
  $("charts-card").style.display = D.streams ? "" : "none";
  if (D.streams) { buildPanels(); drawAll(); renderSelection(); }
}

$("xaxis").addEventListener("click", (e) => {
  const x = e.target.dataset.x;
  if (!x || !S) return;
  xMode = x;
  $("xaxis").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.x === x));
  derive(); drawAll();
});

unitsToggle($("units"), () => { renderAll(); if (allActivities) renderComparison(allActivities); });
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawAll, 100); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { drawAll(); if (D?.streams) renderMap(); });


document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const rel = e.key === "ArrowLeft" ? "prev" : e.key === "ArrowRight" ? "next" : null;
  const a = rel && document.querySelector(`#pn a[rel="${rel}"]`);
  if (a) location.href = a.href;
});

getJSON(`/api/activities/${activityId}`)
  .then((data) => {
    D = data; renderAll(); ready(); renderMap(); renderPrevNext().catch(() => {});
    // Opened from a record: select that stretch
    const m = location.hash.match(/t=(\d+)-(\d+)/);
    if (m && S) selectRange(idxAtT(Number(m[1])), idxAtT(Number(m[2])));
  })
  .catch((err) => {
    ready(); $("title").textContent = "Couldn't load this activity";
    $("subtitle").textContent = "It may have been deleted in Garmin Connect, or the link is out of date.";
    document.querySelectorAll("main > section").forEach((s) => (s.hidden = true)); // empty cards would only confuse
    setStatus(err.message, true);
  });
