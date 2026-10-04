// Shared helpers for all dashboard pages.

// On the phone, phone.js loads first and answers API calls from the imported data file.
const PHONE = !!window.PhoneData;
if (PHONE) document.documentElement.classList.add("phone");

// Links between pages: server routes on the Mac, plain files in the phone app.
function pageUrl(page, params = {}) {
  // `t` ("start-end" in seconds) opens the workout with that stretch selected
  if (page === "activity") return (PHONE ? `activity.html?id=${params.id}` : `/activity/${params.id}`) + (params.t ? `#t=${params.t}` : "");
  if (page === "plan") return (PHONE ? "plan.html" : "/plan") + (params.new ? "?new" : "");
  if (["progress", "activities", "map"].includes(page)) {
    const query = params.query ? `?${new URLSearchParams(params.query)}` : "";
    return (PHONE ? `${page}.html` : `/${page}`) + query + (params.hash ? `#${params.hash}` : "");
  }
  return PHONE ? "index.html" : "/";
}

// The sticky top bar's height, for things that stick just below it
{
  const bar = document.querySelector(".topbar");
  if (bar) new ResizeObserver(() => document.documentElement.style.setProperty("--topbar-h", `${bar.offsetHeight}px`)).observe(bar);
}

// Highlight this page's tab (a workout belongs to Activities)
{
  const page = document.body.dataset.page || (/plan/.test(location.pathname) ? "plan" : /activit/.test(location.pathname) ? "activities" : "today");
  const mark = (a) => document.querySelectorAll(".tabs a").forEach((x) => (x === a ? x.setAttribute("aria-current", "page") : x.removeAttribute("aria-current")));
  mark(document.querySelector(`.tabs a[data-page="${page}"]`));
  // the tapped tab lights up the moment it's touched, before the next page has loaded
  document.querySelector(".tabs")?.addEventListener("pointerdown", (e) => { const a = e.target.closest("a"); if (a) mark(a); });
  // coming back (swipe or Back) can restore this page as it was left: put the highlight back
  addEventListener("pageshow", (e) => { if (e.persisted) mark(document.querySelector(`.tabs a[data-page="${page}"]`)); });
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

async function getJSON(url, options) {
  if (PHONE) return window.PhoneData.get(url, options);
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// "Click" with a mouse or trackpad, "Tap" on a touch screen
const act = () => (matchMedia("(hover: hover)").matches ? "Click" : "Tap");
// The same for the fixed hints written in the pages
for (const el of document.querySelectorAll(".hint")) {
  const word = act();
  for (const node of el.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE || !/click/i.test(node.textContent)) continue;
    node.textContent = node.textContent.replace(/Tap or click/g, word).replace(/\bClick\b/g, word).replace(/\bclick\b/g, word.toLowerCase());
  }
}

// ---------- units (remembered per browser) ----------
const Units = {
  get() { try { return localStorage.getItem("units") || "mi"; } catch { return "mi"; } },
  set(u) { try { localStorage.setItem("units", u); } catch {} },
};
const M_PER = { mi: 1609.344, km: 1000 };
const dist = (m, u = Units.get()) => (m || 0) / M_PER[u];
const fmtDist = (m, u = Units.get(), digits = 2) => (m ? `${dist(m, u).toFixed(digits)} ${u}` : "");

function fmtDuration(s) {
  if (s == null || isNaN(s)) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

// seconds per unit distance from m/s
function paceSeconds(mps, u = Units.get()) { return mps > 0.3 ? M_PER[u] / mps : null; }
function fmtPace(mps, u = Units.get(), withUnit = true) {
  const raw = paceSeconds(mps, u);
  if (raw == null || raw > 3600) return "";
  const s = Math.round(raw);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}${withUnit ? ` /${u}` : ""}`;
}
function fmtSpeed(mps, u = Units.get()) { return mps ? `${(mps * 3600 / M_PER[u]).toFixed(1)} ${u === "mi" ? "mph" : "km/h"}` : ""; }
const PACE_TYPES = /run|walk|hik/;
const fmtPaceOrSpeed = (mps, type, u) => (PACE_TYPES.test(type || "") ? fmtPace(mps, u) : fmtSpeed(mps, u));
const fmtElev = (m, u = Units.get()) => (m == null ? "" : `${Math.round(u === "mi" ? m * 3.28084 : m).toLocaleString()} ${u === "mi" ? "ft" : "m"}`);
const elevUnit = (m, u = Units.get()) => (u === "mi" ? m * 3.28084 : m);
const prettyType = (t) => (t || "other").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const isRun = (t) => /run/.test(t || "");
// "2026-09-12 07:00:00" or a bare "2026-09-12" (read as local noon, so it never shifts a day)
const localDate = (s) => new Date(s.length === 10 ? `${s}T12:00:00` : s.replace(" ", "T"));
const fmtDate = (s, opts = { dateStyle: "medium" }) => localDate(s).toLocaleDateString(undefined, opts);
// "Oct '25": month and year that can't be mistaken for a day of the month
const fmtMonthYear = (d) => `${d.toLocaleDateString(undefined, { month: "short" })} '${String(d.getFullYear()).slice(2)}`;
const fmtNum = (v, digits = 0) => Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

// ---------- heart rate at a fixed pace ----------
// Each run carries hr_by_speed, [[grade-adjusted speed m/s, heart rate, seconds], …], from its
// steady running only. Heart rate at a pace is read off the paces near it: a weighted straight
// line through them, so a run at 9:20 still says something about 9:30. Null when the run
// spent under two minutes near that pace.
function hrAtPace(table, mps) {
  const near = (table || []).filter(([s]) => Math.abs(s - mps) <= 0.3);
  const w = near.reduce((t, b) => t + b[2], 0);
  if (w < 120) return null;
  const speeds = near.map((b) => b[0]);
  if (mps < Math.min(...speeds) - 0.1 || mps > Math.max(...speeds) + 0.1) return null; // only paces actually run
  const ms = near.reduce((t, b) => t + b[0] * b[2], 0) / w, mh = near.reduce((t, b) => t + b[1] * b[2], 0) / w;
  const vs = near.reduce((t, b) => t + b[2] * (b[0] - ms) ** 2, 0) / w;
  if (vs < 0.002) return mh; // effectively one pace
  const slope = near.reduce((t, b) => t + b[2] * (b[0] - ms) * (b[1] - mh), 0) / w / vs;
  // heart rate rises with pace; noise shouldn't turn that around or blow it up
  return mh + Math.max(0, Math.min(slope, 80)) * (mps - ms);
}
// The paces (15-second steps in your units) at least five runs were run at steadily
function hrPaces(activities, u = Units.get()) {
  const runs = activities.filter((a) => a.hr_by_speed?.length && isRun(a.activity_type));
  const since = Date.now() - 180 * 864e5;
  const out = [];
  for (let sec = 180; sec <= 900; sec += 15) {
    const mps = M_PER[u] / sec;
    const hits = runs.filter((a) => hrAtPace(a.hr_by_speed, mps) != null);
    if (hits.length >= 5) out.push({ sec, mps, n: hits.length, recent: hits.filter((a) => localDate(a.start_time_local) > since).length });
  }
  return out;
}
// The pace you picked, or else the one you've run at most lately (usually your easy pace)
function hrPaceChoice(paces, u = Units.get()) {
  if (!paces.length) return null;
  let saved = null;
  try { saved = localStorage.getItem("hrPace"); } catch {}
  return paces.find((p) => `${u}:${p.sec}` === saved)
    || paces.reduce((b, p) => (p.recent > b.recent || (p.recent === b.recent && p.n > b.n) ? p : b));
}
function saveHrPace(sec, u = Units.get()) { try { localStorage.setItem("hrPace", `${u}:${sec}`); } catch {} }
// Totals of time: "42m", "1h 42m", "161h"
function fmtTotal(s) {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (!h) return `${m}m`;
  return h >= 100 ? `${fmtNum(h)}h` : `${h}h ${String(m).padStart(2, "0")}m`;
}

function unitsToggle(el, onChange) {
  el.innerHTML = `<button data-u="mi">mi</button><button data-u="km">km</button>`;
  const sync = () => el.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.u === Units.get()));
  el.addEventListener("click", (e) => {
    const u = e.target.dataset.u;
    if (!u) return;
    Units.set(u); sync(); onChange();
  });
  sync();
}

