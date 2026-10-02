// Shared helpers for all dashboard pages.

// On the phone, phone.js loads first and answers API calls from the imported data file.
const PHONE = !!window.PhoneData;
if (PHONE) document.documentElement.classList.add("phone");

// Links between pages: server routes on the Mac, plain files in the phone app.
function pageUrl(page, params = {}) {
  if (page === "activity") return PHONE ? `activity.html?id=${params.id}` : `/activity/${params.id}`;
  if (page === "plan") return (PHONE ? "plan.html" : "/plan") + (params.new ? "?new" : "");
  return PHONE ? "index.html" : "/";
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
const fmtElev = (m, u = Units.get()) => (m == null ? "" : u === "mi" ? `${Math.round(m * 3.28084)} ft` : `${Math.round(m)} m`);
const elevUnit = (m, u = Units.get()) => (u === "mi" ? m * 3.28084 : m);
const prettyType = (t) => (t || "other").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const isRun = (t) => /run/.test(t || "");
// "2026-09-12 07:00:00" or a bare "2026-09-12" (read as local noon, so it never shifts a day)
const localDate = (s) => new Date(s.length === 10 ? `${s}T12:00:00` : s.replace(" ", "T"));
const fmtDate = (s, opts = { dateStyle: "medium" }) => localDate(s).toLocaleDateString(undefined, opts);
// "Oct '25": month and year that can't be mistaken for a day of the month
const fmtMonthYear = (d) => `${d.toLocaleDateString(undefined, { month: "short" })} '${String(d.getFullYear()).slice(2)}`;
const fmtNum = (v, digits = 0) => Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
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

// ---------- coach notes & Claude reviews ----------
const LEVEL_LABEL = { good: "Good", info: "Note", warn: "Watch" };
const LEVEL_ICON = { good: "✓", info: "i", warn: "!" };
function renderNotes(el, notes) {
  el.innerHTML = notes.length ? notes.map((n) => `<div class="note lvl-${esc(n.level)}">
      <span class="ico" role="img" aria-label="${LEVEL_LABEL[n.level] || ""}">${LEVEL_ICON[n.level] || "i"}</span>
      <div class="t">${esc(n.title)}</div>
      ${n.detail ? `<div class="d">${esc(n.detail)}</div>` : ""}</div>`).join("")
    : `<p class="hint">Nothing to flag yet. Notes appear as more runs are analyzed.</p>`;
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

// "Ask Claude" box: shows a saved review, or a button to request one.
async function setupAiBox(el, scope, activityId) {
  const params = () => new URLSearchParams({ scope, units: Units.get(), ...(activityId ? { activity_id: activityId } : {}) });
  const show = (data) => {
    if (PHONE) {
      // Reviews are written on the Mac; the phone shows the saved one, if any.
      const r = data.review;
      el.innerHTML = r
        ? `<div class="md">${markdown(r.text)}</div><div class="meta">Written by Claude on ${esc(r.created_at)} UTC. AI can make mistakes; it only sees the numbers here.</div>`
        : "";
      return;
    }
    if (!data.configured) {
      el.innerHTML = `<details><summary>Get a written coach's review from Claude</summary><p class="hint">Add an Anthropic API key once with
        <code>garmin-connector set-api-key</code>, then reload. Your workout summaries (no GPS) are only sent when you click the button, and each review costs a few cents.</p></details>`;
      return;
    }
    const r = data.review;
    el.innerHTML = (r ? `<div class="md">${markdown(r.text)}</div><div class="meta">Written by Claude on ${esc(r.created_at)} UTC. AI can make mistakes; it only sees the numbers here.</div>` : "") +
      `<button class="ai-btn" style="margin-top:10px">${r ? "Get a fresh review" : "Ask Claude for a coach's review"}</button>`;
    el.querySelector(".ai-btn").onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = "Claude is reviewing… (about 20–60 seconds)";
      try {
        show(await getJSON("/api/ai/review", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, activity_id: activityId, units: Units.get() }) }));
      } catch (err) {
        e.target.disabled = false; e.target.textContent = "Try again";
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
const QUALITY = new Set(["race", "progression", "tempo", "threshold", "intervals_threshold", "intervals_vo2", "speed", "fartlek"]);
