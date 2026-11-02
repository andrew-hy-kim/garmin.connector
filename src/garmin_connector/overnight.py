"""Your nights: sleep, resting heart rate and HRV, from nights you wore the watch to bed.

Garmin's daily resting heart rate is the lowest 30 minutes of the day. On a day the watch
was only on for a workout, that's the warm-up (often 90-130 bpm), so it's useless. Here a
night only counts when the watch recorded a real night's sleep (MIN_SLEEP_S or more): only
then are its resting HR and HRV kept. Sleep itself is kept for any night Garmin recorded.

Fetched at each sync from Garmin's sleep summaries, 28 nights per request (one request
carries sleep, resting HR and HRV), plus Garmin's HRV "normal range" a year at a time. The
first sync goes back through your whole history: at least to your first Garmin workout, then
on until a full year without a single night. Later syncs re-check the last few nights
(Garmin fills a night in during the morning) and add the new ones. Best effort: a failure
never stops the sync.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from datetime import date, datetime, timedelta, timezone
from statistics import median
from typing import Any

from . import apple, db

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS nights (
    date          TEXT PRIMARY KEY,  -- the morning you woke up (Garmin's calendar date)
    sleep_s       REAL,
    deep_s        REAL,
    light_s       REAL,
    rem_s         REAL,
    awake_s       REAL,
    sleep_score   REAL,
    sleep_quality TEXT,              -- Garmin's word for the score: EXCELLENT, GOOD, FAIR, POOR
    bedtime       TEXT,              -- local time, HH:MM
    wake_time     TEXT,
    resting_hr    REAL,              -- only on a full night (see MIN_SLEEP_S)
    hrv           REAL,              -- overnight average (ms), only on a full night
    hrv_7d        REAL,
    hrv_status    TEXT,              -- BALANCED / UNBALANCED / LOW / POOR
    hrv_low       REAL,              -- Garmin's balanced range for you that night
    hrv_high      REAL,
    respiration   REAL
);
"""

MIN_SLEEP_S = 4 * 3600   # a night shorter than this doesn't count for resting HR and HRV
CHUNK_DAYS = 28          # Garmin's sleep summaries: at most 28 nights a request
HRV_CHUNK_DAYS = 365     # Garmin's HRV range: at most a year a request
RECHECK_DAYS = 3         # the last nights are fetched again: Garmin fills them in during the morning
EMPTY_YEAR = 13          # this many empty 28-night requests in a row (about a year): the history starts here
MAX_FAILURES = 3         # requests in a row before leaving the rest for the next sync
REQUEST_PAUSE_S = 0.5

RHR_NIGHTS = 30          # your resting HR for zones and load: the median of your latest 30 full nights...
RHR_WITHIN_DAYS = 365    # ...within the last year
RHR_MIN_NIGHTS = 5
RHR_STEP = 2             # and it only moves when that median moves 2+ bpm, so load isn't recalculated nightly

FIELDS = ["sleep_s", "deep_s", "light_s", "rem_s", "awake_s", "sleep_score", "sleep_quality", "bedtime", "wake_time",
          "resting_hr", "hrv", "hrv_7d", "hrv_status", "respiration"]


