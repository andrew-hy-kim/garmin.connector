"""Race predictor: likely finish times at the same distances as your personal records.

Three views side by side:

- From your fitness (the main one, as RUNALYZE does it): VO2max shape from every
  run's pace and heart rate, reduced for long races when your marathon shape (weekly
  distance and long runs) is short of what the distance needs. See performance.py.
- From your fastest efforts: the fastest stretch you've run recently (best
  efforts over standard distances, found in every outdoor run), scaled to each
  race distance with Riegel's formula, ``T2 = T1 × (D2 / D1) ^ 1.06``. An
  effort has to be at least as long as the race, and for 5 km and up at least
  5 km (10 km for the marathon), so a fast interval rep doesn't predict a long
  race; long races get a note when your
  recent long runs are short of what the distance needs.
- Garmin's, as your watch shows it (saved at each sync), when available.

Each comes with the change over the last three months.
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta
from typing import Any

from . import analysis, insights, performance

# The personal-record distances, with the same names
RACES = list(analysis.BEST_EFFORT_DISTANCES.items())
# Garmin only predicts these
GARMIN_KEYS = {"5 km": "time_5k", "10 km": "time_10k", "Half marathon": "time_half", "Marathon": "time_marathon"}
WINDOW_DAYS = 90          # recent efforts only: fitness from last year doesn't predict next month
TREND_DAYS = 91           # "vs 3 months ago"
RIEGEL = 1.06
# Shortest effort that predicts a race: as long as the race itself, and for 5 km and up at
# least 5 km (a fast 1 km or mile is often a rep inside an interval session, and says little
# about holding a pace for a whole 10K), and for the marathon at least 10 km.
MIN_EFFORT_M, MIN_SHARE = 5000.0, 1 / 4.5


def shortest_effort(race_m: float) -> float:
    return min(race_m, max(MIN_EFFORT_M, race_m * MIN_SHARE))
# A long race also needs the endurance for it: longest recent run as a share of the distance.
LONG_RUN_NEEDED = {"Half marathon": 0.70, "Marathon": 0.55}


def riegel(seconds: float, meters: float, target_m: float) -> float:
    return seconds * (target_m / meters) ** RIEGEL


def _efforts(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for r in runs:
        race = r["workout"] == "race"
        for label, e in (r["metrics"].get("best_efforts") or {}).items():
            out.append({"activity_id": r["activity_id"], "date": r["date"], "label": label, "race": race, **e})
    return out


def _predict(runs: list[dict[str, Any]], as_of: date) -> dict[str, dict[str, Any]]:
    since = (as_of - timedelta(days=WINDOW_DAYS)).isoformat()
    efforts = _efforts([r for r in runs if since < r["date"] <= as_of.isoformat()])
    out = {}
    for race, meters in RACES:
        best = None
        for e in efforts:
            if e["meters"] < shortest_effort(meters) - 1:
                continue
            t = riegel(e["seconds"], e["meters"], meters)
            if best is None or t < best[0]:
                best = (t, e)
        if best:
            out[race] = {"seconds": round(best[0]), "basis": best[1]}
    return out


def _garmin(conn: sqlite3.Connection, as_of: date) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM race_predictions WHERE date <= ? ORDER BY date DESC LIMIT 1",
                       (as_of.isoformat(),)).fetchone()
    return dict(row) if row else None


def predictions(conn: sqlite3.Connection, today: date | None = None,
                perf: dict[str, Any] | None = None) -> dict[str, Any]:
    today = today or date.today()
    perf = perf or performance.summary(conn, today)
    fitness = {r["race"]: r for r in perf.get("races") or []}
    earlier = today - timedelta(days=TREND_DAYS)
    runs = insights._runs(conn, (earlier - timedelta(days=WINDOW_DAYS + 1)).isoformat())
    now, then = _predict(runs, today), _predict(runs, earlier)
    garmin_now, garmin_then = _garmin(conn, today), _garmin(conn, earlier)
    # stale Garmin numbers (no sync for a long time) would mislead
    if garmin_now and garmin_now["date"] < (today - timedelta(days=60)).isoformat():
        garmin_now = None

    since8w = (today - timedelta(days=56)).isoformat()
    longest = max(((r["distance_m"] or 0) for r in runs if r["date"] > since8w), default=0)

    out = []
    for race, meters in RACES:
        p, before = now.get(race), then.get(race)
        g = race in GARMIN_KEYS and garmin_now and garmin_now.get(GARMIN_KEYS[race])
        g_before = race in GARMIN_KEYS and garmin_then and garmin_then.get(GARMIN_KEYS[race])
        # set when your recent long runs are short of what this race needs (the page explains it)
        short_long_run = bool(p and race in LONG_RUN_NEEDED and longest < meters * LONG_RUN_NEEDED[race])
        f = fitness.get(race) or {}
        out.append({
            "race": race, "meters": meters,
            # from VO2max shape and marathon shape (RUNALYZE's model): the main prediction
            "fitness_seconds": f.get("seconds"), "fitness_change_s": f.get("change_s"),
            "endurance_limited": f.get("limited_by_endurance", False),
            "seconds": p["seconds"] if p else None,
            "change_s": p["seconds"] - before["seconds"] if p and before else None,
            "basis": p["basis"] if p else None,
            "longest_run_m": round(longest) if short_long_run else None,
            "garmin_seconds": round(g) if g else None,
            "garmin_change_s": round(g - g_before) if g and g_before else None,
        })
    return {"window_days": WINDOW_DAYS, "trend_days": TREND_DAYS, "vo2max": perf.get("vo2max"),
            "marathon_shape": (perf.get("marathon_shape") or {}).get("percent"),
            "garmin_date": garmin_now["date"] if garmin_now else None, "races": out}
