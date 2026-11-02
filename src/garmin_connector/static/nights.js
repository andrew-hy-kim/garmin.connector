// Progress: your nights (sleep, resting HR, HRV) from the nights you wore the watch to bed.
// A night you didn't wear it simply isn't there: the charts leave a gap, nothing is guessed.

const QUALITY_WORD = { EXCELLENT: "Excellent", GOOD: "Good", FAIR: "Fair", POOR: "Poor" };
const nightTime = (d) => new Date(d + "T08:00").getTime();
const nightDate = (d) => fmtDate(d, { weekday: "short", month: "short", day: "numeric" });

// ---------- Recovery: last night against your normal ----------
function renderRecovery() {
  const card = $("recovery-card");
  if (!card) return;
  const s = state.nights;
  card.hidden = !s || !s.recent;
  if (card.hidden) return;
  const n = s.last;
  const today = isoDay(new Date());
  $("recovery-when").textContent = n.date === today ? "Last night" : `Night before ${nightDate(n.date)}`;
  const hrvTag = n.hrv && s.hrv_low ? (n.hrv < s.hrv_low ? `<em class="rec-bad">below</em>` : n.hrv > s.hrv_high ? `<em>above</em>` : "") : "";
  const rhrDiff = n.resting_hr && s.resting_hr_normal ? Math.round(n.resting_hr - s.resting_hr_normal) : null;
  const items = [
    ["Sleep", n.sleep_s ? fmtTotal(n.sleep_s) : "–",
      [n.sleep_score && `score ${Math.round(n.sleep_score)}`, QUALITY_WORD[n.sleep_quality]].filter(Boolean).join(" · ") || ""],
    ["HRV", n.hrv ? `${Math.round(n.hrv)} ms ${hrvTag}` : "–",
      s.hrv_low ? `normal ${Math.round(s.hrv_low)}–${Math.round(s.hrv_high)} ms` : "your normal range needs a few weeks"],
    ["Resting HR", n.resting_hr ? `${Math.round(n.resting_hr)} bpm${rhrDiff >= 3 ? ` <em class="rec-bad">+${rhrDiff}</em>` : ""}` : "–",
      n.resting_hr ? (s.resting_hr_normal ? `your normal ${Math.round(s.resting_hr_normal)}` : "your normal needs 5+ nights")
        : n.sleep_s ? "short night: not counted" : ""],
    ["Nights worn", `${s.worn_14} of 14`, s.sleep_week_avg_s ? `${fmtTotal(s.sleep_week_avg_s)} a night this week` : "the last two weeks"],
  ];
  // several nights off your normal: the coach note above says so, with what to do
  $("recovery-kv").innerHTML = items.map(([k, v, sub]) => `<div><span>${k}</span><b>${v}</b><small>${esc(sub)}</small></div>`).join("");
}

// ---------- Nights chart: resting HR, HRV, sleep score, sleep time ----------
const NIGHT_MEASURES = [
  { key: "resting_hr", label: "Resting HR", unit: "bpm", color: "--hr", better: -1, fmt: (v) => fmtNum(v),
    hint: "Your lowest heart rate overnight. It drifts down as aerobic fitness builds; a few nights well above your normal often come before illness, or follow hard training, alcohol or poor sleep." },
  { key: "hrv", label: "HRV", unit: "ms", color: "--pace", better: 1, band: true, fmt: (v) => fmtNum(v),
    hint: "Heart-rate variability overnight, against the normal range Garmin works out for you (shaded). Several nights below it usually means your body is still recovering." },
  { key: "sleep_score", label: "Sleep score", unit: "", color: "--cadence", better: 1, fmt: (v) => fmtNum(v),
    hint: "Garmin's sleep score, 0–100, from how long you slept, your sleep stages and how restless you were." },
  { key: "sleep_s", label: "Sleep", unit: "", color: "--elev", better: 1, bars: true, fmt: (v) => fmtTotal(v),
    hint: "Time asleep each night. Most runners recover best on 7–9 hours." },
];
let nightsBy = "resting_hr";
try { nightsBy = localStorage.getItem("nightsBy") || nightsBy; } catch {}