// Status messages float at the bottom of the screen, like a macOS/iOS notice.
// Progress ("…") and errors stay until replaced or dismissed; confirmations fade after a few seconds.
let statusTimer;
function setStatus(msg, isError = false) {
  const el = $("status");
  if (!el) return;
  if (el.parentElement !== document.body) document.body.appendChild(el); // out of the blurred top bar
  clearTimeout(statusTimer);
  el.classList.toggle("error", isError);
  el.innerHTML = msg ? `<span>${esc(msg)}</span>${isError ? `<button type="button" aria-label="Dismiss">✕</button>` : ""}` : "";
  el.classList.toggle("show", !!msg);
  const close = el.querySelector("button");
  if (close) close.onclick = () => setStatus("");
  if (msg && !isError && !/…$/.test(msg)) statusTimer = setTimeout(() => el.classList.remove("show"), 5000);
}

// Pages start hidden ("loading") and fade in once their data is drawn, so empty cards never flash.
// The browser jumps to a #section link before the page has its data, and the cards above it
// then grow, so the jump would land in the wrong place. Jump again once the page is drawn.
let hashDone = false;
function ready() {
  document.body.classList.remove("loading");
  if (hashDone) return;
  hashDone = true;
  const target = /^#[a-z][\w-]*$/i.test(location.hash) && document.getElementById(location.hash.slice(1));
  if (target) requestAnimationFrame(() => requestAnimationFrame(() => target.scrollIntoView({ block: "start" })));
}
setTimeout(ready, 4000); // never stay hidden if something goes wrong

