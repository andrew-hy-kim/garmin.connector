// Recap: each full year of running as a colour band of big numbers, like a year-end music recap.

const R = { data: null };
const MARATHON_M = 42195, EVEREST_M = 8849, PIZZA_KCAL = 285;
const MONTHS = "JFMAMJJASOND";
const BEST_LABEL = { "1 mile": "Mile", "5 km": "5K", "10 km": "10K", "Half marathon": "Half", "Marathon": "Marathon" };

const distNum = (m, digits) => { const v = dist(m); return fmtNum(v, digits ?? (v >= 100 ? 0 : 1)); };
const distHtml = (m, digits) => `${distNum(m, digits)}<small>${Units.get()}</small>`;
const shortDate = (iso) => fmtDate(iso, { month: "short", day: "numeric" });
const plural = (n, one, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;
const pct = (v) => `${Math.round(v * 100)}%`;

// What stood out most in the year (worked out on the Mac, see recap.py) -> its title and one line
function headline(y) {
  const vo2 = y.vo2;
  const longest = y.longest ? `${esc(y.longest.name || "your longest run")} on ${shortDate(y.longest.date)}` : "";
  const t = {
    marathon: ["The Marathon Year", `${distNum(y.meters)} ${Units.get()} across ${y.runs} runs, building to ${longest}.`],
    half: ["The Half Marathon Year", `${distNum(y.meters)} ${Units.get()}, and a ${distNum(y.longest.meters)}-${Units.get()} long run: ${longest}.`],
    engine: ["The Engine Year", `Your VO2max shape climbed from ${vo2?.start.toFixed(1)} to ${vo2?.end.toFixed(1)}${y.easy_share != null ? `, with ${pct(y.easy_share)} of your runs easy` : ""}. Slow down, speed up.`],
    big: ["The Big-Miles Year", `${distNum(y.meters)} ${Units.get()}, more than any other year.`],
    steady: ["The Steady Year", `${y.runs} runs${y.runs === y.days_run ? `, never two in one day` : ""}${y.easy_share != null ? `, ${pct(y.easy_share)} of them easy` : ""}, and a VO2max that held around ${vo2?.end.toFixed(0)}.`],
    trail: ["The Trail Year", `${plural(y.runs, "run")}, and ${fmtNum(Object.values(y.cross_hours).reduce((a, b) => a + b, 0))} hours of everything else.`],
    quiet: ["The Quiet Year", `${plural(y.runs, "run")}, ${distNum(y.meters)} ${Units.get()}. Every runner has one.`],
    building: ["The Building Year", `${plural(y.runs, "run")} and ${distNum(y.meters)} ${Units.get()}: the base for what came next.`],
  };
  return t[y.kind] || t.building;
}

function monthBars(meters) {
  const max = Math.max(...meters);
  const names = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  return `<div class="months" role="img" aria-label="${esc(`${Units.get()} by month: ${meters.map((m, i) => `${names[i]} ${distNum(m)}`).join(", ")}`)}">${
    meters.map((m, i) => { const top = m === max && max > 0;
      return `<div class="${top ? "top" : ""}">${top ? `<em>${distNum(m, 0)}</em>` : ""}<i style="height:${max ? Math.max(2, (m / max) * 100) : 2}%"></i><span>${MONTHS[i]}</span></div>`; }).join("")}</div>`;
}

function card(cls, label, body) { return `<div class="rc ${cls}"><span class="label">${label}</span>${body}</div>`; }
const note = (html) => `<p class="rnote">${html}</p>`;

function yearCards(y) {
  const u = Units.get();
  const best = R.data.all_time_bests || {};
  const vo2 = y.vo2;
  const pop = { marathon: "distance", big: "distance", engine: "vo2", steady: "days" }[y.kind] || "distance";
  const p = (key) => (pop === key ? "pop" : "");
  const cards = [];
  cards.push(card(`w3 ${p("distance")}`, "Distance", `<span class="big">${distHtml(y.meters, 0)}</span>` +
    note(`About <b>${fmtNum(y.meters / MARATHON_M, 0)} marathons</b>' worth${y.avg_mps ? `, at an average <b>${fmtPace(y.avg_mps)}</b>` : ""}. <b>${fmtNum(y.seconds / 3600)} hours</b> of running.`)));
  cards.push(card(`w3 ${p("days")}`, "Days you ran", `<span class="big">${fmtNum(y.days_run)}<small>days</small></span>` +
    note(`${plural(y.runs, "run")}${y.runs === y.days_run ? `, <b>never two in one day</b>` : ""}. Longest streak: <b>${plural(y.day_streak, "day")}</b>; <b>${y.week_streak} weeks</b> in a row with a run.`)));
  const topMonth = y.by_month_m.indexOf(Math.max(...y.by_month_m));
  cards.push(card("w4", `${u === "mi" ? "Miles" : "Kilometres"} by month`, monthBars(y.by_month_m) +
    note(`${new Date(2000, topMonth, 1).toLocaleDateString(undefined, { month: "long" })} led with <b>${distNum(y.by_month_m[topMonth])} ${u}</b>.${y.top_week ? ` Biggest week: <b>${distNum(y.top_week.meters)} ${u}</b>, the week of ${shortDate(y.top_week.start)}.` : ""}`)));
  cards.push(card("w2", "Climbing", `<span class="big">${fmtNum(elevUnit(y.climb_m))}<small>${u === "mi" ? "ft" : "m"}</small></span>` +
    note(`<b>${pct(y.climb_m / EVEREST_M)} of an Everest</b>.`)));
  if (y.workouts.length) cards.push(card("w3", "Your top run types",
    `<ol class="top">${y.workouts.map(([label, n]) => `<li>${esc(label)} <span class="n">${n}</span></li>`).join("")}</ol>`));
  const bests = Object.entries(BEST_LABEL).filter(([k]) => y.bests[k]);
  if (bests.length || y.longest) cards.push(card("w3", "Fastest efforts",
    (bests.length ? `<div class="prs">${bests.map(([k, label]) => { const b = y.bests[k];
      return `<a href="${pageUrl("activity", { id: b.activity_id })}">${label}<b>${fmtDuration(b.seconds)}</b>${b.seconds === best[k] ? `<span class="best">All-time best</span>` : `<span>${shortDate(b.date)}</span>`}</a>`; }).join("")}</div>` : "") +
    (y.longest ? note(`Longest run: <b>${distNum(y.longest.meters)} ${u}</b> on ${shortDate(y.longest.date)}.`) : "")));
  if (vo2) cards.push(card(`w3 ${p("vo2")}`, "Aerobic fitness",
    `<div class="vo2"><span class="big">${vo2.start.toFixed(1)}</span><span class="arrow">→</span><span class="big">${vo2.end.toFixed(1)}</span></div>` +
    note(`VO2max shape, start to end of the year. Peak <b>${vo2.peak.toFixed(1)}</b> on ${shortDate(vo2.peak_date)}${R.data.top_vo2 && vo2.peak >= R.data.top_vo2.vo2max ? `, <b>your all-time high</b>` : ""}.${y.efficiency ? ` Easy-run efficiency: <b>${y.efficiency.toFixed(2)} m per heartbeat</b>.` : ""}`)));
  if (y.weekday && y.time_of_day) cards.push(card("w3", "Your running personality",
    `<span class="mid">${y.weekday[0]} ${y.time_of_day[0].toLowerCase()} runner</span>` +
    note(`${y.weekday[0]}s were your day (<b>${plural(y.weekday[1], "run")}</b>), ${y.time_of_day[0].toLowerCase()} your time (<b>${plural(y.time_of_day[1], "run")}</b>).${y.avg_hr ? ` Average heart rate <b>${y.avg_hr} bpm</b>.` : ""}`)));
  if (y.places.length) cards.push(card("w2", "Where", `<ol class="top">${y.places.map(([pl, n]) => `<li>${esc(pl)} <span class="n">${n}</span></li>`).join("")}</ol>`));
  if (y.hottest && y.coldest) cards.push(card("w2", "Weather",
    `<span class="mid">${fmtTemp(y.coldest.temp_c)} to ${fmtTemp(y.hottest.temp_c)}</span>` +
    note(`Coldest ${shortDate(y.coldest.date)}, hottest ${shortDate(y.hottest.date)}${y.hottest.place ? ` (${esc(y.hottest.place)})` : ""}. <b>${plural(y.rainy_runs, "run")}</b> in the rain.`)));
  const crossTotal = Object.values(y.cross_hours).reduce((a, b) => a + b, 0);
  cards.push(card("w2", "Off the run", `<span class="mid">${fmtNum(crossTotal)} hours</span>` +
    note(`${Object.entries(y.cross_hours).slice(0, 3).map(([k, h]) => `${k.toLowerCase()} <b>${fmtNum(h, 1)} h</b>`).join(", ") || "All running, no cross-training"}. <b>${fmtNum(y.active_kcal)} kcal</b> burned in all, about ${fmtNum(y.active_kcal / PIZZA_KCAL)} slices of pizza.`)));
  return cards.join("");
}

function render() {
  const d = R.data;
  const years = d.years;
  $("recap-empty").hidden = years.length > 0;
  if (!years.length) return;
  const u = Units.get();
  const sum = (k) => years.reduce((t, y) => t + y[k], 0);
  const first = years.at(-1).year, last = years[0].year;
  $("today").textContent = `${first === last ? first : `${first} to ${last}`} · every full year of your running`;
  $("recap-totals").innerHTML = [
    [fmtNum(sum("runs")), "runs"], [distNum(sum("meters"), 0), `${u === "mi" ? "miles" : "kilometres"}`],
    [fmtNum(sum("seconds") / 3600), "hours running"],
    ...(d.top_vo2 ? [[d.top_vo2.vo2max.toFixed(1), `top VO2max shape (${fmtMonthYear(localDate(d.top_vo2.date))})`]] : []),
  ].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join("");

  const full = years.filter((y) => y.runs >= 60), small = years.filter((y) => y.runs < 60);
  $("recap-jump").innerHTML = full.map((y) => `<a href="#y${y.year}">${y.year}</a>`).join("") +
    (small.length ? `<a href="#y-small">${small.length === 1 ? small[0].year : `${small.at(-1).year}–${String(small[0].year).slice(2)}`}</a>` : "") +
    (years.length > 1 ? `<a href="#recap-compare">Side by side</a>` : "");

  const band = (y) => { const [title, line] = headline(y);
    return `<section class="recap-year c${y.year % 6}" id="y${y.year}"><div class="open"><div class="num">${y.year}</div>
      <div><h2>${title}</h2><p>${line}</p></div></div><div class="rcards">${yearCards(y)}</div></section>`; };
  const smallBand = small.length ? `<section class="recap-year small" id="y-small"><div class="open"><div class="num">${small.length === 1 ? small[0].year : `${String(small.at(-1).year).slice(2)}–${String(small[0].year).slice(2)}`}</div>
      <div><h2>${small.length === 1 ? "A smaller year" : "The smaller years"}</h2><p>Fewer runs, still part of the story.</p></div></div>
      <div class="trio">${small.map((y) => `<div class="rc"><h3>${y.year}</h3><span class="mid">${headline(y)[0].replace("The ", "")}</span>
        ${note(`<b>${plural(y.runs, "run")}</b>, ${distNum(y.meters)} ${u}.${y.longest ? ` Longest: <b>${distNum(y.longest.meters)} ${u}</b>.` : ""}${Object.keys(y.cross_hours).length ? ` Plus <b>${fmtNum(Object.values(y.cross_hours).reduce((a, b) => a + b, 0))} hours</b> of ${Object.keys(y.cross_hours)[0].toLowerCase()} and more.` : ""}`)}
        ${monthBars(y.by_month_m)}</div>`).join("")}</div></section>` : "";
  $("recap-years").innerHTML = full.map(band).join("") + smallBand;

  // side by side, with the best of each column highlighted
  $("recap-compare").hidden = years.length < 2;
  const cols = [
    ["Runs", (y) => y.runs, (v) => fmtNum(v), 1],
    ["Distance", (y) => y.meters, (v) => `${distNum(v, 0)} ${u}`, 1],
    ["Time", (y) => y.seconds, (v) => `${fmtNum(v / 3600)} h`, 1],
    ["Avg pace", (y) => y.avg_mps, (v) => fmtPace(v, u, false), 1],
    ["Avg HR", (y) => y.avg_hr, (v) => `${v}`, -1],
    ["Peak VO2max", (y) => y.vo2?.peak, (v) => v.toFixed(1), 1],
    ["Best mile", (y) => y.bests["1 mile"]?.seconds, (v) => fmtDuration(v), -1],
  ];
  $("recap-compare-head").innerHTML = `<tr><th>Year</th>${cols.map(([h]) => `<th class="num">${h}</th>`).join("")}</tr>`;
  const bestOf = cols.map(([, get, , dir]) => { const vals = years.map(get).filter((v) => v != null); return vals.length ? (dir > 0 ? Math.max(...vals) : Math.min(...vals)) : null; });
  $("recap-compare-rows").innerHTML = years.map((y) => `<tr><td>${y.year}</td>${cols.map(([, get, fmt], i) => {
    const v = get(y); return `<td class="num ${v != null && v === bestOf[i] ? "win" : ""}">${v == null ? `<span class="dim">–</span>` : fmt(v)}</td>`; }).join("")}</tr>`).join("");

  const cur = d.current;
  $("recap-foot").textContent = cur ? `${cur.year} is still being written: ${plural(cur.runs, "run")} and ${distNum(cur.meters, 0)} ${u} so far${cur.through ? `, through ${shortDate(cur.through)}` : ""}. Its recap appears here once the year is over.` : "";
}

async function load() {
  R.data = await getJSON("/api/recap");
  render();
  ready();
}
unitsToggle($("units"), () => R.data && render());
load().catch((err) => { ready(); setStatus(`Couldn't load the recap: ${err.message}`, true); });
