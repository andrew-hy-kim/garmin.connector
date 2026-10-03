"""Recovery data from your watch: resting heart rate, HRV, sleep and Garmin's training readiness.

Fetched day by day at each sync (the last 90 days on the first sync, then just the
new days), best effort: a watch that doesn't record HRV or sleep simply leaves those
empty, and a failure never stops the sync.

Your "normal" is worked out from your own history: resting heart rate against its
30-day median, HRV against the balanced range Garmin sets for you (or your 30-day
median when Garmin has none). Several days off your normal is a signal worth
heeding: illness, poor sleep, stress or accumulated fatigue all show up there first.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from datetime import date, timedelta
from statistics import median
from typing import Any

log = logging.getLogger(__name__)

FIRST_DAYS = 90
REQUEST_PAUSE_S = 0.4
SCHEMA = """
CREATE TABLE IF NOT EXISTS daily_health (
    date             TEXT PRIMARY KEY,
    resting_hr       REAL,
    hrv              REAL,      -- last night's average (ms)
    hrv_weekly       REAL,
    hrv_low          REAL,      -- Garmin's balanced range for you
    hrv_high         REAL,
    hrv_status       TEXT,      -- BALANCED / UNBALANCED / LOW / POOR
    sleep_s          REAL,
    sleep_score      REAL,
    deep_s           REAL,
    rem_s            REAL,
    readiness        REAL,      -- Garmin training readiness, 0-100
    readiness_level  TEXT
);
"""
FIELDS = ["resting_hr", "hrv", "hrv_weekly", "hrv_low", "hrv_high", "hrv_status", "sleep_s", "sleep_score",
          "deep_s", "rem_s", "readiness", "readiness_level"]


def ensure(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


# ---------------------------------------------------------------- reading Garmin's responses

def _num(v: Any) -> float | None:
    try:
        return float(v) if v is not None and float(v) > 0 else None
    except (TypeError, ValueError):
        return None


def parse_rhr(r: Any) -> dict[str, Any]:
    try:
        values = r["allMetrics"]["metricsMap"]["WELLNESS_RESTING_HEART_RATE"]
        return {"resting_hr": _num(values[0]["value"])} if values else {}
    except (KeyError, TypeError, IndexError):
        return {"resting_hr": _num((r or {}).get("restingHeartRate"))} if isinstance(r, dict) else {}


def parse_hrv(r: Any) -> dict[str, Any]:
    s = (r or {}).get("hrvSummary") if isinstance(r, dict) else None
    if not s:
        return {}
    base = s.get("baseline") or {}
    return {"hrv": _num(s.get("lastNightAvg")), "hrv_weekly": _num(s.get("weeklyAvg")),
            "hrv_low": _num(base.get("balancedLow")), "hrv_high": _num(base.get("balancedUpper")),
            "hrv_status": s.get("status")}


def parse_sleep(r: Any) -> dict[str, Any]:
    s = (r or {}).get("dailySleepDTO") if isinstance(r, dict) else None
    if not s:
        return {}
    score = ((s.get("sleepScores") or {}).get("overall") or {}).get("value")
    return {"sleep_s": _num(s.get("sleepTimeSeconds")), "sleep_score": _num(score),
            "deep_s": _num(s.get("deepSleepSeconds")), "rem_s": _num(s.get("remSleepSeconds"))}


def parse_readiness(r: Any) -> dict[str, Any]:
    entries = r if isinstance(r, list) else [r] if isinstance(r, dict) else []
    entries = [e for e in entries if isinstance(e, dict) and e.get("score") is not None]
    if not entries:
        return {}
    e = entries[0]  # the morning's value comes first
    return {"readiness": _num(e.get("score")), "readiness_level": e.get("level")}


# ---------------------------------------------------------------- sync

def fetch(client: Any, conn: sqlite3.Connection, today: date | None = None) -> int:
    """Fetch the days not stored yet (and re-check the last two, which fill in during the day)."""
    ensure(conn)
    today = today or date.today()
    latest = conn.execute("SELECT max(date) FROM daily_health").fetchone()[0]
    start = max(date.fromisoformat(latest) - timedelta(days=1), today - timedelta(days=FIRST_DAYS)) if latest \
        else today - timedelta(days=FIRST_DAYS - 1)
    calls = [("get_rhr_day", parse_rhr), ("get_hrv_data", parse_hrv), ("get_sleep_data", parse_sleep),
             ("get_training_readiness", parse_readiness)]
    stored, dead_days, unsupported = 0, 0, set()
    d = start
    while d <= today:
        day = d.isoformat()
        row: dict[str, Any] = {}
        failures = 0
        for method, parse in calls:
            if method in unsupported:
                continue
            try:
                row.update({k: v for k, v in parse(getattr(client, method)(day)).items() if v is not None})
            except AttributeError:
                unsupported.add(method)  # an older library version without this call
            except Exception as err:  # noqa: BLE001 - one bad request shouldn't stop the rest
                failures += 1
                log.debug("Couldn't fetch %s for %s: %s", method, day, err)
        if len(unsupported) == len(calls):
            break
        if row:
            conn.execute(f"INSERT OR REPLACE INTO daily_health (date, {', '.join(FIELDS)}) VALUES (?, {', '.join('?' * len(FIELDS))})",
                         [day] + [row.get(f) for f in FIELDS])
            stored += 1
        dead_days = dead_days + 1 if failures and not row else 0
        if dead_days >= 3:
            log.warning("Couldn't fetch recovery data from Garmin (resting HR, HRV, sleep); skipping it this sync")
            break
        d += timedelta(days=1)
        if d <= today and REQUEST_PAUSE_S:
            time.sleep(REQUEST_PAUSE_S)
    conn.commit()
    if stored:
        log.info("Recovery data: %d days", stored)
    return stored


# ---------------------------------------------------------------- what it says

def _median(values: list[float]) -> float | None:
    values = [v for v in values if v]
    return median(values) if len(values) >= 5 else None


def summary(conn: sqlite3.Connection, today: date | None = None) -> dict[str, Any] | None:
    """Latest values against your normal, flags, and a year of daily history for the charts."""
    ensure(conn)
    today = today or date.today()
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM daily_health WHERE date > ? ORDER BY date", ((today - timedelta(days=365)).isoformat(),))]
    if not rows:
        return None
    by_day = {r["date"]: r for r in rows}
    month = [r for r in rows if r["date"] > (today - timedelta(days=30)).isoformat()]

    def latest(field: str, within: int = 3) -> tuple[float | None, str | None]:
        for k in range(within):
            r = by_day.get((today - timedelta(days=k)).isoformat())
            if r and r.get(field):
                return r[field], r["date"]
        return None, None

    rhr, rhr_day = latest("resting_hr")
    rhr_normal = _median([r["resting_hr"] for r in month if r["date"] != rhr_day])
    hrv, hrv_day = latest("hrv")
    hrv_row = by_day.get(hrv_day) or {}
    hrv_low, hrv_high = hrv_row.get("hrv_low"), hrv_row.get("hrv_high")
    if not (hrv_low and hrv_high):
        m = _median([r["hrv"] for r in month])
        hrv_low, hrv_high = (m * 0.9, m * 1.1) if m else (None, None)
    sleep, sleep_day = latest("sleep_s")
    week = [r for r in rows if r["date"] > (today - timedelta(days=7)).isoformat()]
    sleep_week = [r["sleep_s"] for r in week if r.get("sleep_s")]
    readiness, _ = latest("readiness", 2)

    # streaks off your normal, from the latest day back
    def streak(test) -> int:
        n = 0
        for r in reversed(rows):
            if not test(r):
                break
            n += 1
        return n

    rhr_high_days = streak(lambda r: bool(r.get("resting_hr") and rhr_normal and r["resting_hr"] >= rhr_normal + 5)) if rhr_normal else 0
    hrv_low_days = streak(lambda r: bool(r.get("hrv") and (r.get("hrv_low") or hrv_low) and r["hrv"] < (r.get("hrv_low") or hrv_low))) if hrv_low else 0

    flags = []
    if rhr_high_days >= 2:
        flags.append(f"Resting heart rate has been {round(rhr - rhr_normal)} bpm above your normal for {rhr_high_days} days")
    if hrv_low_days >= 2:
        flags.append(f"HRV has been below your normal range for {hrv_low_days} nights")
    if len(sleep_week) >= 3 and sum(sleep_week) / len(sleep_week) < 6 * 3600:
        flags.append(f"You've averaged {sum(sleep_week) / len(sleep_week) / 3600:.1f} hours of sleep this week")

    return {
        "date": max(r["date"] for r in rows),
        "resting_hr": rhr, "resting_hr_normal": rhr_normal,
        "hrv": hrv, "hrv_low": hrv_low, "hrv_high": hrv_high, "hrv_status": hrv_row.get("hrv_status"),
        "sleep_s": sleep, "sleep_score": (by_day.get(sleep_day) or {}).get("sleep_score"),
        "sleep_week_avg_s": sum(sleep_week) / len(sleep_week) if sleep_week else None,
        "readiness": readiness, "readiness_level": (by_day.get(today.isoformat()) or {}).get("readiness_level"),
        "rhr_high_days": rhr_high_days, "hrv_low_days": hrv_low_days,
        "flags": flags,
        "history": [{k: r[k] for k in ("date", "resting_hr", "hrv", "hrv_low", "hrv_high", "sleep_s", "sleep_score")} for r in rows],
    }
