"""Shoes (and other gear) from your Garmin account, with the distance on each pair.

Fetched at each sync, best effort. Garmin keeps a distance per pair and which runs
used it; the dashboard shows how far each pair has gone against its limit (the one
set in Garmin, or 800 km), so you know when to replace them.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import date, timedelta
from typing import Any

log = logging.getLogger(__name__)

DEFAULT_LIMIT_M = 804_672  # a common rule of thumb for running shoes: 500 miles (800 km)
SCHEMA = """
CREATE TABLE IF NOT EXISTS gear (
    uuid        TEXT PRIMARY KEY,
    name        TEXT,
    type        TEXT,
    status      TEXT,
    date_begin  TEXT,
    date_end    TEXT,
    max_m       REAL,
    total_m     REAL,
    activities  INTEGER,
    raw_json    TEXT
);
CREATE TABLE IF NOT EXISTS gear_activity (
    uuid         TEXT NOT NULL,
    activity_id  INTEGER NOT NULL,
    PRIMARY KEY (uuid, activity_id)
);
"""


def _profile_number(client: Any) -> Any:
    for get in (lambda: client.get_device_last_used()["userProfileNumber"],
                lambda: client.get_user_profile()["id"],
                lambda: client.get_user_profile()["userProfileId"]):
        try:
            value = get()
            if value:
                return value
        except Exception:  # noqa: BLE001 - try the next way
            continue
    return None


def gear_row(g: dict[str, Any], stats: dict[str, Any] | None) -> dict[str, Any]:
    name = g.get("displayName") or g.get("customMakeModel") or \
        " ".join(x for x in (g.get("gearMakeName"), g.get("gearModelName")) if x and x != "Other") or "Unnamed"
    return {
        "uuid": g["uuid"], "name": name, "type": g.get("gearTypeName"), "status": g.get("gearStatusName"),
        "date_begin": (g.get("dateBegin") or "")[:10] or None, "date_end": (g.get("dateEnd") or "")[:10] or None,
        "max_m": g.get("maximumMeters") or None,
        "total_m": (stats or {}).get("totalDistance"), "activities": (stats or {}).get("totalActivities"),
        "raw_json": json.dumps(g),
    }


def fetch(client: Any, conn: sqlite3.Connection) -> int:
    number = _profile_number(client)
    if not number:
        return 0
    try:
        items = client.get_gear(number) or []
    except Exception as err:  # noqa: BLE001
        log.warning("Couldn't fetch your gear from Garmin: %s", err)
        return 0
    count = 0
    for g in items:
        if not isinstance(g, dict) or not g.get("uuid"):
            continue
        try:
            stats = client.get_gear_stats(g["uuid"])
        except Exception:  # noqa: BLE001
            stats = None
        row = gear_row(g, stats)
        conn.execute("INSERT OR REPLACE INTO gear (uuid, name, type, status, date_begin, date_end, max_m, total_m, "
                     "activities, raw_json) VALUES (:uuid, :name, :type, :status, :date_begin, :date_end, :max_m, "
                     ":total_m, :activities, :raw_json)", row)
        try:
            ids = [a["activityId"] for a in client.get_gear_activities(g["uuid"]) or [] if a.get("activityId")]
            conn.executemany("INSERT OR IGNORE INTO gear_activity (uuid, activity_id) VALUES (?, ?)",
                             [(g["uuid"], i) for i in ids])
        except Exception as err:  # noqa: BLE001
            log.debug("No activities for gear %s: %s", g["uuid"], err)
        count += 1
    conn.commit()
    if count:
        log.info("Gear: %d items", count)
    return count


def summary(conn: sqlite3.Connection, today: date | None = None) -> list[dict[str, Any]]:
    """Every pair with its distance, limit, use in the last 30 days and last run; in use first."""
    today = today or date.today()
    month_ago = (today - timedelta(days=30)).isoformat()
    out = []
    for g in conn.execute("SELECT * FROM gear"):
        g = dict(g)
        used = conn.execute(
            "SELECT count(*), max(a.start_time_local), "
            "sum(CASE WHEN a.start_time_local >= ? THEN a.distance_m ELSE 0 END), sum(a.distance_m) "
            "FROM gear_activity ga JOIN activities a USING (activity_id) WHERE ga.uuid = ?", (month_ago, g["uuid"])).fetchone()
        total = g["total_m"] or used[3] or 0
        limit = g["max_m"] or (DEFAULT_LIMIT_M if (g["type"] or "").lower() == "shoes" else None)
        out.append({
            "uuid": g["uuid"], "name": g["name"], "type": g["type"], "retired": (g["status"] or "").lower() == "retired",
            "since": g["date_begin"], "total_m": total, "limit_m": limit, "limit_set": bool(g["max_m"]),
            "activities": g["activities"] or used[0], "last_used": (used[1] or "")[:10] or None,
            "month_m": used[2] or 0, "share": total / limit if limit else None,
        })
    out.sort(key=lambda g: g["last_used"] or "", reverse=True)  # most recently used first,
    out.sort(key=lambda g: g["retired"])                        # retired pairs last
    return out


def for_activity(conn: sqlite3.Connection, activity_id: int) -> list[dict[str, Any]]:
    return [dict(r) for r in conn.execute(
        "SELECT g.uuid, g.name, g.type, g.total_m FROM gear_activity ga JOIN gear g USING (uuid) WHERE ga.activity_id = ?",
        (activity_id,))]
