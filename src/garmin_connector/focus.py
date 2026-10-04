"""Where to improve: your running looked at area by area over the last three months.

Coach notes react to the last week or two. This looks further back and asks where
the biggest gains are: endurance (weekly volume and long runs, as in marathon
shape), consistency, the balance of easy and hard running, quality sessions
and aerobic efficiency. Each area gets a verdict (a strength, fine, or
the thing to work on) and one concrete next step, with paces and distances taken
from your own fitness.

Distances and paces in the text are tokens (``{{d:meters}}``, ``{{p:m/s}}``) that
the dashboard shows in your units; ``insights.plain`` turns them into km for text
that leaves the dashboard.
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta
from statistics import mean, median, pstdev
from typing import Any

from . import insights

WEEKS = 12
LEVEL_RANK = {"focus": 0, "ok": 1, "strength": 2}


def d(meters: float) -> str:
    return f"{{{{d:{round(meters)}}}}}"


def p(mps: float) -> str:
    return f"{{{{p:{mps:.3f}}}}}"


def _area(key: str, title: str, level: str, headline: str, detail: str, action: str | None = None,
          priority: int = 5) -> dict[str, Any]:
    return {"key": key, "title": title, "level": level, "headline": headline, "detail": detail,
            "action": action, "priority": priority}


def _pace(perf: dict[str, Any], key: str) -> dict[str, Any] | None:
    return next((x for x in perf.get("paces") or [] if x["key"] == key), None)


def endurance(perf: dict[str, Any]) -> dict[str, Any] | None:
    shape = perf.get("marathon_shape")
    if not shape:
        return None
    pct = shape["percent"]
    level = "strength" if pct >= 90 else "ok" if pct >= 60 else "focus"
    detail = (f"Weekly distance over the last 6 months: {d(shape['weekly_km'] * 1000)} of the "
              f"{d(shape['weekly_target_km'] * 1000)} your fitness could carry. "
              f"{shape['long_runs']} long run{'s' if shape['long_runs'] != 1 else ''} over {d(13000)} in 10 weeks, "
              f"toward a target of {d(shape['long_target_km'] * 1000)}. "
              f"This matters most for the half marathon and longer.")
    if level == "strength":
        action = None
    elif shape["weekly_percent"] <= shape["long_percent"]:
        action = (f"Build weekly distance gradually, about 10% a week with an easier week every third or fourth, "
                  f"toward {d(shape['weekly_target_km'] * 1000)}.")
    elif shape["long_runs"] >= 5:
        action = (f"Your long runs are regular; extend them gradually, a little further every other week, "
                  f"toward {d(shape['long_target_km'] * 1000)}. Keep them easy.")
    else:
        action = (f"Make one run a week your long run and extend it a little each time, toward "
                  f"{d(shape['long_target_km'] * 1000)}. Keep it easy.")
    return _area("endurance", "Endurance", level, f"Marathon shape {pct}%", detail, action,
                 priority=2 if pct < 40 else 4)


def consistency(runs: list[dict[str, Any]], today: date, back: dict[str, Any] | None = None) -> dict[str, Any] | None:
    if back:
        # coming back from a break: how regularly you've run since, not the weeks off
        weeks_back = max(1, -(-(back["days_back"] + 1) // 7))
        per_week = back["runs_back"] / weeks_back
        level = "strength" if per_week >= 3 else "ok" if per_week >= 2 else "focus"
        detail = (f"Back running since {insights._day(back['back_on'])} after {insights._weeks(back['break_days'])} off: "
                  f"{back['runs_back']} run{'s' if back['runs_back'] != 1 else ''}, about {per_week:.1f} a week.")
        action = None if level == "strength" else (
            "Three short, easy runs a week rebuilds faster than one or two longer ones.")
        return _area("consistency", "Consistency", level, f"{per_week:.1f} runs a week", detail, action, priority=1)
    start = today - timedelta(days=WEEKS * 7)
    weeks = [[r for r in runs if start + timedelta(days=7 * i) < date.fromisoformat(r["date"])
              <= start + timedelta(days=7 * (i + 1))] for i in range(WEEKS)]
    active = sum(1 for w in weeks if w)
    per_week = mean(len(w) for w in weeks)
    km = [sum(r["distance_m"] or 0 for r in w) for w in weeks]
    spread = pstdev(km) / mean(km) if mean(km) else 0
    missed = WEEKS - active
    if active >= WEEKS - 1 and per_week >= 3:
        level = "strength"
    elif active <= WEEKS - 4 or per_week < 2:
        level = "focus"
    else:
        level = "ok"
    detail = (f"{per_week:.1f} runs a week on average, "
              + (f"with running in every one of the last {WEEKS} weeks. " if not missed else
                 f"{missed} of the last {WEEKS} weeks without a run. ")
              + ("Weekly distance swings a lot from week to week." if spread > 0.5 else
                 "Weekly distance is fairly even." if spread < 0.3 else ""))
    action = None
    if level != "strength":
        action = ("Aim for at least three runs every week, even short ones. Steady weeks build more fitness "
                  "than big weeks with gaps between them.")
    return _area("consistency", "Consistency", level, f"{per_week:.1f} runs a week", detail.strip(), action,
                 priority=1)


def balance(runs: list[dict[str, Any]], perf: dict[str, Any]) -> dict[str, Any] | None:
    bands = [r["metrics"].get("intensity_seconds") for r in runs if r["metrics"].get("intensity_seconds")]
    if len(bands) < 6:
        return None
    totals = [sum(b[i] for b in bands) for i in range(4)]
    total = sum(totals) or 1
    easy, tempo = totals[0] / total, totals[1] / total
    level = "strength" if easy >= 0.78 and tempo <= 0.12 else "focus" if easy < 0.7 else "ok"
    detail = (f"{easy:.0%} of your running time was easy over 8 weeks, {tempo:.0%} in the tempo range between "
              f"easy and threshold, {(totals[2] + totals[3]) / total:.0%} at threshold or harder. "
              f"Most runners improve fastest at roughly 80% easy.")
    action = None
    if level != "strength":
        e = _pace(perf, "easy")
        action = ("Slow your easy runs down" + (f" to {p(e['slow_mps'])}–{p(e['fast_mps'])}" if e else "")
                  + ", or keep heart rate in zone 2. Easy days that are truly easy make the hard days better.")
    return _area("balance", "Easy vs. hard", level, f"{easy:.0%} easy", detail, action,
                 priority=2 if easy < 0.65 else 3)


def quality(runs: list[dict[str, Any]], perf: dict[str, Any], today: date,
            back: dict[str, Any] | None = None) -> dict[str, Any] | None:
    since = (today - timedelta(days=42)).isoformat()
    recent = [r for r in runs if r["date"] > since]
    if len(recent) < 4:
        return None
    hard = [r for r in recent if (r["metrics"].get("workout") or {}).get("quality")]
    if back and back["days_back"] < 28:
        # the first weeks back are for easy running; workouts come later
        return _area("quality", "Workouts", "ok", "Rebuilding first",
                     "You're a few weeks back from a break, so easy running is the right call for now.",
                     "Add one workout a week once you've had about four weeks of steady, comfortable running.",
                     priority=5)
    per_week = len(hard) / 6
    t, i = _pace(perf, "threshold"), _pace(perf, "interval")
    if not hard:
        level, headline = "focus", "No workouts in 6 weeks"
        detail = "All of your recent running has been easy. That builds the base; a little faster running sharpens it."
        action = ("Add one session a week: a tempo of 3 × 10 minutes" + (f" at {p(t['slow_mps'])}–{p(t['fast_mps'])}" if t else "")
                  + " with 2 minutes' jog between, or later 5 × 3 minutes" + (f" at {p(i['slow_mps'])}–{p(i['fast_mps'])}" if i else " hard")
                  + ".")
        priority = 3
    elif per_week > 2.5:
        level, headline = "focus", f"{len(hard)} workouts in 6 weeks"
        detail = "More than two hard sessions most weeks. Beyond that, extra intensity adds fatigue faster than fitness."
        action = "Keep it to one or two quality sessions a week, with easy days between them."
        priority = 2
    else:
        level, headline = "strength" if per_week >= 0.8 else "ok", f"{len(hard)} workout{'s' if len(hard) != 1 else ''} in 6 weeks"
        detail = f"About {per_week:.1f} quality session{'s' if round(per_week, 1) != 1 else ''} a week, alongside your easy running."
        action = None if level == "strength" else (
            "One quality session every week, threshold or intervals, is enough to keep improving.")
        priority = 4
    return _area("quality", "Workouts", level, headline, detail, action, priority)


def efficiency(runs: list[dict[str, Any]], today: date) -> dict[str, Any] | None:
    effs = [(r["date"], r["metrics"].get("efficiency")) for r in runs
            if r["workout"] in insights.EASY_TYPES and r["metrics"].get("efficiency")]
    recent = [e for day, e in effs if day > (today - timedelta(days=28)).isoformat()]
    early = [e for day, e in effs if day <= (today - timedelta(days=56)).isoformat()]
    if len(recent) < 3 or len(early) < 3:
        return None
    change = median(recent) / median(early) - 1
    level = "strength" if change >= 0.02 else "focus" if change <= -0.03 else "ok"
    headline = f"{'+' if change >= 0 else '−'}{abs(change):.0%} in 3 months"
    detail = ("Distance covered per heartbeat on easy runs, the last 4 weeks against 2 to 3 months ago. "
              + ("Rising means your aerobic engine is getting stronger." if change >= 0.02 else
                 "Falling usually means fatigue, heat, illness or less easy volume." if change <= -0.03 else
                 "Holding steady."))
    action = None
    if level == "focus":
        action = "Check recovery first (sleep, stress, the last few weeks' load); then more easy running at a truly easy effort brings it back."
    elif level == "ok":
        action = "Easy volume is what moves this. More easy running, kept relaxed, raises it over months."
    return _area("efficiency", "Aerobic efficiency", level, headline, detail, action, priority=4)


def areas(conn: sqlite3.Connection, perf: dict[str, Any], today: date | None = None) -> list[dict[str, Any]]:
    """Each area with a verdict; the ones to work on first, most important first."""
    today = today or date.today()
    runs = insights._runs(conn, (today - timedelta(days=WEEKS * 7)).isoformat())
    if len(runs) < 6:
        return []
    last8 = [r for r in runs if r["date"] > (today - timedelta(days=56)).isoformat()]
    back = insights.comeback(insights._runs(conn, (today - timedelta(days=insights.COMEBACK_DAYS + 120)).isoformat()),
                             today.isoformat())
    out = [a for a in (consistency(runs, today, back), endurance(perf), balance(last8, perf), quality(runs, perf, today, back),
                       efficiency(runs, today)) if a]
    out.sort(key=lambda a: (LEVEL_RANK[a["level"]], a["priority"]))
    return out