def ensure(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


# ---------------------------------------------------------------- reading Garmin's responses

def _num(v: Any) -> float | None:
    try:
        return float(v) if v is not None and float(v) > 0 else None
    except (TypeError, ValueError):
        return None


def _clock(millis: Any) -> str | None:
    """Garmin's 'local' timestamps are local wall-clock time written as if it were UTC."""
    try:
        return datetime.fromtimestamp(float(millis) / 1000, timezone.utc).strftime("%H:%M") if millis else None
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def parse_night(entry: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """One night from Garmin's sleep summaries, or None if it isn't one."""
    day, v = entry.get("calendarDate"), entry.get("values") or {}
    sleep = _num(v.get("totalSleepTimeInSeconds"))
    if not day or not sleep:
        return None
    full = sleep >= MIN_SLEEP_S
    return day, {
        "sleep_s": sleep, "deep_s": _num(v.get("deepTime")), "light_s": _num(v.get("lightTime")),
        "rem_s": _num(v.get("remTime")), "awake_s": v.get("awakeTime"),
        "sleep_score": _num(v.get("sleepScore")), "sleep_quality": v.get("sleepScoreQuality"),
        "bedtime": _clock(v.get("localSleepStartTimeInMillis")), "wake_time": _clock(v.get("localSleepEndTimeInMillis")),
        "resting_hr": _num(v.get("restingHeartRate")) if full else None,
        "hrv": _num(v.get("avgOvernightHrv")) if full else None,
        "hrv_7d": _num(v.get("hrv7dAverage")),
        "hrv_status": v.get("hrvStatus") if full else None,
        "respiration": _num(v.get("respiration")),
    }


def parse_hrv_ranges(response: Any) -> dict[str, tuple[float, float]]:
    """{date: (low, high)}: Garmin's balanced HRV range for you, night by night."""
    out = {}
    summaries = (response.get("hrvSummaries") or []) if isinstance(response, dict) else []
    for s in summaries:
        base = s.get("baseline") or {}
        low, high = _num(base.get("balancedLow")), _num(base.get("balancedUpper"))
        if s.get("calendarDate") and low and high:
            out[s["calendarDate"]] = (low, high)
    return out


# ---------------------------------------------------------------- sync

def _save(conn: sqlite3.Connection, response: Any) -> int:
    nights = [n for n in (parse_night(e) for e in response or [] if isinstance(e, dict)) if n]
    for day, row in nights:
        conn.execute(
            f"INSERT INTO nights (date, {', '.join(FIELDS)}) VALUES (?, {', '.join('?' * len(FIELDS))}) "
            f"ON CONFLICT (date) DO UPDATE SET {', '.join(f'{f} = excluded.{f}' for f in FIELDS)}",
            [day] + [row[f] for f in FIELDS])
    return len(nights)


def _first_workout(conn: sqlite3.Connection) -> date | None:
    row = conn.execute("SELECT min(substr(start_time_local, 1, 10)) FROM activities WHERE activity_id < ?",
                       (apple.APPLE_ID_BASE,)).fetchone()
    return date.fromisoformat(row[0]) if row and row[0] else None


def fetch(client: Any, conn: sqlite3.Connection, today: date | None = None) -> int:
    """Fetch the nights not stored yet. Returns how many nights came in."""
    ensure(conn)
    today = today or date.today()
    if not hasattr(client, "get_sleep_daily"):
        log.warning("This version of garminconnect can't fetch sleep; `pip install -U garminconnect` adds it")
        return 0
    through = db.get_text_setting(conn, "nights_through")
    first_time = through is None
    start = date.fromisoformat(through) - timedelta(days=RECHECK_DAYS) if through else today
    stored, failures = 0, 0

    def request(a: date, b: date) -> int | None:
        nonlocal failures
        try:
            n = _save(conn, client.get_sleep_daily(a.isoformat(), b.isoformat()))
            conn.commit()
            failures = 0
            return n
        except Exception as err:  # noqa: BLE001 - one bad request shouldn't stop the sync
            failures += 1
            log.debug("Couldn't fetch sleep %s to %s: %s", a, b, err)
            return None
        finally:
            if REQUEST_PAUSE_S:
                time.sleep(REQUEST_PAUSE_S)

    if first_time:
        # Back from today, 28 nights at a time: at least to your first workout, then on until a
        # year with no nights at all (or Garmin stops answering).
        log.info("Fetching your sleep, resting HR and HRV history (the first time takes a minute or two)")
        floor = _first_workout(conn) or today
        end, empty = today, 0
        while failures < MAX_FAILURES and not (empty >= EMPTY_YEAR and end < floor):
            a = end - timedelta(days=CHUNK_DAYS - 1)
            n = request(a, end)
            if n is not None:
                stored += n
                # the empty year only counts from your first workout back
                empty = empty + 1 if n == 0 and end < floor else 0
            end = a - timedelta(days=1)
        if failures >= MAX_FAILURES:  # not all of it: the next sync starts the history again
            log.warning("Couldn't fetch all your sleep history from Garmin; trying again at the next sync")
            return stored
        hrv_from = end
    else:
        a = start
        while a <= today and failures < MAX_FAILURES:
            b = min(a + timedelta(days=CHUNK_DAYS - 1), today)
            stored += request(a, b) or 0
            a = b + timedelta(days=1)
        if failures >= MAX_FAILURES:
            log.warning("Couldn't fetch sleep data from Garmin; trying again at the next sync")
            return stored
        hrv_from = start
    db.set_text_setting(conn, "nights_through", today.isoformat())

    # Garmin's normal HRV range for you, for the nights that have HRV
    first_hrv = conn.execute("SELECT min(date) FROM nights WHERE hrv IS NOT NULL AND date >= ?",
                             (hrv_from.isoformat(),)).fetchone()[0]
    if first_hrv and hasattr(client, "get_hrv_data_range"):
        a = date.fromisoformat(first_hrv)
        while a <= today:
            b = min(a + timedelta(days=HRV_CHUNK_DAYS - 1), today)
            try:
                for day, (low, high) in parse_hrv_ranges(client.get_hrv_data_range(a.isoformat(), b.isoformat())).items():
                    conn.execute("UPDATE nights SET hrv_low = ?, hrv_high = ? WHERE date = ?", (low, high, day))
                conn.commit()
            except Exception as err:  # noqa: BLE001
                log.debug("Couldn't fetch HRV range %s to %s: %s", a, b, err)
            a = b + timedelta(days=1)
            if REQUEST_PAUSE_S:
                time.sleep(REQUEST_PAUSE_S)
    if first_time:
        log.info("Nights: %d with sleep from Garmin", stored)
    return stored


def fetch_quietly(client: Any, conn: sqlite3.Connection, today: date | None = None) -> int:
    try:
        return fetch(client, conn, today)
    except Exception as err:  # never let sleep data stop a sync
        log.warning("Couldn't fetch sleep data: %s", err)
        return 0


# ---------------------------------------------------------------- your resting heart rate

def resting_hr_from_nights(conn: sqlite3.Connection, today: date | None = None) -> float | None:
    """The median resting HR of your latest full nights, or None without enough of them."""
    ensure(conn)
    today = today or date.today()
    values = [r[0] for r in conn.execute(
        "SELECT resting_hr FROM nights WHERE resting_hr IS NOT NULL AND date > ? AND date <= ? ORDER BY date DESC LIMIT ?",
        ((today - timedelta(days=RHR_WITHIN_DAYS)).isoformat(), today.isoformat(), RHR_NIGHTS))]
    return median(values) if len(values) >= RHR_MIN_NIGHTS else None


def update_resting_hr(conn: sqlite3.Connection, today: date | None = None) -> float | None:
    """Save the resting HR your nights say, when it has moved RHR_STEP bpm or more from the saved one.
    A saved value stays when there are no recent nights: it's still better than Garmin's daily
    number on days the watch was only on for a workout."""
    saved = db.get_text_setting(conn, "overnight_resting_hr")
    saved = float(saved) if saved else None
    now = resting_hr_from_nights(conn, today)
    if now is not None and (saved is None or abs(now - saved) >= RHR_STEP):
        db.set_text_setting(conn, "overnight_resting_hr", str(round(now)))
        log.info("Resting HR from your nights: %d bpm", round(now))
        return float(round(now))
    return saved


# ---------------------------------------------------------------- what it says

def _median(values: list[float], at_least: int = 5) -> float | None:
    values = [v for v in values if v]
    return median(values) if len(values) >= at_least else None


def summary(conn: sqlite3.Connection, today: date | None = None) -> dict[str, Any] | None:
    """Every night, plus last night against your normal and anything worth flagging."""
    ensure(conn)
    today = today or date.today()
    rows = [dict(r) for r in conn.execute("SELECT * FROM nights ORDER BY date")]
    if not rows:
        return None
    iso = today.isoformat()
    last = rows[-1]
    recent = (today - date.fromisoformat(last["date"])).days <= 2  # last night, or the one before
    before = [r for r in rows[:-1] if r["date"] > (date.fromisoformat(last["date"]) - timedelta(days=60)).isoformat()][-30:]
    rhr_normal = _median([r["resting_hr"] for r in before])
    hrv_normal = _median([r["hrv"] for r in before])
    hrv_low, hrv_high = last.get("hrv_low"), last.get("hrv_high")
    if not (hrv_low and hrv_high) and hrv_normal:
        hrv_low, hrv_high = hrv_normal * 0.9, hrv_normal * 1.1
    worn_14 = sum(1 for r in rows if r["date"] > (today - timedelta(days=14)).isoformat() and r["date"] <= iso)
    week = [r["sleep_s"] for r in rows if r["date"] > (today - timedelta(days=7)).isoformat() and r["sleep_s"]]

    # Nights in a row off your normal, from last night back (a night without the watch breaks the run)
    def streak(test) -> int:
        n, day = 0, date.fromisoformat(last["date"])
        by_day = {r["date"]: r for r in rows}
        while (r := by_day.get(day.isoformat())) and test(r):
            n += 1
            day -= timedelta(days=1)
        return n

    rhr_high = streak(lambda r: bool(r["resting_hr"] and rhr_normal and r["resting_hr"] >= rhr_normal + 5)) if rhr_normal else 0
    hrv_low_n = streak(lambda r: bool(r["hrv"] and (r["hrv_low"] or hrv_low) and r["hrv"] < (r["hrv_low"] or hrv_low))) if hrv_low else 0
    flags = []
    if recent:
        if rhr_high >= 2:
            flags.append({"key": "rhr", "nights": rhr_high, "text":
                          f"Resting heart rate {round(last['resting_hr'] - rhr_normal)} bpm above your normal for {rhr_high} nights"})
        if hrv_low_n >= 2:
            flags.append({"key": "hrv", "nights": hrv_low_n, "text": f"HRV below your normal range for {hrv_low_n} nights"})
        if len(week) >= 4 and sum(week) / len(week) < 6 * 3600:
            flags.append({"key": "sleep", "text": f"You've averaged {sum(week) / len(week) / 3600:.1f} hours of sleep this week"})

    return {
        "last": last, "recent": recent, "worn_14": worn_14,
        "resting_hr_normal": rhr_normal, "hrv_normal": hrv_normal, "hrv_low": hrv_low, "hrv_high": hrv_high,
        "sleep_week_avg_s": sum(week) / len(week) if week else None,
        "flags": flags,
        "min_sleep_s": MIN_SLEEP_S,
        "nights": [{k: r[k] for k in ("date", "sleep_s", "deep_s", "light_s", "rem_s", "awake_s", "sleep_score",
                                      "resting_hr", "hrv", "hrv_low", "hrv_high", "hrv_status", "bedtime", "wake_time")}
                   for r in rows],
    }


def night_before(conn: sqlite3.Connection, start_time_local: str | None) -> dict[str, Any] | None:
    """The night before a workout (the one you woke up from that day), against your normal then."""
    if not start_time_local:
        return None
    ensure(conn)
    day = start_time_local[:10]
    r = conn.execute("SELECT * FROM nights WHERE date = ?", (day,)).fetchone()
    if not r:
        return None
    r = dict(r)
    # an evening workout is still the same night; a workout before you woke wasn't after it
    if r["wake_time"] and start_time_local[11:16] and start_time_local[11:16] < r["wake_time"]:
        return None
    prior = [dict(x) for x in conn.execute(
        "SELECT resting_hr, hrv FROM nights WHERE date < ? AND date > ? ORDER BY date DESC LIMIT 30",
        (day, (date.fromisoformat(day) - timedelta(days=60)).isoformat()))]
    r["resting_hr_normal"] = _median([p["resting_hr"] for p in prior])
    hrv_normal = _median([p["hrv"] for p in prior])
    if not (r["hrv_low"] and r["hrv_high"]) and hrv_normal:
        r["hrv_low"], r["hrv_high"] = hrv_normal * 0.9, hrv_normal * 1.1
    return r
