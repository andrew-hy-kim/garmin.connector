// Shared helpers for both dashboard pages.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

async function getJSON(url, options) {
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
const localDate = (s) => new Date(s.replace(" ", "T"));
const fmtDate = (s, opts = { dateStyle: "medium" }) => localDate(s).toLocaleDateString(undefined, opts);

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

function setStatus(msg, isError = false) {
  const el = $("status");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

// Chart.js defaults that follow the theme
function chartBase() {
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

function zoneRows(zones, seconds) {
  const total = seconds.reduce((a, b) => a + b, 0) || 1;
  const maxShare = Math.max(...seconds) / total || 1;
  return zones.map((z, i) => {
    const share = seconds[i] / total;
    const range = i === 0 ? `< ${z.high}` : i === zones.length - 1 ? `≥ ${z.low}` : `${z.low}–${z.high - 1}`;
    return `<div class="zone-row">
      <div>Z${i + 1} ${esc(z.name)}<div class="range">${range} bpm</div></div>
      <div class="bar" role="img" aria-label="${Math.round(share * 100)}%"><div style="width:${(share / maxShare) * 100}%;background:var(--z${i + 1})"></div></div>
      <div class="val">${fmtDuration(seconds[i])} · ${Math.round(share * 100)}%</div>
    </div>`;
  }).join("");
}