function renderNights() {
  const card = $("nights-card");
  if (!card) return;
  const all = state.nights?.nights || [];
  const start = rangeStart().getTime();
  const shown = all.filter((r) => nightTime(r.date) >= start);
  const have = NIGHT_MEASURES.filter((m) => shown.filter((r) => r[m.key]).length >= 3);
  card.hidden = !have.length;
  if (!have.length) return;
  if (!have.some((m) => m.key === nightsBy)) nightsBy = have[0].key;
  const m = NIGHT_MEASURES.find((x) => x.key === nightsBy);
  $("nights-by").innerHTML = have.map((x) => `<button data-k="${x.key}" aria-pressed="${x.key === nightsBy}">${x.label}</button>`).join("");
  $("nights-by").onclick = (e) => {
    const k = e.target.closest("button")?.dataset.k;
    if (!k) return;
    nightsBy = k; try { localStorage.setItem("nightsBy", k); } catch {}
    renderNights();
  };
  $("nights-hint").textContent = m.hint;
  renderPatterns();

  const pts = all.filter((r) => r[m.key]).map((r) => ({ x: nightTime(r.date), y: r[m.key], r }));
  // 7-day average over the nights you wore it, so the trend shows through night-to-night noise
  const trend = pts.filter((p) => p.x >= start).map((p) => {
    const win = pts.filter((q) => q.x <= p.x && q.x > p.x - 7 * 864e5);
    return { x: p.x, y: win.reduce((t, q) => t + q.y, 0) / win.length };
  });
  const dots = pts.filter((p) => p.x >= start);
  const worn = shown.length, days = Math.max(1, Math.round((Date.now() - Math.max(start, nightTime(all[0].date))) / 864e5) + 1);
  if (trend.length > 1) {
    const change = trend.at(-1).y - trend[0].y;
    const flat = Math.abs(change) < Math.abs(trend[0].y) * 0.02;
    const since = state.range === "All" ? "since your first night" : `over ${state.range}`;
    const unit = m.unit ? `<small>${m.unit}</small>` : "";
    const chg = m.key === "sleep_s" ? fmtTotal(Math.abs(change)) : `${fmtNum(Math.abs(change))}${m.unit ? ` ${m.unit}` : ""}`;
    $("nights-head").innerHTML = `<span class="big">${m.fmt(trend.at(-1).y)}${unit}</span>
      <span class="chg ${!flat && Math.sign(change) === m.better ? "up" : ""}">${flat ? "Steady" : `${change > 0 ? "▲" : "▼"} ${chg}`} ${since}</span>
      <span class="dim">7-day average</span>`;
  } else $("nights-head").innerHTML = "";
  $("nights-key").innerHTML = `<span>Worn ${worn} of ${Math.min(days, rangeDays() || days)} nights in this range; nights without the watch are left out, not guessed.</span>`;

  const color = cssVar(m.color);
  const opts = chartBase();
  opts.interaction = { mode: "nearest", intersect: false };
  timeAxis(opts);
  if (m.key === "sleep_s") { opts.scales.y.ticks.callback = (v) => `${v / 3600}h`; opts.scales.y.ticks.stepSize = 3600 * 2; opts.scales.y.beginAtZero = true; }
  else opts.scales.y.ticks.callback = (v) => `${v}${m.unit ? ` ${m.unit}` : ""}`;
  opts.plugins.tooltip = { filter: (i) => !i.dataset.quiet, callbacks: {
    title: (i) => `Night before ${nightDate(i[0].raw.r?.date || isoDay(new Date(i[0].parsed.x)))}`,
    label: (i) => (i.dataset.avg ? `7-day average: ${m.fmt(i.parsed.y)}${m.unit ? ` ${m.unit}` : ""}` : nightLabel(i.raw.r, m)),
  } };
  const band = m.band ? dots.filter((p) => p.r.hrv_low && p.r.hrv_high) : [];
  drawChart("nights", "nights", {
    type: m.bars ? "bar" : "scatter",
    data: { datasets: [
      m.bars
        ? { data: dots, backgroundColor: color + "88", barThickness: "flex", maxBarThickness: 8, order: 2 }
        : { data: dots, backgroundColor: color + "66", pointRadius: 3, pointHoverRadius: 5, order: 1 },
      // the line breaks across a stretch of 4+ nights without the watch
      { type: "line", avg: true, data: trend, borderColor: m.bars ? cssVar("--text-secondary") : color, borderWidth: 2, pointRadius: 0, cubicInterpolationMode: "monotone", spanGaps: 4 * 864e5, order: 0 },
      ...(band.length ? [
        { type: "line", quiet: true, data: band.map((p) => ({ x: p.x, y: p.r.hrv_low })), borderWidth: 0, pointRadius: 0, fill: false, spanGaps: 4 * 864e5 },
        { type: "line", quiet: true, data: band.map((p) => ({ x: p.x, y: p.r.hrv_high })), borderWidth: 0, pointRadius: 0, backgroundColor: color + "1c", fill: "-1", spanGaps: 4 * 864e5 },
      ] : []),
    ] },
    options: opts,
  });
}

// What your nights say: one line per finding, folded away under the chart
function renderPatterns() {
  const p = state.nights?.patterns;
  if (!$("patterns-fold")) return;
  const runs = p?.sleep_and_runs || [];
  // nothing clear either way: one line for both kinds of poor night, not two that read alike
  const poor = runs.length > 1 && runs.every((x) => !x.clear)
    ? [`Poor nights: no clear effect on your easy runs. After short nights (${runs[0].runs} runs) and low-HRV nights (${runs[1].runs} runs) they were about as efficient as your others.`]
    : runs.map((x) => x.text);
  const lines = p ? [...poor, ...p.recovery.map((x) => x.text), ...(p.bedtime ? [p.bedtime.text] : [])] : [];
  $("patterns-fold").hidden = !lines.length;
  $("patterns").innerHTML = lines.map((t) => {
    const [head, ...rest] = t.split(": ");  // "Long runs: HRV dips…" → a bold lead-in
    return `<li>${rest.length && head.length < 30 ? `<b>${esc(head)}:</b> ${esc(rest.join(": "))}` : esc(t)}</li>`;
  }).join("");
}

function nightLabel(r, m) {
  if (!r) return "";
  const parts = [
    r.sleep_s && `${fmtTotal(r.sleep_s)} asleep${r.sleep_score ? ` (score ${Math.round(r.sleep_score)})` : ""}`,
    r.resting_hr && `resting HR ${Math.round(r.resting_hr)}`,
    r.hrv && `HRV ${Math.round(r.hrv)} ms${r.hrv_low ? ` (normal ${Math.round(r.hrv_low)}–${Math.round(r.hrv_high)})` : ""}`,
    r.respiration && `breathing ${r.respiration.toFixed(1)}/min`,
  ].filter(Boolean);
  return parts.join(" · ");
}