// Printing: open every folded section so nothing is left out, then restore
let printOpened = [];
window.addEventListener("beforeprint", () => {
  printOpened = [...document.querySelectorAll("details:not([open])")];
  printOpened.forEach((d) => { d.open = true; });
});
window.addEventListener("afterprint", () => { printOpened.forEach((d) => { d.open = false; }); printOpened = []; });

// Busy state for a button while something runs: label changes, button disabled.
async function busy(button, label, work) {
  const old = button.textContent;
  button.disabled = true; button.textContent = label;
  try { return await work(); } finally { button.disabled = false; button.textContent = old; }
}

// Chart.js defaults that follow the theme
function chartBase() {
  if (window.Chart) {
    const t = Chart.defaults.plugins.tooltip;
    Object.assign(t, { backgroundColor: cssVar("--surface-1"), titleColor: cssVar("--text-primary"), bodyColor: cssVar("--text-secondary"),
      borderColor: cssVar("--border"), borderWidth: 1, padding: 10, cornerRadius: 8, boxPadding: 4, usePointStyle: true,
      titleFont: { weight: "600" }, caretSize: 5 });
    Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    Chart.defaults.font.size = 12;
  }
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false }, border: { color: cssVar("--border") }, ticks: { color: cssVar("--text-muted"), maxRotation: 0, autoSkipPadding: 14 } },
      y: { grid: { color: cssVar("--grid") }, border: { display: false }, ticks: { color: cssVar("--text-muted") } },
    },
  };
}

const ZONE_METHODS = { HR_MAX: "% of max HR", HR_RESERVE: "% of heart-rate reserve", LACTATE_THRESHOLD: "% of threshold HR" };

