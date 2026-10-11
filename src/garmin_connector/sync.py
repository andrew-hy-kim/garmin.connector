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

from . import apple, config, db, gear, processing, weather

log = logging.getLogger(__name__)

# The first sync goes back this far, which is effectively "everything".
EARLIEST = date(2000, 1, 1)
# Re-check a couple of days we already have, to pick up renamed or edited activities.
OVERLAP_DAYS = 2
# Small pause between per-day requests so a big first sync doesn't hammer Garmin.
REQUEST_PAUSE_S = 0.5

MAX_FAILURES_IN_A_ROW = 5  # requests in a row (workout files, VO2 max days) before leaving the rest for the next sync


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
    fetch_hr_profile(client, conn)

    if since is None:
        # the newest Garmin activity (Apple Health imports don't count: an import made before the
        # first sync would otherwise make it skip your Garmin history)
        latest = conn.execute("SELECT max(substr(start_time_local, 1, 10)) FROM activities WHERE activity_id < ?",
                              (apple.APPLE_ID_BASE,)).fetchone()[0]
        since = date.fromisoformat(latest) - timedelta(days=OVERLAP_DAYS) if latest else EARLIEST
    today = date.today()

    log.info("Fetching activity list from %s to %s", since, today)
    activities = client.get_activities_by_date(since.isoformat(), today.isoformat())
    n_activities = db.upsert_activities(conn, activities)
    log.info("Found %d activities", n_activities)
    drop_apple_copies(conn)
    # Activities deleted in Garmin Connect since the last sync: gone here too. Only within the
    # re-checked days, and only when Garmin did list that stretch (an empty reply could be a hiccup).
    if activities and since != EARLIEST:
        listed = {a.get("activityId") for a in activities}
        gone = [r[0] for r in conn.execute(
            "SELECT activity_id FROM activities WHERE substr(start_time_local, 1, 10) >= ? AND activity_id < ?",
            (since.isoformat(), apple.APPLE_ID_BASE))  # workouts imported from Apple Health aren't Garmin's to delete
            if r[0] not in listed]
        if gone:
            db.delete_activities(conn, gone)
            log.info("Removed %d activit%s deleted in Garmin Connect", len(gone), "y" if len(gone) == 1 else "ies")

    # Recent days are re-checked in case a new run updated VO2 max.
    recheck_from = (today - timedelta(days=OVERLAP_DAYS)).isoformat()
    conn.execute("DELETE FROM vo2max_checked WHERE date >= ?", (recheck_from,))
    days = vo2max_days_to_check(conn)
    if days:
        log.info("Fetching VO2 max for %d workout days", len(days))
    n_vo2 = failed_in_a_row = 0
    for n, day in enumerate(days, 1):
        try:
            n_vo2 += db.upsert_vo2max(conn, db.vo2max_rows(client.get_max_metrics(day)))
            conn.execute("INSERT OR IGNORE INTO vo2max_checked (date) VALUES (?)", (day,))
            conn.commit()
            failed_in_a_row = 0
        except Exception as err:  # one bad day shouldn't stop the whole sync
            log.warning("Couldn't fetch VO2 max for %s: %s", day, err)
            failed_in_a_row += 1
            if failed_in_a_row >= MAX_FAILURES_IN_A_ROW:
                log.warning("Stopped fetching VO2 max after %d failures in a row; the other %d days "
                            "will be checked at the next sync.", failed_in_a_row, len(days) - n)
                break
        if n % 25 == 0:
            log.info("VO2 max: checked %d of %d days", n, len(days))
        time.sleep(REQUEST_PAUSE_S)

    fetch_race_predictions(client, conn, today)
    try:
        gear.fetch(client, conn)
    except Exception as err:  # never let gear stop a sync
        log.warning("Couldn't fetch gear: %s", err)

    n_fit = 0
    if download_fit:
        n_fit = download_missing_fit(client, conn, fit_dir or config.fit_dir())
    import_missing_streams(conn)
    n_analyzed = processing.refresh(conn)
    # conditions for new workouts (and, the first time, the whole history); never stops the sync
    w = weather.update_quietly(conn) or {}

    return {"activities": n_activities, "vo2max_readings": n_vo2, "fit_files": n_fit, "analyzed": n_analyzed,
            "weather": w.get("weather", 0)}


def drop_apple_copies(conn: sqlite3.Connection) -> int:
    """Remove Apple Health workouts that a Garmin activity also recorded (worn together, or an
    import made before the first sync): the Garmin one, with its .fit file, wins."""
    def spans(where: str) -> list[tuple[float, float, int]]:
        return [(s, s + (d or 0), aid) for aid, s, d in conn.execute(
            "SELECT activity_id, CAST(strftime('%s', start_time_gmt) AS REAL), duration_s FROM activities "
            f"WHERE start_time_gmt IS NOT NULL AND {where}", (apple.APPLE_ID_BASE,))]
    apples = spans("activity_id >= ?")
    if not apples:
        return 0
    garmin = sorted(spans("activity_id < ?"))
    gone = [aid for s, e, aid in apples
            if any(apple.same_run((s, e), (gs, ge)) for gs, ge, _ in garmin if gs < e and s < ge)]
    if gone:
        db.delete_activities(conn, gone)
        log.info("Removed %d Apple Health workout%s also recorded by Garmin", len(gone), "" if len(gone) == 1 else "s")
    return len(gone)


