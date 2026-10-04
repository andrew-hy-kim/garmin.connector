"""Export everything the dashboard shows into one file for the phone app.

After each sync the Mac writes ``garmin-dashboard.data`` (gzip-compressed JSON)
to iCloud Drive, in a "Garmin Dashboard" folder. The phone app imports that
file and keeps it on the phone, so it works offline and without the Mac.

The analysis all happens here on the Mac; the file just carries the results.
Second-by-second data is averaged into 5-second steps for the phone, which keeps
the file small (roughly 10-40 MB for several years of running) while the
workout charts look the same at phone size.
"""

from __future__ import annotations

import gzip
import json
import zlib
import logging
import os
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

from . import api, config, db, focus, gear, heatmap, insights, performance, processing, races, suggest

log = logging.getLogger(__name__)

FORMAT_VERSION = 1
FILENAME = "garmin-dashboard.data"
STEP_S = 5  # seconds per sample in the phone copy of each workout

# How to combine the 1-second samples within each 5-second step, and how much precision to keep.
_MEAN = {"hr": 0, "speed": 2, "cadence": 0, "power": 0, "gap": 2, "grade": 3}
_LAST = {"t": 0, "distance": 0, "altitude": 1}
_FIRST = {"lat": 5, "lon": 5}


def icloud_drive() -> Path:
    return Path.home() / "Library" / "Mobile Documents" / "com~apple~CloudDocs"


def default_dir() -> Path:
    """iCloud Drive/Garmin Dashboard on a Mac with iCloud Drive, else ~/.garmin-connector/export.

    Set GARMIN_CONNECTOR_EXPORT to choose another folder.
    """
    if os.environ.get("GARMIN_CONNECTOR_EXPORT"):
        return Path(os.environ["GARMIN_CONNECTOR_EXPORT"]).expanduser()
    if icloud_drive().is_dir():
        return icloud_drive() / "Garmin Dashboard"
    return config.home_dir() / "export"


def downsample(streams: dict[str, list], step: int = STEP_S) -> dict[str, list]:
    """Average 1-second streams into ``step``-second buckets (by elapsed time, so pauses stay pauses)."""
    t = streams["t"]
    bounds = [0]  # start index of each bucket
    for i in range(1, len(t)):
        if t[i] // step != t[i - 1] // step:
            bounds.append(i)
    bounds.append(len(t))
    spans = list(zip(bounds, bounds[1:]))

    out: dict[str, list] = {}
    for name, values in streams.items():
        col = []
        if name in _MEAN:
            digits = _MEAN[name]
            for a, b in spans:
                vals = [v for v in values[a:b] if v is not None]
                col.append(_round(sum(vals) / len(vals), digits) if vals else None)
        elif name in _FIRST:
            digits = _FIRST[name]
            for a, b in spans:
                col.append(_round(next((v for v in values[a:b] if v is not None), None), digits))
        else:  # t, distance, altitude and anything unexpected: last value in the bucket
            digits = _LAST.get(name, 3)
            for a, b in spans:
                col.append(_round(next((v for v in reversed(values[a:b]) if v is not None), None), digits))
        out[name] = col
    return out


# Changes with the export format and with the analysis (it cleans the heart rate shown on the phone)
CACHE_KEY = f"v{FORMAT_VERSION}-{STEP_S}s-a{processing.ANALYSIS_VERSION}"


def phone_streams(conn: sqlite3.Connection, activity_id: int) -> tuple[dict[str, list], bool]:
    """Downsampled display streams for one workout, cached because they never change."""
    row = conn.execute("SELECT key, data FROM export_streams WHERE activity_id = ?", (activity_id,)).fetchone()
    if row and row[0] == CACHE_KEY:
        cached = json.loads(zlib.decompress(row[1]))
        return cached["streams"], cached["external_hr"]
    streams, external_hr = api.display_streams(*db.load_streams(conn, activity_id))
    small = downsample(streams)
    blob = zlib.compress(json.dumps({"streams": small, "external_hr": external_hr}, separators=(",", ":")).encode())
    conn.execute("INSERT OR REPLACE INTO export_streams (activity_id, key, data) VALUES (?, ?, ?)",
                 (activity_id, CACHE_KEY, blob))
    conn.commit()
    return small, external_hr


def _round(v, digits: int):
    if v is None:
        return None
    return int(round(v)) if digits == 0 else round(v, digits)


def snapshot(conn: sqlite3.Connection) -> dict[str, Any]:
    """Everything the phone app needs, as one JSON-able dict."""
    perf = performance.summary(conn)
    activities = api.activities(conn, perf)
    details = {}
    with insights.cached_runs(conn):
        for a in activities:
            d = api.activity_detail(conn, a["activity_id"], with_streams=False, perf=perf)
            if d and a["has_streams"]:
                d["streams"], d["external_hr"] = phone_streams(conn, a["activity_id"])
                d["sample_step_s"] = STEP_S
            details[str(a["activity_id"])] = d
    reviews = {r[0]: {"created_at": r[1], "text": r[2]}
               for r in conn.execute("SELECT key, created_at, text FROM ai_reviews")}
    return {
        "format": "garmin-dashboard",
        "version": FORMAT_VERSION,
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "overview": {
            "activities": activities,
            "vo2max": api.vo2max(conn),
            "training_load": api.training_load(conn),
            "records": api.records(conn),
            "settings": api.settings_with_zones(conn),
            "insights": insights.overview_insights(conn),
            "suggestions": suggest.suggest(conn),
            "race_predictions": races.predictions(conn, perf=perf),
            "performance": {k: v for k, v in perf.items() if k != "per_activity"},
            "gear": gear.summary(conn),
            "focus": focus.areas(conn, perf),
            "plan": api.plan(conn),
            "ai_reviews": reviews,
        },
        "details": details,
        # stored on the phone apart from the overview, so pages that don't show it load as fast as before
        "heatmap": heatmap.tracks(conn),
    }


def write(conn: sqlite3.Connection, folder: Path | str | None = None) -> Path:
    """Write the export file (atomically, so iCloud never syncs a half-written file)."""
    folder = Path(folder).expanduser() if folder else default_dir()
    folder.mkdir(parents=True, exist_ok=True)
    data = json.dumps(snapshot(conn), separators=(",", ":"), default=str).encode()
    path = folder / FILENAME
    tmp = folder / (FILENAME + ".tmp")
    tmp.write_bytes(gzip.compress(data, compresslevel=6, mtime=0))
    tmp.replace(path)
    log.info("Exported for the phone app: %s (%.1f MB)", path, path.stat().st_size / 1e6)
    return path


def write_quietly(conn: sqlite3.Connection) -> Path | None:
    """Export after a sync; a failure here never fails the sync itself."""
    try:
        return write(conn)
    except Exception as err:  # e.g. iCloud Drive folder not writable
        log.warning("Couldn't write the phone export: %s", err)
        return None
