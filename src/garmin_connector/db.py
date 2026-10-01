"""Local SQLite storage.

Each activity keeps a handful of tidy columns for querying, plus the full JSON
Garmin returned (``raw_json``) so nothing is lost if we want another field later.
"""

from __future__ import annotations

import json
import sqlite3
import zlib
from pathlib import Path
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS activities (
    activity_id        INTEGER PRIMARY KEY,
    name               TEXT,
    activity_type      TEXT,
    start_time_local   TEXT,
    start_time_gmt     TEXT,
    distance_m         REAL,
    duration_s         REAL,
    moving_duration_s  REAL,
    elevation_gain_m   REAL,
    avg_hr             REAL,
    max_hr             REAL,
    avg_speed_mps      REAL,
    calories           REAL,
    avg_power_w        REAL,
    aerobic_te         REAL,
    anaerobic_te       REAL,
    vo2max             REAL,
    location           TEXT,
    fit_path           TEXT,
    raw_json           TEXT NOT NULL,
    synced_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activities_start ON activities (start_time_local);

CREATE TABLE IF NOT EXISTS vo2max (
    date      TEXT NOT NULL,
    sport     TEXT NOT NULL,          -- 'running' or 'cycling'
    value     REAL NOT NULL,
    raw_json  TEXT,
    PRIMARY KEY (date, sport)
);

-- Second-by-second data from the .fit file, stored compressed (one row per
-- activity) because it's always read a whole activity at a time.
CREATE TABLE IF NOT EXISTS streams (
    activity_id  INTEGER PRIMARY KEY REFERENCES activities (activity_id),
    external_hr  INTEGER NOT NULL,     -- 1 if a chest strap / arm band was connected
    data         BLOB NOT NULL         -- zlib-compressed JSON {t: [...], hr: [...], ...}
);

CREATE TABLE IF NOT EXISTS laps (
    activity_id  INTEGER NOT NULL REFERENCES activities (activity_id),
    idx          INTEGER NOT NULL,
    start_t      INTEGER,
    elapsed_s    REAL,
    timer_s      REAL,
    distance_m   REAL,
    avg_hr       REAL,
    max_hr       REAL,
    avg_speed    REAL,
    avg_cadence  REAL,
    intensity    TEXT,
    lap_trigger  TEXT,
    PRIMARY KEY (activity_id, idx)
);

-- Results of analysis.analyze(); recomputed when settings change.
CREATE TABLE IF NOT EXISTS activity_metrics (
    activity_id     INTEGER PRIMARY KEY REFERENCES activities (activity_id),
    trimp           REAL,
    decoupling_pct  REAL,
    efficiency      REAL,
    cadence_lock    REAL,
    max_hr_30s      REAL,
    data            TEXT NOT NULL      -- full metrics as JSON
);

-- Days we've already asked Garmin for VO2 max, so an interrupted sync resumes.
CREATE TABLE IF NOT EXISTS vo2max_checked (
    date  TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT
);
"""

# (column, key in Garmin's activity JSON)
_ACTIVITY_FIELDS = [
    ("name", "activityName"),
    ("start_time_local", "startTimeLocal"),
    ("start_time_gmt", "startTimeGMT"),
    ("distance_m", "distance"),
    ("duration_s", "duration"),
    ("moving_duration_s", "movingDuration"),
    ("elevation_gain_m", "elevationGain"),
    ("avg_hr", "averageHR"),
    ("max_hr", "maxHR"),
    ("avg_speed_mps", "averageSpeed"),
    ("calories", "calories"),
    ("avg_power_w", "avgPower"),
    ("aerobic_te", "aerobicTrainingEffect"),
    ("anaerobic_te", "anaerobicTrainingEffect"),
    ("vo2max", "vO2MaxValue"),
    ("location", "locationName"),
]


def connect(path: Path | str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def activity_row(activity: dict[str, Any]) -> dict[str, Any]:
    """Flatten one activity from Garmin's API into our table's columns."""
    row = {col: activity.get(key) for col, key in _ACTIVITY_FIELDS}
    row["activity_id"] = activity["activityId"]
    row["activity_type"] = (activity.get("activityType") or {}).get("typeKey")
    row["raw_json"] = json.dumps(activity)
    return row


def upsert_activities(conn: sqlite3.Connection, activities: Iterable[dict[str, Any]]) -> int:
    rows = [activity_row(a) for a in activities]
    if not rows:
        return 0
    cols = list(rows[0].keys())
    updates = ", ".join(f"{c} = excluded.{c}" for c in cols if c != "activity_id")
    conn.executemany(
        f"INSERT INTO activities ({', '.join(cols)}) VALUES ({', '.join(':' + c for c in cols)}) "
        f"ON CONFLICT (activity_id) DO UPDATE SET {updates}, synced_at = datetime('now')",
        rows,
    )
    conn.commit()
    return len(rows)


def vo2max_rows(max_metrics: Any) -> list[dict[str, Any]]:
    """Pull VO2 max readings out of a ``get_max_metrics`` response.

    Garmin returns a list of entries with a ``generic`` (running) and a
    ``cycling`` section, either of which may be missing.
    """
    rows = []
    for entry in max_metrics or []:
        for section, sport in (("generic", "running"), ("cycling", "cycling")):
            data = entry.get(section)
            if not data:
                continue
            value = data.get("vo2MaxPreciseValue") or data.get("vo2MaxValue")
            if value is None or not data.get("calendarDate"):
                continue
            rows.append(
                {"date": data["calendarDate"], "sport": sport, "value": value, "raw_json": json.dumps(data)}
            )
    return rows


def upsert_vo2max(conn: sqlite3.Connection, rows: list[dict[str, Any]]) -> int:
    conn.executemany(
        "INSERT INTO vo2max (date, sport, value, raw_json) VALUES (:date, :sport, :value, :raw_json) "
        "ON CONFLICT (date, sport) DO UPDATE SET value = excluded.value, raw_json = excluded.raw_json",
        rows,
    )
    conn.commit()
    return len(rows)


def latest_activity_date(conn: sqlite3.Connection) -> str | None:
    row = conn.execute("SELECT max(substr(start_time_local, 1, 10)) FROM activities").fetchone()
    return row[0]


def set_fit_path(conn: sqlite3.Connection, activity_id: int, path: str) -> None:
    conn.execute("UPDATE activities SET fit_path = ? WHERE activity_id = ?", (path, activity_id))
    conn.commit()


# ---------------------------------------------------------------- streams

_ROUNDING = {"speed": 3, "distance": 1, "altitude": 1, "cadence": 1, "lat": 6, "lon": 6}


def save_streams(conn: sqlite3.Connection, activity_id: int, streams: dict[str, list], external_hr: bool) -> None:
    compact = {
        key: [round(v, _ROUNDING[key]) if v is not None and key in _ROUNDING else v for v in values]
        for key, values in streams.items()
    }
    blob = zlib.compress(json.dumps(compact, separators=(",", ":")).encode())
    conn.execute(
        "INSERT OR REPLACE INTO streams (activity_id, external_hr, data) VALUES (?, ?, ?)",
        (activity_id, int(external_hr), blob),
    )


def load_streams(conn: sqlite3.Connection, activity_id: int) -> tuple[dict[str, list], bool] | None:
    row = conn.execute("SELECT data, external_hr FROM streams WHERE activity_id = ?", (activity_id,)).fetchone()
    if row is None:
        return None
    return json.loads(zlib.decompress(row[0])), bool(row[1])


def save_laps(conn: sqlite3.Connection, activity_id: int, laps: list[dict[str, Any]]) -> None:
    conn.execute("DELETE FROM laps WHERE activity_id = ?", (activity_id,))
    conn.executemany(
        "INSERT INTO laps (activity_id, idx, start_t, elapsed_s, timer_s, distance_m, avg_hr, max_hr, "
        "avg_speed, avg_cadence, intensity, lap_trigger) VALUES (:activity_id, :index, :start_t, :elapsed_s, "
        ":timer_s, :distance_m, :avg_hr, :max_hr, :avg_speed, :avg_cadence, :intensity, :trigger)",
        [{"activity_id": activity_id, **lap} for lap in laps],
    )


def save_metrics(conn: sqlite3.Connection, activity_id: int, metrics: dict[str, Any]) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO activity_metrics (activity_id, trimp, decoupling_pct, efficiency, "
        "cadence_lock, max_hr_30s, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (activity_id, metrics.get("trimp"), metrics.get("decoupling_pct"), metrics.get("efficiency"),
         metrics.get("cadence_lock"), metrics.get("max_hr_30s"), json.dumps(metrics)),
    )


# ---------------------------------------------------------------- settings

def get_settings(conn: sqlite3.Connection) -> dict[str, float]:
    """Settings the user chose; missing keys mean 'estimate it'."""
    rows = conn.execute("SELECT key, value FROM settings WHERE key NOT LIKE '\\_%' ESCAPE '\\'")
    return {k: float(v) for k, v in rows if v not in (None, "")}


def set_setting(conn: sqlite3.Connection, key: str, value: float | None) -> None:
    if value is None:
        conn.execute("DELETE FROM settings WHERE key = ?", (key,))
    else:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))
    conn.commit()
