// Training plan page: pick a goal, see the plan week by week, track planned vs. done.

let S = null; // API response

const TYPE_LABEL = { easy: "Easy", long: "Long", vo2: "VO2 max", threshold: "Threshold", tempo: "Tempo", hills: "Hills", rest: "Rest" };
const HARD = new Set(["vo2", "threshold", "tempo", "hills"]);
const shortDate = (iso) => new Date(iso + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const addDays = (iso, n) => { const d = new Date(iso + "T12:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

function paceText(mps, type) {
  if (!mps) return "";
  const p = fmtPace(mps);
  return type === "easy" || type === "long" ? `your usual easy pace is about ${p}` : `about ${p}`;
}

// ---------- setup form ----------
function renderSetup(show) {
  $("setup").hidden = !show;
  $("plan").hidden = show || !S.plan;
  $("cancel").hidden = !S.plan;
  const current = S.plan?.goal || S.defaults.goal;
  $("goals").innerHTML = Object.entries(S.goals).map(([k, g]) => `
    <label class="goal"><input type="radio" name="goal" value="${k}" ${k === current ? "checked" : ""}>
      <b>${esc(g.label)}</b><span>${esc(g.blurb)}</span></label>`).join("");
  const f = $("plan-form").elements;
  const p = S.plan?.params || S.defaults;
  f.weeks.value = p.weeks; f.runs_per_week.value = p.runs_per_week; f.long_day.value = p.long_day;
}

$("plan-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  setStatus("Building your plan…");
  try {
    S = await getJSON("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: f.goal.value, weeks: f.weeks.value, runs_per_week: f.runs_per_week.value, long_day: f.long_day.value }) });
    setStatus("");
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) { setStatus(err.message, true); }
});
$("cancel").onclick = () => renderSetup(false);
$("change").onclick = () => renderSetup(true);
$("remove").onclick = async () => {
  if (!confirm("Remove this training plan?")) return;
  S = await getJSON("/api/plan", { method: "DELETE" });
  render();
};

// ---------- plan ----------
function renderPlan() {
  const plan = S.plan, ctx = plan.context;
  const end = addDays(plan.weeks.at(-1).start, 6);
  $("plan-title").textContent = plan.goal_label;
  $("plan-sub").textContent = `${plan.weeks.length} weeks, ${shortDate(plan.start)} – ${shortDate(end)} · ${plan.params.runs_per_week} runs a week, long run on ${plan.params.long_day === "Sat" ? "Saturday" : "Sunday"} · built ${shortDate(plan.created)} from your training up to then.`;
  if (plan.notes.length) renderNotes($("plan-notes"), plan.notes.map((n) => ({ level: "info", title: n, detail: "" })));
  else $("plan-notes").innerHTML = "";

  const u = Units.get();
  const items = [
    ["Last 7 days", `${ctx.last7_minutes} min of running`],
    ["4-week average", `${ctx.avg_week_minutes_4wk} min/week, ${ctx.runs_per_week_4wk} runs/week`],
    ["Your usual (last year)", ctx.typical_week_minutes ? `${ctx.typical_week_minutes} min/week` : "not enough history"],
    ["Fitness · form", ctx.fitness != null ? `${ctx.fitness} · ${ctx.form ? ctx.form.label : "–"}` : "–"],
    ["Threshold HR", `${Math.round(ctx.lthr)} bpm${ctx.lthr_source === "estimated" ? " (estimated)" : ""}`],
    ["Comeback", ctx.comeback ? `${ctx.comeback.days_back} days back after ${Math.round(ctx.comeback.break_days / 7)} weeks off` : "no recent break"],
    ["Pace targets", ctx.paces.based_on ? `from ${ctx.paces.based_on}` : "by heart rate and feel (no recent hard effort to base paces on)"],
  ];
  $("based-on").innerHTML = items.map(([k, v]) => `<div><span>${k}</span>${esc(v)}</div>`).join("");
  $("guidance").innerHTML = plan.guidance.map((g) => `<li>${esc(g)}</li>`).join("");

  const today = todayIso();
  $("weeks").innerHTML = plan.weeks.map((w, i) => {
    const prog = S.progress[i];
    const current = prog.status === "current";
    const done = prog.status === "upcoming" ? "" : `<span class="done">${prog.status === "current" ? "So far" : "Done"}:
      <b>${prog.done_minutes}</b> of ${prog.planned_minutes} min · ${prog.done_runs}/${prog.planned_runs} runs${prog.planned_quality ? ` · ${prog.done_quality}/${prog.planned_quality} workouts` : ""}</span>
      <div class="progress" role="img" aria-label="${Math.round(Math.min(1, prog.done_minutes / (prog.planned_minutes || 1)) * 100)}% of planned minutes done"><div style="width:${Math.min(100, (prog.done_minutes / (prog.planned_minutes || 1)) * 100)}%"></div></div>`;
    const days = w.days.map((d, k) => {
      const iso = addDays(w.start, k);
      const tgt = [d.hr ? `HR ${d.hr}` : "", paceText(d.speed, d.type)].filter(Boolean).join(" · ");
      return `<div class="day ${d.type === "rest" ? "rest" : ""} ${iso === today ? "today" : ""}" style="--c:${typeColor(d.type)}">
        <div class="dname">${d.day}<div class="date">${shortDate(iso)}</div></div>
        <div class="what"><b>${esc(d.title)}${HARD.has(d.type) ? ` <span class="badge">Workout</span>` : ""}</b>
          ${d.type === "rest" ? "" : `<div class="d">${esc(d.details)}</div>${tgt ? `<div class="tgt">${esc(tgt)}</div>` : ""}`}</div>
        <div class="mins">${d.minutes ? `${d.minutes} min` : ""}</div></div>`;
    }).join("");
    return `<section class="week ${current ? "current" : ""}">
      <div class="week-head"><h3>Week ${w.week}${current ? " (this week)" : ""}</h3>
        <span class="meta">${shortDate(w.start)} – ${shortDate(addDays(w.start, 6))} · ${esc(w.focus)} · ${w.minutes} min planned</span>${done}</div>
      ${days}</section>`;
  }).join("");
  setupAiBox($("ai"), "plan");
}

function render() {
  if (!S.plan && PHONE) {
    $("plan").hidden = true;
    $("setup").hidden = false;
    $("setup").innerHTML = `<h2>No training plan yet</h2><p class="hint" style="margin:0">Pick a goal on the Training plan page
      of the dashboard on your Mac. It shows up here after the next sync.</p>`;
    return;
  }
  if (!S.plan) { renderSetup(true); return; }
  renderSetup(false);
  renderPlan();
}

unitsToggle($("units"), () => S && S.plan && renderPlan());
getJSON("/api/plan").then((data) => {
  S = data;
  if (new URLSearchParams(location.search).has("new")) renderSetup(true); else render();
}).catch((err) => setStatus(`Couldn't load the plan: ${err.message}`, true));