// One line saying where the zones come from
function zoneBasis(s) {
  if (s.zone_floors) return `Zones from your Garmin settings${ZONE_METHODS[s.zone_method] ? ` (${ZONE_METHODS[s.zone_method]})` : ""}`;
  const est = s.sources && s.sources.lthr === "estimated" ? ", estimated as 90% of max HR until Garmin or you provide one" : "";
  return `Zones built around your threshold HR of ${Math.round(s.lthr)}${est}`;
}

const zoneRange = (zones, i) => {
  const z = zones[i];
  return i === 0 ? `< ${z.high}` : i === zones.length - 1 ? `≥ ${z.low}` : `${z.low}–${z.high - 1}`;
};

function zoneRows(zones, seconds) {
  const total = seconds.reduce((a, b) => a + b, 0) || 1;
  const maxShare = Math.max(...seconds) / total || 1;
  return zones.map((z, i) => {
    const share = seconds[i] / total;
    return `<div class="zone-row">
      <div><span class="swatch" style="--c:var(--z${i + 1})"></span>Z${i + 1} ${esc(z.name)}<div class="range">${zoneRange(zones, i)} bpm</div></div>
      <div class="bar" role="img" aria-label="${Math.round(share * 100)}%"><div style="width:${(share / maxShare) * 100}%;background:var(--z${i + 1})"></div></div>
      <div class="val">${fmtDuration(seconds[i])} · <b>${Math.round(share * 100)}%</b></div>
    </div>`;
  }).join("");
}

// Distances and paces in note text come as tokens ({{d:meters}}, {{p:m/s}}), shown in your units.
function unitText(s, u = Units.get()) {
  return String(s ?? "").replace(/\{\{([dp]):([0-9.]+)\}\}/g, (_, kind, v) => {
    v = +v;
    if (kind === "p") return fmtPace(v, u);
    const n = dist(v, u);
    return `${fmtNum(n, n < 10 ? 1 : 0)} ${u}`;
  });
}

// ---------- coach notes & Claude reviews ----------
const LEVEL_LABEL = { good: "Good", info: "Note", warn: "Watch" };
const LEVEL_ICON = { good: "✓", info: "i", warn: "!" };
function renderNotes(el, notes, emptyText = "Nothing to flag yet. Notes appear as more runs are analyzed.") {
  // Things to watch first, then notes, then good news
  const rank = { warn: 0, info: 1, good: 2 };
  notes = [...notes].sort((a, b) => (rank[a.level] ?? 1) - (rank[b.level] ?? 1));
  el.innerHTML = notes.length ? notes.map((n) => `<div class="note lvl-${esc(n.level)}">
      <span class="ico" role="img" aria-label="${LEVEL_LABEL[n.level] || ""}">${LEVEL_ICON[n.level] || "i"}</span>
      <div class="t">${esc(unitText(n.title))}</div>
      ${n.detail ? `<div class="d">${esc(unitText(n.detail))}</div>` : ""}</div>`).join("")
    : `<p class="hint" style="margin:0">${esc(emptyText)}</p>`;
}

// Minimal Markdown (headings, lists, bold/italic, paragraphs) for Claude's reviews. Escapes first.
function markdown(src) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*]+)\*/g, "$1<i>$2</i>");
  const out = []; let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; } };
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    let m;
    if (!line) { flushPara(); flushList(); }
    else if ((m = line.match(/^#{1,6}\s+(.*)/))) { flushPara(); flushList(); out.push(`<h4>${inline(m[1])}</h4>`); }
    else if ((m = line.match(/^[-*]\s+(.*)/)) || (m = line.match(/^\d+[.)]\s+(.*)/))) {
      flushPara();
      const tag = /^\d/.test(line) ? "ol" : "ul";
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[1]);
    } else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join("");
}

