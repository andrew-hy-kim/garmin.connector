"""The data behind each dashboard view.

The Flask routes in ``web.py`` and the phone export in ``export.py`` both build
their data here, so the phone shows exactly what the Mac dashboard shows.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict
from typing import Any

from . import analysis, db, gear, insights, performance, planner, processing


def activities(conn: sqlite3.Connection, perf: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    per_run = (perf or performance.summary(conn))["per_activity"]
    rows = conn.execute(
        "SELECT a.activity_id, a.name, a.activity_type, a.start_time_local, a.distance_m, a.duration_s, "
        "a.moving_duration_s, a.elevation_gain_m, a.avg_hr, a.max_hr, a.avg_speed_mps, a.calories, "
        "a.avg_power_w, a.aerobic_te, a.anaerobic_te, a.vo2max, a.location, "
        "m.trimp, m.decoupling_pct, m.efficiency, m.cadence_lock, s.external_hr, "
        "json_extract(m.data, '$.workout.type') AS workout_type, "
        "json_extract(m.data, '$.workout.label') AS workout_label, "
        "json_extract(m.data, '$.intensity_seconds') AS intensity_seconds, "
        "json_extract(a.raw_json, '$.averageRunningCadenceInStepsPerMinute') AS cadence_spm, "
        "json_extract(a.raw_json, '$.avgStrideLength') AS stride_cm, "
        "json_extract(a.raw_json, '$.avgGroundContactTime') AS ground_contact_ms, "
        "json_extract(a.raw_json, '$.avgVerticalRatio') AS vertical_ratio_pct, "
        "s.activity_id IS NOT NULL AS has_streams "
        "FROM activities a LEFT JOIN activity_metrics m USING (activity_id) "
        "LEFT JOIN streams s USING (activity_id) ORDER BY a.start_time_local DESC"
    ).fetchall()
    out = []
    for r in rows:
        row = dict(r)
        row["intensity_seconds"] = json.loads(row["intensity_seconds"]) if row["intensity_seconds"] else None
        row["vo2max_eff"] = per_run.get(str(row["activity_id"]))
        out.append(row)
    return out


# What Garmin's own summary of a run adds: running dynamics, power, calories and the like
WATCH_FIELDS = {
    "calories": "calories", "avg_power_w": "avgPower", "norm_power_w": "normPower",
    "stride_cm": "avgStrideLength", "vertical_oscillation_cm": "avgVerticalOscillation",
    "vertical_ratio_pct": "avgVerticalRatio", "ground_contact_ms": "avgGroundContactTime",
    "max_speed_mps": "maxSpeed", "elevation_loss_m": "elevationLoss", "steps": "steps",
    "body_battery_change": "differenceBodyBattery", "sweat_loss_ml": "waterEstimated",
    "garmin_load": "activityTrainingLoad", "te_label": "trainingEffectLabel",
}


def watch_extras(raw_json: str | None) -> dict[str, Any]:
    try:
        raw = json.loads(raw_json or "{}")
    except ValueError:
        return {}
    out = {k: raw.get(v) for k, v in WATCH_FIELDS.items()}
    return {k: v for k, v in out.items() if v not in (None, "", 0) or k == "body_battery_change" and v is not None}


def activity_detail(conn: sqlite3.Connection, activity_id: int, with_streams: bool = True,
                    perf: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Everything the workout page shows, or None if there's no such activity."""
    row = conn.execute(
        "SELECT activity_id, name, activity_type, start_time_local, distance_m, duration_s, "
        "moving_duration_s, elevation_gain_m, avg_hr, max_hr, avg_speed_mps, calories, aerobic_te, "
        "anaerobic_te, vo2max, location FROM activities WHERE activity_id = ?",
        (activity_id,),
    ).fetchone()
    if row is None:
        return None
    settings = processing.effective_settings(conn)
    loaded = db.load_streams(conn, activity_id) if with_streams else None
    metrics_row = conn.execute("SELECT data FROM activity_metrics WHERE activity_id = ?", (activity_id,)).fetchone()
    laps = [dict(r) for r in conn.execute(
        "SELECT idx, start_t, elapsed_s, timer_s, distance_m, avg_hr, max_hr, avg_speed, avg_cadence, "
        "intensity, lap_trigger FROM laps WHERE activity_id = ? ORDER BY idx", (activity_id,)
    )]
    result = {
        "activity": dict(row),
        "laps": laps,
        "metrics": json.loads(metrics_row[0]) if metrics_row else None,
        "zones": [asdict(z) for z in analysis.zones_for(settings)],
        "settings": settings,
        "streams": None,
        "external_hr": None,
    }
    if loaded:
        result["streams"], result["external_hr"] = display_streams(*loaded)
    result["insights"] = insights.workout_insights(conn, activity_id)
    perf = perf or performance.summary(conn)
    result["effective_vo2max"] = perf["per_activity"].get(str(activity_id))
    result["vo2max_shape"] = perf["vo2max"]
    result["paces"] = perf.get("paces") or []
    result["pace_bounds_mps"] = perf.get("pace_bounds_mps")
    result["gear"] = gear.for_activity(conn, activity_id)
    raw = conn.execute("SELECT raw_json FROM activities WHERE activity_id = ?", (activity_id,)).fetchone()
    result["watch"] = watch_extras(raw[0] if raw else None)
    return result


