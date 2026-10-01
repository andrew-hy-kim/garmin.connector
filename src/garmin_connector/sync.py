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

from . import config, db, processing

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
    download_fit: bool = True,
    fit_dir: Path | None = None,
) -> dict[str, int]:
    """Fetch activities (and VO2 max on the days you trained) since ``since``.

    With no ``since``, continues from the newest activity already stored, or
    pulls the whole history on the very first run. Each activity's .fit file is
    downloaded and analyzed so the second-by-second data is available.
    """
    if since is None:
        latest = db.latest_activity_date(conn)
        since = date.fromisoformat(latest) - timedelta(days=OVERLAP_DAYS) if latest else EARLIEST
    today = date.today()

    log.info("Fetching activity list from %s to %s", since, today)
    activities = client.get_activities_by_date(since.isoformat(), today.isoformat())
    n_activities = db.upsert_activities(conn, activities)
    log.info("Found %d activities", n_activities)

    # Recent days are re-checked in case a new run updated VO2 max.
    recheck_from = (today - timedelta(days=OVERLAP_DAYS)).isoformat()
    conn.execute("DELETE FROM vo2max_checked WHERE date >= ?", (recheck_from,))
    days = vo2max_days_to_check(conn)
    if days:
        log.info("Fetching VO2 max for %d workout days", len(days))
    n_vo2 = 0
    for n, day in enumerate(days, 1):
        try:
            n_vo2 += db.upsert_vo2max(conn, db.vo2max_rows(client.get_max_metrics(day)))
            conn.execute("INSERT OR IGNORE INTO vo2max_checked (date) VALUES (?)", (day,))
            conn.commit()
        except Exception as err:  # one bad day shouldn't stop the whole sync
            log.warning("Couldn't fetch VO2 max for %s: %s", day, err)
        if n % 25 == 0:
            log.info("VO2 max: checked %d of %d days", n, len(days))
        time.sleep(REQUEST_PAUSE_S)

    n_fit = 0
    if download_fit:
        n_fit = download_missing_fit(client, conn, fit_dir or config.fit_dir())
    import_missing_streams(conn)
    n_analyzed = processing.refresh(conn)

    return {"activities": n_activities, "vo2max_readings": n_vo2, "fit_files": n_fit, "analyzed": n_analyzed}


def vo2max_days_to_check(conn: sqlite3.Connection) -> list[str]:
    """Run and ride days not yet checked for VO2 max (only those activities update it)."""
    return [r[0] for r in conn.execute(
        "SELECT DISTINCT substr(start_time_local, 1, 10) AS day FROM activities "
        "WHERE (activity_type LIKE '%run%' OR activity_type LIKE '%cycl%' OR activity_type LIKE '%bik%' "
        "OR activity_type LIKE '%ride%') AND start_time_local IS NOT NULL "
        "AND day NOT IN (SELECT date FROM vo2max_checked) "
        "AND day NOT IN (SELECT date FROM vo2max WHERE date < date('now', '-2 days')) ORDER BY day"
    )]


def import_missing_streams(conn: sqlite3.Connection) -> int:
    """Parse every downloaded .fit file that hasn't been read into the database yet."""
    rows = conn.execute(
        "SELECT a.activity_id, a.fit_path FROM activities a LEFT JOIN streams s USING (activity_id) "
        "WHERE a.fit_path IS NOT NULL AND s.activity_id IS NULL"
    ).fetchall()
    count = 0
    for activity_id, path in rows:
        try:
            processing.import_fit(conn, activity_id, path)
            count += 1
        except Exception as err:
            log.warning("Couldn't read %s: %s", path, err)
    return count


def download_missing_fit(client: Garmin, conn: sqlite3.Connection, fit_dir: Path) -> int:
    """Download the original .fit file for every activity that doesn't have one yet."""
    # Manually entered activities have no .fit file to download.
    missing = [r[0] for r in conn.execute(
        "SELECT activity_id FROM activities WHERE fit_path IS NULL "
        "AND coalesce(json_extract(raw_json, '$.manualActivity'), 0) = 0"
    )]
    count = 0
    if missing:
        log.info("Downloading %d workout files", len(missing))
    for n, activity_id in enumerate(missing, 1):
        if n % 25 == 0:
            log.info("Downloaded %d of %d workout files", n, len(missing))
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
