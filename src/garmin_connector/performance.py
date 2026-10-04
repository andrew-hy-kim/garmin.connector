"""Performance metrics in the style of RUNALYZE.

- **Effective VO2max** for every run with heart rate, from the relation of pace and
  heart rate (Daniels & Gilbert). Your pace says how much oxygen you used; your heart
  rate says what share of your maximum that was, so together they estimate the maximum.
- **VO2max shape**: those values averaged over the last 30 days, weighted by duration.
  If you've marked races in Garmin, the best one calibrates the estimate (the
  "correction factor"), since heart rate alone tends to under- or over-read.
- **Marathon shape**: whether your training has the endurance a long race needs:
  weekly distance over the last 6 months (2/3) and long runs over 13 km in the last
  10 weeks (1/3), against targets that grow with your VO2max.
- **Race prognosis** from VO2max shape, reduced for long races when marathon shape
  falls short (a 10K needs 17 %, a half 42 %, a marathon 100 %).
- **Training paces** (easy to repetition) from VO2max shape, Daniels-style.
- **Monotony and training strain** (Foster) over the last 7 days, **rest days** until
  you're fresh again, and the most **load you can do today** and stay balanced.

The formulas follow RUNALYZE's open-source implementation.
"""

from __future__ import annotations

import json
import math
import sqlite3
from datetime import date, timedelta
from typing import Any

from . import analysis, processing

SHAPE_DAYS = 30                        # VO2max shape: 30-day duration-weighted average
LONG_RUN_MIN_KM = 13                   # marathon shape: runs longer than this count as long runs
LONG_RUN_DAYS = 70
WEEKLY_DAYS, WEEKLY_DAYS_MIN = 182, 70
WEEKLY_SHARE = 0.67
MIN_VO2MAX, MAX_VO2MAX = 15.0, 90.0
FATIGUE_DAYS, FITNESS_DAYS = 7, 42     # the training-load model in analysis.training_load

# Daniels' training intensities, as a share of VO2max
PACE_ZONES = [
    ("easy", "Easy", 0.59, 0.74, "Most of your running: long runs, recovery, warm-ups."),
    ("marathon", "Marathon", 0.75, 0.84, "Marathon race pace; steady long-run segments."),
    ("threshold", "Threshold", 0.83, 0.88, "Comfortably hard; tempo runs and cruise intervals."),
    ("interval", "Interval", 0.95, 1.00, "3–5 minute reps with equal jog recoveries."),
    ("repetition", "Repetition", 1.05, 1.10, "Short, fast reps (200–400 m) with full recovery."),
]


# ---------------------------------------------------------------- Daniels & Gilbert

def vo2_at(meters_per_min: float) -> float:
    """Oxygen cost (ml/kg/min) of running at a speed."""
    return max(0.0, -4.6 + 0.182258 * meters_per_min + 0.000104 * meters_per_min ** 2)


def speed_at_vo2(vo2: float) -> float:
    """Speed (m/min) whose oxygen cost is ``vo2``: the inverse of vo2_at."""
    a, b, c = 0.000104, 0.182258, -4.6 - vo2
    return (-b + math.sqrt(b * b - 4 * a * c)) / (2 * a)


def drop_dead(minutes: float) -> float:
    """Share of VO2max you can hold for a race of this duration."""
    return 0.8 + 0.1894393 * math.exp(-0.012778 * minutes) + 0.2989558 * math.exp(-0.1932605 * minutes)


def vo2max_from_race(meters: float, seconds: float) -> float:
    minutes = seconds / 60
    if meters <= 0 or minutes <= 0 or not 50 <= meters / minutes <= 1000:
        return 0.0
    return vo2_at(meters / minutes) / drop_dead(minutes)


def vo2max_share_at_hr(hr_share: float) -> float:
    """Share of VO2max at a share of max heart rate (RUNALYZE's fit to Daniels' tables)."""
    return math.exp((hr_share - 1.00466) / 0.68725)


def vo2max_from_hr(meters: float, seconds: float, avg_hr: float, max_hr: float) -> float:
    """Effective VO2max: the speed you'd reach at 100 % from the speed at this heart rate."""
    if seconds <= 0 or meters <= 0 or not avg_hr or not max_hr:
        return 0.0
    speed = meters / (seconds / 60)
    return vo2_at(speed / vo2max_share_at_hr(avg_hr / max_hr))


def race_seconds(vo2max: float, meters: float) -> float | None:
    """Race time at a distance for a VO2max (bisection on the Daniels-Gilbert formula)."""
    if not MIN_VO2MAX <= vo2max <= MAX_VO2MAX:
        return None
    lo, hi = 2 * 60 * meters / 1000, 10 * 60 * meters / 1000  # 2 to 10 min per km
    for _ in range(60):
        mid = (lo + hi) / 2
        if vo2max_from_race(meters, mid) > vo2max:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


# ---------------------------------------------------------------- marathon shape

