"""Year in review: each full calendar year of running, recapped like a music-app year-end story.

A year counts once it's over and your history covers all of it (it started before January 8).
Numbers are in metric units; the page shows them in yours. Each year also gets a ``kind``
(marathon, half, engine, big, steady, trail, quiet or building) that the page turns into its
title, picked from what stood out most that year.
"""

from __future__ import annotations

import json
import sqlite3
from collections import Counter, defaultdict
from datetime import date, datetime
from statistics import median
from typing import Any

from . import api, insights, performance

BESTS = ["1 mile", "5 km", "10 km", "Half marathon", "Marathon"]
FULL_BAND_RUNS = 60  # years with fewer runs share one compact section


def _is_run(a: dict[str, Any]) -> bool:
    return "run" in (a["activity_type"] or "")


def _cross_group(t: str | None) -> str:
    t = t or ""
    if any(k in t for k in ("strength", "hiit", "weight")):
        return "Strength"
    if "cycl" in t or "bik" in t:
        return "Cycling"
    if "hik" in t or "walk" in t:
        return "Hiking & walking"
    return "Other"


def _slot(hour: int) -> str:
    return ("Early morning" if hour < 8 else "Morning" if hour < 12 else "Afternoon" if hour < 17
            else "Evening" if hour < 21 else "Late night")


def _streak(days: list[date], step: int) -> int:
    best = run = 1 if days else 0
    for prev, nxt in zip(days, days[1:]):
        run = run + 1 if (nxt - prev).days == step else 1
        best = max(best, run)
    return best


def _year(acts: list[dict[str, Any]], bests_by_run: dict[int, dict], history: list[dict]) -> dict[str, Any]:
    runs = [a for a in acts if _is_run(a)]
    run_days = sorted({date.fromisoformat(a["start_time_local"][:10]) for a in runs})
    mondays = sorted({d.fromordinal(d.toordinal() - d.weekday()) for d in run_days})
    by_month = [0.0] * 12
    by_week: dict[date, float] = defaultdict(float)
    for a in runs:
        d = date.fromisoformat(a["start_time_local"][:10])
        by_month[d.month - 1] += a["distance_m"] or 0
        by_week[d.fromordinal(d.toordinal() - d.weekday())] += a["distance_m"] or 0
    top_week = max(by_week, key=by_week.get) if by_week else None
    starts = [datetime.fromisoformat(a["start_time_local"].replace(" ", "T")) for a in runs]
    longest = max(runs, key=lambda a: a["distance_m"] or 0) if runs else None

    hot = [(a["weather"]["temp_c"], a) for a in runs if (a.get("weather") or {}).get("temp_c") is not None]
    def extreme(pick):
        if not hot:
            return None
        c, a = pick(hot, key=lambda t: t[0])
        return {"temp_c": c, "date": a["start_time_local"][:10], "place": a["location"]}

    bests: dict[str, dict[str, Any]] = {}
    for a in runs:
        for name, e in (bests_by_run.get(a["activity_id"]) or {}).items():
            if name in BESTS and (name not in bests or e["seconds"] < bests[name]["seconds"]):
                bests[name] = {"seconds": round(e["seconds"]), "date": a["start_time_local"][:10], "activity_id": a["activity_id"]}

    effs = [a["efficiency"] for a in runs if a["efficiency"] and a["workout_type"] in insights.EASY_TYPES]
    hrs = [a["avg_hr"] for a in runs if a["avg_hr"]]
    cross: dict[str, float] = defaultdict(float)
    for a in acts:
        if not _is_run(a):
            cross[_cross_group(a["activity_type"])] += a["duration_s"] or 0
    seconds = sum(a["moving_duration_s"] or a["duration_s"] or 0 for a in runs)
    meters = sum(a["distance_m"] or 0 for a in runs)
    easy = sum(1 for a in runs if a["workout_type"] in insights.EASY_TYPES)
    return {
        "runs": len(runs), "meters": round(meters), "seconds": round(seconds),
        "climb_m": round(sum(a["elevation_gain_m"] or 0 for a in runs)),
        "days_run": len(run_days), "day_streak": _streak(run_days, 1), "week_streak": _streak(mondays, 7),
        "avg_mps": meters / seconds if seconds else None,
        "avg_hr": round(sum(hrs) / len(hrs)) if hrs else None,
        "easy_share": easy / len(runs) if runs else None,
        "by_month_m": [round(m) for m in by_month],
        "top_week": {"start": top_week.isoformat(), "meters": round(by_week[top_week])} if top_week else None,
        "weekday": list(Counter(s.strftime("%A") for s in starts).most_common(1)[0]) if starts else None,
        "time_of_day": list(Counter(_slot(s.hour) for s in starts).most_common(1)[0]) if starts else None,
        "longest": {"meters": round(longest["distance_m"] or 0), "date": longest["start_time_local"][:10],
                    "name": longest["name"], "activity_id": longest["activity_id"]} if longest else None,
        "workouts": Counter(a["workout_label"] for a in runs if a["workout_label"]).most_common(5),
        "places": Counter(a["location"] for a in runs if a["location"]).most_common(3),
        "hottest": extreme(max), "coldest": extreme(min),
        "rainy_runs": sum(1 for a in runs if ((a.get("weather") or {}).get("precip_mm") or 0) >= 0.5),
        "bests": bests,
        "vo2": {"start": history[0]["vo2max"], "end": history[-1]["vo2max"],
                "peak": max(h["vo2max"] for h in history),
                "peak_date": max(history, key=lambda h: h["vo2max"])["date"]} if history else None,
        "efficiency": round(median(effs), 3) if len(effs) >= 5 else None,
        "cross_hours": {k: round(v / 3600, 1) for k, v in sorted(cross.items(), key=lambda kv: -kv[1])},
        "active_kcal": round(sum(a["active_calories"] or 0 for a in acts)),
    }


