"""Turn downloaded .fit files into stored streams and metrics."""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import asdict
from datetime import date, timedelta
from pathlib import Path
from statistics import quantiles
from typing import Any

from . import analysis, db, fit

log = logging.getLogger(__name__)

DEFAULT_MAX_HR = 190.0
DEFAULT_RESTING_HR = 60.0
STREAM_KEYS = ("t", "hr", "speed", "distance", "cadence", "altitude", "power", "lat", "lon")


def import_fit(conn: sqlite3.Connection, activity_id: int, path: Path | str) -> None:
    """Parse a .fit file and store its streams and laps."""
    parsed = fit.parse(path)
    streams = {key: [getattr(s, key) for s in parsed.samples] for key in STREAM_KEYS}
    db.save_streams(conn, activity_id, streams, parsed.external_hr)
    db.save_laps(conn, activity_id, [asdict(lap) for lap in parsed.laps])
    conn.commit()


def _estimate_max_hr(conn: sqlite3.Connection) -> float:
    """Highest 30-second average heart rate seen in any activity (so a one-second
    wrist spike can't inflate it), ignoring activities where the wrist sensor
    locked onto cadence."""
    row = conn.execute("SELECT max(max_hr_30s) FROM activity_metrics WHERE coalesce(cadence_lock, 0) < 0.2").fetchone()
    if row[0]:
        return round(row[0])
    maxes = [r[0] for r in conn.execute("SELECT max_hr FROM activities WHERE max_hr IS NOT NULL")]
    return round(quantiles(maxes, n=20)[-1]) if len(maxes) >= 2 else DEFAULT_MAX_HR


def effective_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    """The heart-rate settings to use, and where each one came from.

    For each value: what you set in the dashboard wins, then what's in your
    Garmin account, then an estimate from your data. Garmin's own zone
    boundaries are used unless you've overridden max or threshold HR.
    """
    chosen = db.get_settings(conn)
    garmin = db.get_garmin_profile(conn)
    settings: dict[str, Any] = {"sources": {}}

    for key in ("max_hr", "resting_hr", "lthr"):
        if key in chosen:
            settings[key], source = chosen[key], "you"
        elif garmin.get(key):
            settings[key], source = float(garmin[key]), "garmin"
        elif key == "max_hr":
            settings[key], source = _estimate_max_hr(conn), "estimated"
        elif key == "resting_hr":
            settings[key], source = DEFAULT_RESTING_HR, "default"
        else:
            settings[key], source = None, "not set"
        settings["sources"][key] = source
    settings["estimated"] = [k for k, s in settings["sources"].items() if s in ("estimated", "default")]

    overridden = "max_hr" in chosen or "lthr" in chosen
    settings["zone_floors"] = garmin.get("zone_floors") if not overridden else None
    settings["zone_method"] = garmin.get("zone_method") if settings["zone_floors"] else None
    settings["male"] = garmin.get("gender") != "FEMALE"
    return settings


def _signature(settings: dict[str, Any]) -> str:
    return json.dumps([settings["max_hr"], settings["resting_hr"], settings["lthr"],
                       settings["zone_floors"], settings["male"]])


def analyze_activity(conn: sqlite3.Connection, activity_id: int, settings: dict[str, Any]) -> None:
    loaded = db.load_streams(conn, activity_id)
    if loaded is None:
        return
    streams, external_hr = loaded
    activity_type = conn.execute(
        "SELECT activity_type FROM activities WHERE activity_id = ?", (activity_id,)
    ).fetchone()[0]
    intensities = {r[0] for r in conn.execute("SELECT intensity FROM laps WHERE activity_id = ?", (activity_id,))}
    intervals = "active" in intensities and bool(intensities & {"rest", "recovery"})
    db.save_metrics(conn, activity_id, analysis.analyze(activity_type, streams, settings, external_hr, intervals))


def refresh(conn: sqlite3.Connection, force: bool = False) -> int:
    """Analyze new activities, and re-analyze everything if the settings changed."""
    pending = [r[0] for r in conn.execute(
        "SELECT s.activity_id FROM streams s LEFT JOIN activity_metrics m USING (activity_id) "
        "WHERE m.activity_id IS NULL"
    )]
    settings = effective_settings(conn)
    for activity_id in pending:
        analyze_activity(conn, activity_id, settings)
    conn.commit()

    # New activities can change the estimated max HR, which moves the zones.
    settings = effective_settings(conn)
    previous = conn.execute("SELECT value FROM settings WHERE key = '_analyzed_with'").fetchone()
    count = len(pending)
    if pending:
        log.info("Analyzed %d new workouts", len(pending))
    if force or previous is None or previous[0] != _signature(settings):
        ids = [r[0] for r in conn.execute("SELECT activity_id FROM streams")]
        for activity_id in ids:
            analyze_activity(conn, activity_id, settings)
        count = len(ids)
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('_analyzed_with', ?)", (_signature(settings),)
        )
    conn.commit()
    return count


def training_load_series(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Daily fitness / fatigue / form from every activity (supplemental ones count too)."""
    settings = effective_settings(conn)
    daily: dict[str, float] = {}
    rows = conn.execute(
        "SELECT substr(a.start_time_local, 1, 10), m.trimp, a.duration_s, a.avg_hr "
        "FROM activities a LEFT JOIN activity_metrics m USING (activity_id)"
    ).fetchall()
    for day, trimp, duration, avg_hr in rows:
        if trimp is None and duration and avg_hr:
            trimp = analysis.trimp_from_summary(duration, avg_hr, settings["resting_hr"], settings["max_hr"],
                                                settings["male"])
        if trimp:
            daily[day] = daily.get(day, 0.0) + trimp
    if not daily:
        return []
    first, last = date.fromisoformat(min(daily)), date.today()
    days = [(first + timedelta(days=i)).isoformat() for i in range((last - first).days + 1)]
    return analysis.training_load(daily, days)