def weekly_target_km(vo2max: float) -> float:
    return max(vo2max, 25.0) ** 1.135


def long_run_target_km(vo2max: float) -> float:
    return math.log(max(vo2max, 25.0) / 4.0) * 12.0


def required_shape(km: float) -> float:
    """Marathon shape (%) a race needs: 17 % for 10K, 42 % for a half, 100 % for a marathon."""
    return km ** 1.23


def shape_factor(shape_pct: float, km: float) -> float:
    """How much of your VO2max you can use over a distance, given marathon shape."""
    factor = max(0.0, 1 - (required_shape(km) - shape_pct) / 100.0)
    return min(1.0, 0.6 + 0.4 * factor)


def marathon_shape(runs: list[dict[str, Any]], day: date, vo2max: float, first_day: date | None) -> dict[str, Any]:
    """Marathon shape on a day, from runs up to and including it."""
    weekly_days = WEEKLY_DAYS
    if first_day:
        weekly_days = max(min(WEEKLY_DAYS, (day - first_day).days), WEEKLY_DAYS_MIN)
    week_from = day - timedelta(days=weekly_days)
    long_from = day - timedelta(days=LONG_RUN_DAYS)
    long_target = long_run_target_km(vo2max) - LONG_RUN_MIN_KM
    km, points, longs = 0.0, 0.0, []
    for r in runs:
        d = r["day"]
        if d > day:
            continue
        if d > week_from:
            km += r["km"]
        if d > long_from and r["km"] > LONG_RUN_MIN_KM:
            age = (day - d).days
            weight = 2 - (2.0 / LONG_RUN_DAYS) * round(age - 0.5)   # recent long runs count up to twice
            points += weight * ((r["km"] - LONG_RUN_MIN_KM) / long_target) ** 2
            longs.append(r)
    weekly = km * 7.0 / weekly_days / weekly_target_km(vo2max)
    long_part = points * 7.0 / LONG_RUN_DAYS
    return {
        "percent": round(100 * (weekly * WEEKLY_SHARE + long_part * (1 - WEEKLY_SHARE))),
        "weekly_km": round(km * 7.0 / weekly_days, 1),
        "weekly_target_km": round(weekly_target_km(vo2max), 1),
        "weekly_percent": round(100 * weekly),
        "long_runs": len(longs),
        "long_target_km": round(long_run_target_km(vo2max), 1),
        "long_percent": round(100 * long_part),
    }


# ---------------------------------------------------------------- your runs

def _runs(conn: sqlite3.Connection, max_hr: float) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT a.activity_id, a.start_time_local, a.activity_type, a.distance_m, a.duration_s, a.moving_duration_s, "
        "a.avg_hr, a.elevation_gain_m, json_extract(a.raw_json, '$.elevationLoss') AS loss, m.data "
        "FROM activities a LEFT JOIN activity_metrics m USING (activity_id) "
        "WHERE a.activity_type LIKE '%run%' AND a.start_time_local IS NOT NULL ORDER BY a.start_time_local"
    ).fetchall()
    out = []
    for r in rows:
        m = json.loads(r["data"]) if r["data"] else {}
        seconds = r["moving_duration_s"] or r["duration_s"] or 0
        meters = r["distance_m"] or 0
        hr_ok = r["avg_hr"] and not (m.get("cadence_lock") or 0) > 0.2 and 0.5 <= r["avg_hr"] / max_hr <= 1.02 \
            and not (m.get("walk_share") or 0) > analysis.WALK_SHARE_MAX  # run/walk: walking breaks would read as low fitness
        vo2 = vo2max_from_hr(meters, seconds, r["avg_hr"], max_hr) if hr_ok and seconds >= 600 and meters >= 1500 else 0.0
        out.append({
            "activity_id": r["activity_id"], "day": date.fromisoformat(r["start_time_local"][:10]),
            "km": meters / 1000, "seconds": seconds, "meters": meters,
            "vo2max_raw": vo2 if MIN_VO2MAX <= vo2 <= MAX_VO2MAX else None,
            "race": (m.get("workout") or {}).get("type") == "race",
        })
    return out


def correction_factor(runs: list[dict[str, Any]]) -> tuple[float, dict[str, Any] | None]:
    """From your best race: its VO2max by result over its VO2max by heart rate (1.0 without races)."""
    best = None
    for r in runs:
        if r["race"] and r["vo2max_raw"]:
            by_time = vo2max_from_race(r["meters"], r["seconds"])
            if by_time and (best is None or by_time > best[0]):
                best = (by_time, r)
    if not best:
        return 1.0, None
    factor = best[0] / best[1]["vo2max_raw"]
    return max(0.7, min(1.3, factor)), best[1]


def shape_on(runs: list[dict[str, Any]], day: date, factor: float) -> float | None:
    since = day - timedelta(days=SHAPE_DAYS)
    total = weight = 0.0
    for r in runs:
        if since < r["day"] <= day and r["vo2max_raw"]:
            total += r["vo2max_raw"] * r["seconds"]
            weight += r["seconds"]
    return factor * total / weight if weight else None


