// Progress and Activities pages: shared state and helpers (time range, weekly buckets, lazy charts).
// Each part of the pages is in its own file (today.js, charts.js, progress.js, table.js); start.js runs them.

const PAGE_SIZE = 10;
const RANGES = [["3M", 91], ["6M", 182], ["1Y", 365], ["2Y", 730], ["5Y", 1826], ["All", null]];
const state = {
  activities: [], vo2: [], load: [], records: {}, settings: null, insights: [], type: "run",
  range: (() => { try { return localStorage.getItem("range") || "1Y"; } catch { return "1Y"; } })(),
  table: { search: "", workout: "all", source: "all", when: "any", from: "", to: "", sort: "start_time_local", dir: -1, page: 0 },
};

// Form as a share of fitness -> state. Mirrors insights.FORM_STATES.
const FORM_STATES = [
  { key: "fresh", min: 0.10, label: "Fresh", color: "--fitness", text: "Rested. Good for racing; weeks of this means losing your base." },
  { key: "neutral", min: -0.10, label: "Maintaining", color: "--elev", text: "Training and recovery balanced." },
  { key: "productive", min: -0.30, label: "Productive training", color: "--gap", text: "Carrying the fatigue that builds fitness." },
  { key: "overreaching", min: -Infinity, label: "Overreaching", color: "--hr", text: "Fatigue far above your base; recover before more hard work." },
];
// Orange is too light for text on white; its numbers use the darker warning orange
// (while history is still building, form means nothing yet: no alarm colors)
const textColor = (st) => (warmingUp() ? "--text-primary" : st.key === "productive" ? "--warn-c" : st.color);
// "+3", "-2" or "0" (rounded first, so a small negative never shows as "-0")
const fmtSigned = (v) => { const r = Math.round(v) || 0; return `${r > 0 ? "+" : ""}${r}`; };
// After a break, low fatigue reads as "fresh"; that's the break talking, not a good time to race
const rebuildingNote = (st) => ((st.key === "fresh" || st.key === "neutral") && (state.insights || []).some((n) => n.title.startsWith("Rebuilding after"))
  ? "Low fatigue after your break, not real freshness. Keep building gradually with easy running." : "");
const formState = (d) => FORM_STATES.find((s) => (d.fitness > 1 ? d.form / d.fitness : 0) >= s.min);
// Base and fatigue are 42- and 7-day averages: with under six weeks of history, form says nothing yet
const WARMUP_DAYS = 42;
const warmingUp = () => state.load.length > 0 && state.load.length < WARMUP_DAYS;
const WARMUP_TEXT = "Form needs about six weeks of training behind it to mean something. Until then, build up gradually with easy running.";
const charts = {};

const filtered = () => state.activities.filter((a) =>
  state.type === "all" ? true : state.type === "run" ? isRun(a.activity_type) : a.activity_type === state.type);

// Built from the calendar date in one step: where a clock change skips midnight (e.g. Chile),
// moving a 1 a.m. date back with setDate would keep the 1 a.m. and miss the week's key.
function startOfWeek(d) { // Monday
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
}
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Charts are drawn when they come near the screen, not all at once on load: Progress has a
// dozen, and drawing the ones below the fold made the page slow to appear on a phone.
const pendingCharts = {};
const chartObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    const job = e.isIntersecting && pendingCharts[e.target.id];
    if (!job) continue;
    delete pendingCharts[e.target.id];
    chartObserver.unobserve(e.target);
    job();
  }
}, { rootMargin: "600px 0px" }) : null;
addEventListener("beforeprint", () => { for (const id of Object.keys(pendingCharts)) { const job = pendingCharts[id]; delete pendingCharts[id]; job(); } });

// Lines over time break where you didn't run for over five weeks, rather than drawing a
// straight line across months without data (Chart.js: a number for spanGaps is the longest gap bridged).
const GAP_MS = 35 * 864e5, WATCH_GAP_MS = 120 * 864e5;

function drawChart(key, canvasId, config) {
  const canvas = $(canvasId);
  const draw = () => { charts[key]?.destroy(); charts[key] = new Chart(canvas, config); };
  if (!chartObserver || !canvas) return draw();
  pendingCharts[canvasId] = draw; // a newer config replaces one not drawn yet
  chartObserver.unobserve(canvas);
  chartObserver.observe(canvas);
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