// Reviews are stamped in UTC ("2026-10-03 14:22:11"); show them in your own time
function reviewDate(utc) {
  const d = new Date(String(utc).replace(" ", "T") + "Z");
  return isNaN(d) ? `on ${utc}` : `on ${d.toLocaleDateString(undefined, { dateStyle: "medium" })} at ${d.toLocaleTimeString(undefined, { timeStyle: "short" })}`;
}

// "Ask Claude" box: shows a saved review, or a button to request one.
async function setupAiBox(el, scope, activityId) {
  const params = () => new URLSearchParams({ scope, units: Units.get(), ...(activityId ? { activity_id: activityId } : {}) });
  const show = (data) => {
    if (PHONE) {
      // Reviews are written on the Mac; the phone shows the saved one, if any.
      const r = data.review;
      el.innerHTML = r
        ? `<div class="md">${markdown(r.text)}</div><div class="meta">Written by Claude ${esc(reviewDate(r.created_at))}. AI can make mistakes; it only sees the numbers here.</div>`
        : "";
      return;
    }
    if (!data.configured) {
      el.innerHTML = `<details><summary>Get a written coach's review from Claude</summary><p class="hint">Add an Anthropic API key once with
        <code>garmin-connector set-api-key</code>, then reload. Your workout summaries (no GPS) are only sent when you click the button, and each review costs a few cents.</p></details>`;
      return;
    }
    const r = data.review;
    el.innerHTML = (r ? `<div class="md">${markdown(r.text)}</div><div class="meta">Written by Claude ${esc(reviewDate(r.created_at))}. AI can make mistakes; it only sees the numbers here.</div>` : "") +
      `<button class="ai-btn" style="margin-top:10px">${r ? "Get a fresh review" : "Ask Claude for a coach's review"}</button>`;
    el.querySelector(".ai-btn").onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = "Claude is reviewing… (about 20–60 seconds)";
      try {
        show(await getJSON("/api/ai/review", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, activity_id: activityId, units: Units.get() }) }));
      } catch (err) {
        e.target.disabled = false; e.target.textContent = "Try again";
        el.querySelector(":scope > .warn")?.remove(); // one message, not a stack of them
        el.insertAdjacentHTML("afterbegin", `<div class="warn">${esc(err.message)}</div>`);
      }
    };
  };
  try { show(await getJSON(`/api/ai/review?${params()}`)); } catch (err) { el.innerHTML = ""; }
}

// Workout type -> the HR zone it mostly trains, so tags, plan days and charts share one color language.
const TYPE_ZONE = {
  recovery: 1, easy: 2, easy_strides: 2, long: 2, progression: 3, tempo: 3, threshold: 4, intervals_threshold: 4,
  fartlek: 4, intervals_vo2: 5, speed: 5, race: 5, vo2: 5, hills: 5,
};
const typeColor = (type) => (TYPE_ZONE[type] ? `var(--z${TYPE_ZONE[type]})` : "var(--z1)");
const tagHtml = (label, quality, type) => (label
  ? `<span class="tag ${quality ? "q" : ""}" style="--c:${typeColor(type)}">${esc(label)}</span>` : "");
// A planned or suggested session, said once: "Easy run" already means easy and conversational
// (the plan's guidance says so), so that sentence isn't repeated on every easy day.
function sessionDetails(d) {
  if (!d.details) return "";
  return ["easy", "long"].includes(d.type)
    ? d.details.replace(/^Easy and conversational( the whole way)?\.\s*/, "") : d.details;
}
// "HR under 153 bpm · about 8:42 /mi"
const sessionTarget = (d) => [d.hr ? `HR ${d.hr}` : "", d.speed ? `about ${fmtPace(d.speed)}` : ""].filter(Boolean).join(" · ");
const QUALITY = new Set(["race", "progression", "tempo", "threshold", "intervals_threshold", "intervals_vo2", "speed", "fartlek"]);