def fetch_hr_profile(client: Garmin, conn: sqlite3.Connection) -> dict:
    """Save the heart-rate settings from your Garmin account: max, resting and
    threshold HR, your zone boundaries, and sex (used by the training-load formula).

    Best effort: anything Garmin doesn't return is left to the app's estimates,
    and a failure here never stops the sync.
    """
    # Start from what was saved last time, so a request that fails today (Garmin hiccup,
    # expired session) keeps the old values instead of silently switching your zones.
    previous = db.get_garmin_profile(conn)
    profile = dict(previous)
    try:
        zones = client.connectapi("/biometric-service/heartRateZones") or []
        entry = next((z for z in zones if z.get("sport") == "RUNNING"), None) \
            or next((z for z in zones if z.get("sport") == "DEFAULT"), None) or (zones[0] if zones else {})
        profile["max_hr"] = entry.get("maxHeartRateUsed")
        profile["resting_hr"] = entry.get("restingHeartRateUsed")
        profile["lthr"] = entry.get("lactateThresholdHeartRateUsed")
        floors = [entry.get(f"zone{i}Floor") for i in range(1, 6)]
        if all(floors) and floors == sorted(floors):
            profile["zone_floors"] = floors
            profile["zone_method"] = entry.get("trainingMethod")
        else:
            profile.pop("zone_floors", None)
            profile.pop("zone_method", None)
    except Exception as err:
        log.warning("Couldn't fetch heart-rate zones from Garmin: %s", err)
    try:
        user = (client.get_user_profile() or {}).get("userData", {})
        profile["gender"] = user.get("gender")
        profile["lthr"] = profile.get("lthr") or user.get("lactateThresholdHeartRate")
    except Exception as err:
        log.warning("Couldn't fetch your Garmin profile: %s", err)
    if not profile.get("lthr"):
        try:
            profile["lthr"] = client.get_lactate_threshold()["speed_and_heart_rate"].get("heartRate")
        except Exception as err:
            log.debug("No lactate threshold from Garmin: %s", err)

    profile = {k: v for k, v in profile.items() if v}
    if profile != previous:
        db.set_garmin_profile(conn, profile)
        log.info("Heart-rate settings from Garmin: %s", ", ".join(
            f"{label} {profile[key]}" for key, label in
            (("max_hr", "max"), ("resting_hr", "resting"), ("lthr", "threshold")) if key in profile))
    return profile


def fetch_race_predictions(client: Garmin, conn: sqlite3.Connection, today: date | None = None) -> int:
    """Save Garmin's race predictions: the last year on the first sync, then just the new days.

    Best effort, like the heart-rate profile: a failure never stops the sync.
    """
    today = today or date.today()
    latest = conn.execute("SELECT max(date) FROM race_predictions").fetchone()[0]
    start = max(date.fromisoformat(latest) - timedelta(days=OVERLAP_DAYS), today - timedelta(days=365)) \
        if latest else today - timedelta(days=365)
    try:
        response = client.get_race_predictions(start.isoformat(), today.isoformat(), "daily")
        return db.upsert_race_predictions(conn, db.race_prediction_rows(response))
    except Exception as err:
        log.warning("Couldn't fetch race predictions from Garmin: %s", err)
        return 0


def vo2max_days_to_check(conn: sqlite3.Connection) -> list[str]:
    """Run days not yet checked for VO2 max (runs are what update your running VO2 max)."""
    return [r[0] for r in conn.execute(
        "SELECT DISTINCT substr(start_time_local, 1, 10) AS day FROM activities "
        f"WHERE activity_type LIKE '%run%' AND start_time_local IS NOT NULL AND activity_id < {apple.APPLE_ID_BASE} "
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
        "AND coalesce(json_extract(raw_json, '$.manualActivity'), 0) = 0 "
        f"AND activity_id < {apple.APPLE_ID_BASE}"  # Apple Health workouts have no Garmin file
    )]
    count = failed_in_a_row = 0
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
            failed_in_a_row = 0
        except Exception as err:
            log.warning("Couldn't download FIT for activity %s: %s", activity_id, err)
            failed_in_a_row += 1
            # Garmin limiting requests, or the connection gone: asking for hundreds more won't help
            if failed_in_a_row >= MAX_FAILURES_IN_A_ROW:
                log.warning("Stopped downloading after %d failures in a row; the other %d workout files "
                            "will be downloaded at the next sync.", failed_in_a_row, len(missing) - n)
                break
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