def display_streams(streams: dict[str, list], external_hr: bool) -> tuple[dict[str, list], bool]:
    """Streams as the workout page draws them: cleaned wrist HR, plus grade and grade-adjusted speed."""
    hr = streams["hr"] if external_hr else analysis.clean_hr(streams["hr"])
    grade = analysis.grades(streams["distance"], streams["altitude"])
    return {
        **streams,
        "hr": hr,
        "grade": [round(g, 3) if g is not None else None for g in grade],
        "gap": [round(v, 3) if v is not None else None
                for v in analysis.grade_adjusted_speed(streams["speed"], grade)],
    }, external_hr


def vo2max(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    return [dict(r) for r in conn.execute("SELECT date, sport, value FROM vo2max ORDER BY date")]


def training_load(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    series = processing.training_load_series(conn)
    if series:
        series[-1]["state"] = insights.form_state(series[-1]["fitness"], series[-1]["form"])
    return series


def records(conn: sqlite3.Connection) -> dict[str, list[dict[str, Any]]]:
    """Your times at each standard distance, from every run, fastest first."""
    rows = conn.execute(
        "SELECT a.activity_id, a.name, a.start_time_local, m.data FROM activity_metrics m "
        "JOIN activities a USING (activity_id)"
    ).fetchall()
    by_distance: dict[str, list] = {label: [] for label in analysis.BEST_EFFORT_DISTANCES}
    for r in rows:
        for label, effort in json.loads(r["data"]).get("best_efforts", {}).items():
            by_distance.setdefault(label, []).append({
                "activity_id": r["activity_id"], "name": r["name"],
                "date": r["start_time_local"][:10], **effort,
            })
    # Every effort, fastest first, so the dashboard can also show the best within a date range.
    return {label: sorted(efforts, key=lambda e: e["seconds"]) for label, efforts in by_distance.items() if efforts}


def settings_with_zones(conn: sqlite3.Connection) -> dict[str, Any]:
    settings = processing.effective_settings(conn)
    settings["zones"] = [asdict(z) for z in analysis.zones_for(settings)]
    settings["zone_options"] = zone_options(conn, settings)
    return settings


def zone_options(conn: sqlite3.Connection, settings: dict[str, Any]) -> dict[str, Any]:
    """Both zone systems, so the phone app can switch between them without the Mac.

    Garmin's zones are unavailable (None) when Garmin didn't provide them, or when you've set
    your own max or threshold HR, which the Mac then uses instead (same rule as on the Mac).
    """
    floors = db.get_garmin_profile(conn).get("zone_floors")
    chosen = db.get_settings(conn)
    overridden = "max_hr" in chosen or "lthr" in chosen
    garmin = None
    if floors and not overridden:
        garmin = {"zones": [asdict(z) for z in analysis.zones_from_floors(floors)], "floors": floors,
                  "method": db.get_garmin_profile(conn).get("zone_method")}
    return {
        "threshold": {"zones": [asdict(z) for z in analysis.hr_zones(settings["max_hr"], settings["lthr"])],
                      "floors": None, "method": None},
        "garmin": garmin,
    }


def plan(conn: sqlite3.Connection) -> dict[str, Any]:
    saved = planner.load(conn)
    ctx = planner.context(conn)
    return {
        "plan": saved,
        "progress": planner.progress(conn, saved) if saved else None,
        "goals": {k: {"label": v["label"], "blurb": v["blurb"]} for k, v in planner.GOALS.items()},
        "defaults": {"runs_per_week": max(3, min(6, round(ctx["runs_per_week_4wk"]) or 3)), "long_day": "Sun",
                     "weeks": 6, "goal": "return" if ctx["comeback"] else "base"},
        "context": ctx,
    }