def kind(y: dict[str, Any], biggest_meters: float) -> str:
    """What stood out most in a year, which the page turns into its title."""
    longest = (y["longest"] or {}).get("meters", 0)
    vo2 = y["vo2"]
    run_hours = y["seconds"] / 3600
    if longest >= 42000:
        return "marathon"
    if longest >= 21000:
        return "half"
    if vo2 and vo2["end"] - vo2["start"] >= 3:
        return "engine"
    if y["runs"] >= 100 and y["meters"] >= biggest_meters:
        return "big"
    if sum(y["cross_hours"].values()) > max(run_hours, 5) and y["runs"] < FULL_BAND_RUNS:
        return "trail"
    if y["runs"] < 30:
        return "quiet"
    if y["runs"] >= 100 and vo2 and abs(vo2["end"] - vo2["start"]) < 1.5:
        return "steady"
    return "building"


def recap(conn: sqlite3.Connection, today: date | None = None) -> dict[str, Any]:
    today = today or date.today()
    perf = performance.summary(conn)
    acts = api.activities(conn, perf)
    if not acts:
        return {"years": [], "current": None}
    bests_by_run = {r["activity_id"]: (json.loads(r["data"]) or {}).get("best_efforts") or {}
                    for r in conn.execute("SELECT activity_id, data FROM activity_metrics")}
    first = min(date.fromisoformat(a["start_time_local"][:10]) for a in acts)
    by_year: dict[int, list] = defaultdict(list)
    for a in acts:
        by_year[int(a["start_time_local"][:4])].append(a)
    full = [y for y in sorted(by_year) if y < today.year and (y > first.year or first <= date(y, 1, 7))]
    years = []
    for y in full:
        data = _year(by_year[y], bests_by_run, [h for h in perf["history"] if h["date"][:4] == str(y)])
        if data["runs"]:
            years.append({"year": y, **data})
    biggest = max((y["meters"] for y in years), default=0)
    for y in years:
        y["kind"] = kind(y, biggest)
    # all-time bests across every run, this year's included, so a recap never calls a beaten time the best
    all_time: dict[str, int] = {}
    for a in acts:
        for name, e in (bests_by_run.get(a["activity_id"]) or {}).items():
            if name in BESTS and _is_run(a):
                all_time[name] = min(all_time.get(name, 10**9), round(e["seconds"]))
    now = [a for a in by_year.get(today.year, []) if _is_run(a)]
    return {
        "years": sorted(years, key=lambda y: -y["year"]),
        "all_time_bests": all_time,
        "top_vo2": max(perf["history"], key=lambda h: h["vo2max"]) if perf["history"] else None,
        "current": {"year": today.year, "runs": len(now), "meters": round(sum(a["distance_m"] or 0 for a in now)),
                    "through": max((a["start_time_local"][:10] for a in now), default=None)} if now else None,
    }
