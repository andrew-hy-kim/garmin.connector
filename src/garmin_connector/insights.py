"""Coach notes: rule-based feedback on a workout and on your training overall.

Everything here runs locally from data already in the database. Each insight
is ``{"level": "good" | "info" | "warn", "title": str, "detail": str}``.
Paces are left to the dashboard (it knows your units), so notes speak in
heart rate, time and percentages.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import date, timedelta
from statistics import median
from typing import Any

from . import analysis, processing

EASY_TYPES = {"easy", "recovery", "long", "easy_strides"}


def _note(level: str, title: str, detail: str) -> dict[str, str]:
    return {"level": level, "title": title, "detail": detail}


def _mins(seconds: float) -> str:
    return f"{round(seconds / 60)} min"


def _runs(conn: sqlite3.Connection, since: str | None = None) -> list[dict[str, Any]]:
    """Runs with their metrics, oldest first."""
    rows = conn.execute(
        "SELECT a.activity_id, a.start_time_local, a.distance_m, a.duration_s, a.activity_type, m.trimp, m.data "
        "FROM activities a JOIN activity_metrics m USING (activity_id) "
        "WHERE a.activity_type LIKE '%run%' AND (? IS NULL OR a.start_time_local >= ?) "
        "ORDER BY a.start_time_local",
        (since, since),
    ).fetchall()
    out = []
    for r in rows:
        m = json.loads(r["data"])
        out.append({**dict(r), "metrics": m, "date": r["start_time_local"][:10],
                    "workout": (m.get("workout") or {}).get("type")})
    return out


# ---------------------------------------------------------------- one workout

def workout_insights(conn: sqlite3.Connection, activity_id: int) -> list[dict[str, str]]:
    row = conn.execute(
        "SELECT a.activity_type, a.start_time_local, m.data FROM activities a "
        "JOIN activity_metrics m USING (activity_id) WHERE activity_id = ?", (activity_id,)
    ).fetchone()
    if row is None or not analysis.is_run(row["activity_type"]):
        return []
    m = json.loads(row["data"])
    settings = processing.effective_settings(conn)
    lthr = settings["lthr"]
    workout = m.get("workout") or {}
    kind = workout.get("type")
    notes: list[dict[str, str]] = []

    if workout:
        notes.append(_note("info", f"Tagged: {workout['label']}", workout["reason"]))

    # Easy days should stay easy
    bands = m.get("intensity_seconds")
    if kind in EASY_TYPES and bands:
        above = bands[1] + bands[2] + bands[3]
        total = sum(bands) or 1
        if above >= 10 * 60 and above / total >= 0.15 and kind != "long":
            notes.append(_note(
                "warn", "Easy run crept into tempo",
                f"{_mins(above)} ({above / total:.0%}) was above 90% of threshold HR "
                f"({round(0.9 * lthr)} bpm). Keeping easy days under that lets you recover "
                f"and get more out of the hard sessions."))
        elif above / total < 0.05:
            notes.append(_note("good", "Kept it easy",
                               f"{1 - above / total:.0%} of the run was below {round(0.9 * lthr)} bpm, "
                               f"right where easy running should be."))

    # Heart-rate drift on steady running
    drift = m.get("decoupling_pct")
    if drift is not None:
        if drift < 5:
            notes.append(_note("good", f"Low HR drift ({drift:.1f}%)",
                               "Heart rate stayed steady relative to pace. That's a sign of a solid "
                               "aerobic base for this distance."))
        elif drift < 8:
            notes.append(_note("info", f"Some HR drift ({drift:.1f}%)",
                               "Heart rate rose relative to pace in the second half. Normal on warm days "
                               "or longer runs; if it's routine at this distance, more easy volume helps."))
        else:
            notes.append(_note("warn", f"High HR drift ({drift:.1f}%)",
                               "Heart rate climbed a lot relative to pace. Common causes: heat, not enough "
                               "fluid or fuel, starting too fast, or accumulated fatigue."))

    # Interval execution
    reps = [r for r in m.get("reps") or [] if r.get("seconds")]
    if reps:
        # Compare like with like: reps of similar length, on grade-adjusted pace so hills don't count.
        typical = sorted(r["seconds"] for r in reps)[len(reps) // 2]
        reps = [r for r in reps if abs(r["seconds"] / typical - 1) <= 0.15
                and (r.get("gap_mps") or (r.get("meters") and r["meters"] / r["seconds"]))]
    if kind and kind.startswith("intervals") or kind == "speed":
        if len(reps) >= 3:
            speeds = [r.get("gap_mps") or r["meters"] / r["seconds"] for r in reps]
            spread = (max(speeds) - min(speeds)) / (sum(speeds) / len(speeds))
            fade = speeds[0] / speeds[-1] - 1 if speeds[-1] else 0
            if fade > 0.04:
                notes.append(_note("warn", f"Reps faded {fade:.0%}",
                                   "The last rep was noticeably slower than the first (grade-adjusted). "
                                   "Starting a touch slower usually gives more total quality."))
            elif spread < 0.04:
                notes.append(_note("good", "Even reps",
                                   f"All {len(reps)} reps were within {spread:.0%} of each other in "
                                   f"grade-adjusted pace. Well-judged pacing."))
            peaks = [r["peak_hr"] for r in reps if r.get("peak_hr")]
            if peaks and kind == "intervals_threshold" and max(peaks) > lthr * 1.03:
                notes.append(_note("info", "Drifted above threshold",
                                   f"Heart rate peaked at {round(max(peaks))} bpm, above your threshold of "
                                   f"{round(lthr)}. For threshold work, holding just under it builds the "
                                   f"most fitness for the recovery it costs."))

    # Pacing and form on steady runs
    pacing = m.get("pacing") or {}
    halves = pacing.get("speed_halves") or []
    if kind in ("easy", "long", "tempo", "threshold") and len(halves) == 2 and all(halves):
        change = halves[1] / halves[0] - 1
        if change >= 0.02:
            notes.append(_note("good", "Negative split", f"Second half was {change:.0%} faster than the first."))
        elif change <= -0.05:
            notes.append(_note("info", "Slowed in the second half",
                               f"Second half was {-change:.0%} slower. If that wasn't planned, start a little "
                               f"easier next time."))
    cadence = pacing.get("cadence_thirds") or []
    if kind == "long" and len(cadence) == 2 and all(cadence) and cadence[0] - cadence[1] >= 4:
        notes.append(_note("info", "Cadence dropped late",
                           f"Cadence fell from {round(cadence[0])} to {round(cadence[1])} steps/min in the last "
                           f"third, a typical sign of tiring legs. Short, quick steps help late in long runs."))

    # Compared with your recent runs
    day = row["start_time_local"][:10]
    since = (date.fromisoformat(day) - timedelta(days=42)).isoformat()
    history = [r for r in _runs(conn, since) if r["date"] < day]
    eff = m.get("efficiency")
    easy_effs = [r["metrics"].get("efficiency") for r in history
                 if r["workout"] in EASY_TYPES and r["metrics"].get("efficiency")]
    if eff and kind in EASY_TYPES and len(easy_effs) >= 4:
        typical = median(easy_effs)
        change = eff / typical - 1
        if change >= 0.03:
            notes.append(_note("good", "More efficient than usual",
                               f"You covered {change:.0%} more distance per heartbeat than your typical easy "
                               f"run over the last 6 weeks."))
        elif change <= -0.05:
            notes.append(_note("info", "Less efficient than usual",
                               f"{-change:.0%} less distance per heartbeat than your recent easy runs. Heat, "
                               f"poor sleep, stress, fatigue or illness can all do this. Worth an easy day if "
                               f"it keeps happening."))
    loads = [r["trimp"] for r in history if r["trimp"]]
    if m.get("trimp") and len(loads) >= 6 and m["trimp"] > max(loads):
        notes.append(_note("info", "Hardest session in 6 weeks",
                           f"Training load {round(m['trimp'])}, above anything since {since}. Plan an easy "
                           f"day or two after it."))

    # Personal bests within this run
    all_runs = _runs(conn) if m.get("best_efforts") else []
    for label, effort in (m.get("best_efforts") or {}).items():
        others = [r["metrics"].get("best_efforts", {}).get(label, {}).get("seconds")
                  for r in all_runs if r["activity_id"] != activity_id]
        others = [o for o in others if o]
        if others and effort["seconds"] < min(others):
            notes.append(_note("good", f"New best {label}: {analysis._fmt_s(effort['seconds'])}",
                               "Your fastest on record."))
    return notes


# ---------------------------------------------------------------- overall

FORM_STATES = [
    # (min form as share of fitness, key, label, advice)
    (0.10, "fresh", "Fresh",
     "You're well rested. Good for a race or a hard session; weeks of this means fitness is slipping."),
    (-0.10, "neutral", "Maintaining",
     "Training and recovery are balanced. You can train normally."),
    (-0.30, "productive", "Productive training",
     "You're carrying the fatigue that builds fitness. Keep easy days easy and sleep well."),
    (-9.0, "overreaching", "Overreaching",
     "Fatigue is far above your fitness. Take 2–3 easy or rest days before the next hard session."),
]


def form_state(fitness: float, form: float) -> dict[str, str]:
    ratio = form / fitness if fitness > 1 else 0.0
    for floor, key, label, advice in FORM_STATES:
        if ratio >= floor:
            return {"key": key, "label": label, "advice": advice, "ratio": round(ratio, 3)}
    return {}


def overview_insights(conn: sqlite3.Connection) -> list[dict[str, str]]:
    notes: list[dict[str, str]] = []
    load = processing.training_load_series(conn)
    today = date.today()

    if len(load) >= 8:
        now, week_ago = load[-1], load[-8]
        state = form_state(now["fitness"], now["form"])
        level = {"overreaching": "warn", "fresh": "info"}.get(state["key"], "good")
        notes.append(_note(level, f"Form: {state['label']}", state["advice"]))
        if week_ago["fitness"] > 5:
            ramp = now["fitness"] / week_ago["fitness"] - 1
            if ramp > 0.08:
                notes.append(_note("warn", f"Fitness ramping fast (+{ramp:.0%} this week)",
                                   "Load is climbing faster than most bodies adapt to. Hold this week's "
                                   "volume steady before adding more."))
            elif ramp < -0.08:
                notes.append(_note("info", f"Fitness dropping ({ramp:.0%} this week)",
                                   "Normal during a taper, illness or a break. Otherwise, it's time to "
                                   "rebuild consistency."))

    runs = _runs(conn, (today - timedelta(days=56)).isoformat())

    def km(rs):
        return sum((r["distance_m"] or 0) for r in rs) / 1000

    last7 = [r for r in runs if r["date"] > (today - timedelta(days=7)).isoformat()]
    prev21 = [r for r in runs if (today - timedelta(days=28)).isoformat() < r["date"] <= (today - timedelta(days=7)).isoformat()]
    if prev21 and km(prev21) > 0:
        base = km(prev21) / 3
        change = km(last7) / base - 1 if base else 0
        if change > 0.20:
            notes.append(_note("warn", f"Mileage up {change:.0%} on your recent average",
                               "Big jumps in running volume are the most common route to injury. Around "
                               "10% at a time is a safer build."))

    last28 = [r for r in runs if r["date"] > (today - timedelta(days=28)).isoformat()]
    bands = [r["metrics"].get("intensity_seconds") for r in last28 if r["metrics"].get("intensity_seconds")]
    if len(bands) >= 6:
        totals = [sum(b[i] for b in bands) for i in range(4)]
        easy_share = totals[0] / (sum(totals) or 1)
        tempo_share = totals[1] / (sum(totals) or 1)
        if easy_share < 0.75:
            notes.append(_note("warn", f"Only {easy_share:.0%} of your running was easy",
                               "Most of the gains come from lots of easy running plus a little hard "
                               "running (roughly 80/20). Slowing your easy days down will likely make "
                               "your hard days better."))
        else:
            notes.append(_note("good", f"{easy_share:.0%} easy, {1 - easy_share:.0%} harder over 4 weeks",
                               "A healthy balance between easy volume and intensity."))
        if tempo_share > 0.15:
            notes.append(_note("info", "Lots of time in the tempo 'gray zone'",
                               f"{tempo_share:.0%} of your running sits between easy and threshold. It's "
                               f"tiring without being targeted; make easy runs easier and hard sessions "
                               f"more deliberate."))

    quality14 = [r for r in runs if r["date"] > (today - timedelta(days=14)).isoformat()
                 and (r["metrics"].get("workout") or {}).get("quality")]
    quality7 = [r for r in quality14 if r["date"] > (today - timedelta(days=7)).isoformat()]
    if runs and not quality14:
        notes.append(_note("info", "No workouts in two weeks",
                           "All easy running lately. If you're building toward a goal, one tempo or "
                           "interval session a week adds a lot."))
    if len(quality7) >= 3:
        notes.append(_note("warn", f"{len(quality7)} hard sessions in 7 days",
                           "That's a lot of intensity. Two quality days a week is plenty for most runners."))

    if last7:
        longest = max(r["distance_m"] or 0 for r in last7)
        if km(last7) > 15 and longest / 1000 / km(last7) > 0.40:
            notes.append(_note("info", "Long run is a big share of your week",
                               f"Your longest run was {longest / 1000 / km(last7):.0%} of this week's "
                               f"distance. Spreading volume more evenly lowers injury risk."))

    effs = [(r["date"], r["metrics"].get("efficiency")) for r in runs
            if r["workout"] in EASY_TYPES and r["metrics"].get("efficiency")]
    recent = [e for d, e in effs if d > (today - timedelta(days=21)).isoformat()]
    earlier = [e for d, e in effs if d <= (today - timedelta(days=21)).isoformat()]
    if len(recent) >= 3 and len(earlier) >= 3:
        change = median(recent) / median(earlier) - 1
        if change >= 0.02:
            notes.append(_note("good", f"Aerobic efficiency up {change:.0%}",
                               "You're covering more distance per heartbeat on easy runs than a month ago. "
                               "Your aerobic fitness is improving."))
        elif change <= -0.03:
            notes.append(_note("info", f"Aerobic efficiency down {-change:.0%}",
                               "Less distance per heartbeat on easy runs than a month ago. Often fatigue, "
                               "heat or a training break."))

    vo2 = conn.execute("SELECT date, value FROM vo2max WHERE sport = 'running' ORDER BY date").fetchall()
    if len(vo2) >= 2:
        month_ago = [v for d, v in vo2 if d <= (today - timedelta(days=30)).isoformat()]
        if month_ago and vo2[-1][1] - month_ago[-1] >= 1:
            notes.append(_note("good", f"VO2 max up to {vo2[-1][1]:.0f}",
                               f"Up from {month_ago[-1]:.0f} a month ago."))
    return notes
