"""Incremental sync from Garmin Connect into the local database."""

from __future__ import annotations

import io
import logging
import sqlite3
import time
import zipfile
from datetime import date, timedelta
from pathlib import Path

from garminconnect import Garmin

from . import config, db

log = logging.getLogger(__name__)

# The first sync goes back this far, which is effectively "everything".
EARLIEST = date(2000, 1, 1)
# Re-check a couple of days we already have, to pick up renamed or edited activities.
OVERLAP_DAYS = 2
# Small pause between per-day requests so a big first sync doesn't hammer Garmin.
REQUEST_PAUSE_S = 0.5


def sync(
    client: Garmin,
    conn: sqlite3.Connection,
    since: date | None = None,
    download_fit: bool = False,
    fit_dir: Path | None = None,
) -> dict[str, int]:
    """Fetch activities (and VO2 max on the days you trained) since ``since``.

    With no ``since``, continues from the newest activity already stored, or
    pulls the whole history on the very first run.
    """
    if since is None:
        latest = db.latest_activity_date(conn)
        since = date.fromisoformat(latest) - timedelta(days=OVERLAP_DAYS) if latest else EARLIEST
    today = date.today()

    log.info("Fetching activities from %s to %s", since, today)
    activities = client.get_activities_by_date(since.isoformat(), today.isoformat())
    n_activities = db.upsert_activities(conn, activities)

    # You only wear the watch for workouts, so VO2 max only changes on activity days.
    activity_days = sorted({a["startTimeLocal"][:10] for a in activities if a.get("startTimeLocal")})
    n_vo2 = 0
    for day in activity_days:
        try:
            n_vo2 += db.upsert_vo2max(conn, db.vo2max_rows(client.get_max_metrics(day)))
        except Exception as err:  # one bad day shouldn't stop the whole sync
            log.warning("Couldn't fetch VO2 max for %s: %s", day, err)
        time.sleep(REQUEST_PAUSE_S)

    n_fit = 0
    if download_fit:
        n_fit = download_missing_fit(client, conn, fit_dir or config.fit_dir())

    return {"activities": n_activities, "vo2max_readings": n_vo2, "fit_files": n_fit}


def download_missing_fit(client: Garmin, conn: sqlite3.Connection, fit_dir: Path) -> int:
    """Download the original .fit file for every activity that doesn't have one yet."""
    missing = [r[0] for r in conn.execute("SELECT activity_id FROM activities WHERE fit_path IS NULL")]
    count = 0
    for activity_id in missing:
        try:
            data = client.download_activity(activity_id, dl_fmt=Garmin.ActivityDownloadFormat.ORIGINAL)
            path = _save_fit(data, activity_id, fit_dir)
            db.set_fit_path(conn, activity_id, str(path))
            count += 1
        except Exception as err:
            log.warning("Couldn't download FIT for activity %s: %s", activity_id, err)
        time.sleep(REQUEST_PAUSE_S)
    return count


def _save_fit(data: bytes, activity_id: int, fit_dir: Path) -> Path:
    """Garmin sends the original file zipped; unzip it to ``<activity_id>.fit``."""
    path = fit_dir / f"{activity_id}.fit"
    if zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            name = next((n for n in zf.namelist() if n.lower().endswith(".fit")), zf.namelist()[0])
            path.write_bytes(zf.read(name))
    else:
        path.write_bytes(data)
    return path