# ---------------------------------------------------------------- load extras

def load_extras(series: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Monotony and training strain (last 7 days), rest days to fresh, and today's balanced load."""
    if len(series) < 7:
        return None
    week = [d["load"] for d in series[-7:]]
    avg = sum(week) / 7
    sd = math.sqrt(sum((x - avg) ** 2 for x in week) / 7)
    monotony = min(10.0, avg / sd) if sd else (10.0 if avg else 0.0)
    last = series[-1]
    # after today's load: where fitness and fatigue stand going into tomorrow
    fitness = last["fitness"]
    fatigue = last["fatigue"]
    la, lc = 1 / FATIGUE_DAYS, 1 / FITNESS_DAYS
    rest_days = 0.0
    if fatigue > 0 and fatigue > fitness:
        rest_days = math.log(max(1.0, fitness) / fatigue) / math.log((1 - la) / (1 - lc))
    balanced = max(0.0, (fitness * (1 - lc) - fatigue * (1 - la)) / (la - lc))
    return {
        "monotony": round(monotony, 2),
        "strain": round(avg * 7 * monotony),
        "week_load": round(sum(week)),
        "rest_days": math.ceil(rest_days),
        "balanced_load": round(balanced),
    }


# ---------------------------------------------------------------- everything

def summary(conn: sqlite3.Connection, today: date | None = None) -> dict[str, Any]:
    today = today or date.today()
    settings = processing.effective_settings(conn)
    runs = _runs(conn, settings["max_hr"])
    factor, calibrated_by = correction_factor(runs)
    out: dict[str, Any] = {"correction_factor": round(factor, 3),
                           "calibrated_by": calibrated_by and calibrated_by["activity_id"],
                           "per_activity": {str(r["activity_id"]): round(factor * r["vo2max_raw"], 1)
                                            for r in runs if r["vo2max_raw"]}}
    vo2 = shape_on(runs, today, factor)
    first_day = runs[0]["day"] if runs else None

    # weekly history of VO2max shape and marathon shape
    history = []
    if first_day:
        d = first_day + timedelta(days=SHAPE_DAYS)
        d = d - timedelta(days=d.weekday()) + timedelta(days=6)   # Sundays
        while d < today:
            v = shape_on(runs, d, factor)
            if v:
                history.append({"date": d.isoformat(), "vo2max": round(v, 1),
                                "marathon_shape": marathon_shape(runs, d, v, first_day)["percent"]})
            d += timedelta(days=7)
        if vo2:
            history.append({"date": today.isoformat(), "vo2max": round(vo2, 1),
                            "marathon_shape": marathon_shape(runs, today, vo2, first_day)["percent"]})
    out["history"] = history
    out["vo2max"] = round(vo2, 1) if vo2 else None

    if vo2:
        shape = marathon_shape(runs, today, vo2, first_day)
        out["marathon_shape"] = shape
        out["races"] = []
        for label, meters in analysis.BEST_EFFORT_DISTANCES.items():
            km = meters / 1000
            adjusted = vo2 * shape_factor(shape["percent"], km)
            secs = race_seconds(adjusted, meters)
            out["races"].append({"race": label, "meters": meters, "seconds": round(secs) if secs else None,
                                 "required_shape": round(required_shape(km)),
                                 "limited_by_endurance": adjusted < vo2 - 0.05})
        # the same prognosis three months ago, for the trend
        then = today - timedelta(days=91)
        vo2_then = shape_on(runs, then, factor)
        if vo2_then:
            shape_then = marathon_shape(runs, then, vo2_then, first_day)["percent"]
            for r in out["races"]:
                old = race_seconds(vo2_then * shape_factor(shape_then, r["meters"] / 1000), r["meters"])
                r["change_s"] = round(r["seconds"] - old) if r["seconds"] and old else None
        # where one pace zone ends and the next begins (between Daniels' ranges), for time in pace zones
        out["pace_bounds_mps"] = [speed_at_vo2(f * vo2) / 60 for f in (0.745, 0.835, 0.915, 1.025)]
        vmax = speed_at_vo2(vo2)
        out["paces"] = [{"key": k, "label": label, "about": about,
                         "slow_mps": speed_at_vo2(lo * vo2) / 60, "fast_mps": speed_at_vo2(hi * vo2) / 60}
                        for k, label, lo, hi, about in PACE_ZONES]
        out["vvo2max_mps"] = vmax / 60
        month_ago = [h for h in history if h["date"] <= (today - timedelta(days=28)).isoformat()]
        out["vo2max_change_4w"] = round(vo2 - month_ago[-1]["vo2max"], 1) if month_ago else None
    else:
        out["marathon_shape"] = None
        out["races"] = []
        out["paces"] = []

    out["load"] = load_extras(processing.training_load_series(conn))
    return out
