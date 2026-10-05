"""Weather for each workout: the conditions at the time and place you ran, from Open-Meteo.

Open-Meteo is free for personal use and needs no account or key. All it is sent is each
workout's start point rounded to about a kilometre, and the dates. Hourly history goes back
to 1940 (ERA5 and the ECMWF model, ~10–25 km grid); air quality goes back to August 2022
(CAMS), so older workouts get weather without it. The last few days come from the forecast
service's recent past and are fetched again once the final history is in.

History is filled in once, grouped by area (about 10 km) and by stretches of up to three
months, so years of running take a few dozen requests. After that each sync only looks up
new workouts. A failure (no connection, the service busy) never stops a sync; whatever is
missing is tried again next time.

Each workout stores (metric; the dashboard converts):
  temp_c, feels_c, dew_c, humidity, wind_kmh, gust_kmh, wind_dir, precip_mm, code (WMO),
  temp_start_c / temp_end_c (runs over 90 minutes), aqi (US AQI), pm25, heat_pct (expected
  slowdown from heat and humidity), or {"indoor": true} for treadmill and other indoor
  workouts, or {"unavailable": true} when the service has no data for that hour.
"""

from __future__ import annotations

import json
import logging
import math
import sqlite3
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

import requests

log = logging.getLogger(__name__)

ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
RECENT = "https://api.open-meteo.com/v1/forecast"
AIR = "https://air-quality-api.open-meteo.com/v1/air-quality"
# nine variables: up to ten count as one call on the free plan
HOURLY = ["temperature_2m", "apparent_temperature", "dew_point_2m", "relative_humidity_2m", "precipitation",
          "weather_code", "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m"]
AIR_HOURLY = ["us_aqi", "pm2_5"]
AIR_FROM = date(2022, 8, 1)     # CAMS global history starts here
RECENT_DAYS = 60                # newer than this: the forecast service, which keeps ~3 months of past
FINAL_AFTER_DAYS = 7            # recent data is model output; fetch once more after this, for the final history
CHUNK_DAYS = 92                 # one request covers at most this many days for one place
TIMEOUT_S = 30
PAUSE_S = 0.25                  # be gentle with a free service
INDOOR = ("indoor", "treadmill", "virtual", "pool", "strength", "yoga", "elliptical", "stair")


class Busy(RuntimeError):
    """The service asked us to slow down; stop for now and carry on at the next sync."""


# ---------------------------------------------------------------- heat

# Expected slowdown (%) at the same effort from heat and humidity, by temperature + dew point
# in °F: the rule of thumb many coaches use (100 or less: no effect; 180+: hard running is
# not advisable). Interpolated between the published steps.
_HEAT = [(100, 0.0), (110, 0.5), (120, 1.0), (130, 2.0), (140, 3.0), (150, 4.5), (160, 6.0), (170, 8.0),
         (180, 10.0), (190, 12.0)]


def heat_pct(temp_c: float | None, dew_c: float | None) -> float | None:
    if temp_c is None or dew_c is None:
        return None
    s = (temp_c * 9 / 5 + 32) + (dew_c * 9 / 5 + 32)
    if s <= _HEAT[0][0]:
        return 0.0
    for (x0, y0), (x1, y1) in zip(_HEAT, _HEAT[1:]):
        if s <= x1:
            return round((y0 + (y1 - y0) * (s - x0) / (x1 - x0)) * 2) / 2
    return _HEAT[-1][1]


def aqi_label(aqi: float | None) -> str | None:
    if aqi is None:
        return None
    for top, label in ((50, "good"), (100, "moderate"), (150, "unhealthy for sensitive groups"),
                       (200, "unhealthy"), (300, "very unhealthy")):
        if aqi <= top:
            return label
    return "hazardous"


# WMO weather codes as Open-Meteo documents them
def sky(code: int | None) -> str | None:
    if code is None:
        return None
    for top, label in ((0, "clear"), (1, "mostly clear"), (2, "partly cloudy"), (3, "overcast"), (48, "fog"),
                       (55, "drizzle"), (57, "freezing drizzle"), (65, "rain"), (67, "freezing rain"),
                       (77, "snow"), (82, "rain showers"), (86, "snow showers"), (99, "thunderstorm")):
        if code <= top:
            return label
    return None


# ---------------------------------------------------------------- which workouts

def _indoor(activity_type: str | None) -> bool:
    t = (activity_type or "").lower()
    return any(k in t for k in INDOOR)


def _start_point(conn: sqlite3.Connection, activity_id: int, raw_json: str | None) -> tuple[float, float] | None:
    """Where the workout started: Garmin's summary, else the first GPS point of the track."""
    try:
        raw = json.loads(raw_json or "{}")
    except ValueError:
        raw = {}
    lat, lon = raw.get("startLatitude"), raw.get("startLongitude")
    if lat is not None and lon is not None and (lat, lon) != (0, 0):
        return float(lat), float(lon)
    from . import heatmap  # the simplified track is cached, so this is cheap after the first time
    track = heatmap.track(conn, activity_id)
    return (track[0][0], track[0][1]) if track else None


def _wanted(conn: sqlite3.Connection, today: date, redo: bool = False) -> list[dict[str, Any]]:
    """Workouts with no weather yet, or whose weather came from the recent past and is now final."""
    rows = conn.execute(
        "SELECT a.activity_id, a.activity_type, a.start_time_local, a.duration_s, a.raw_json, w.fetched_at "
        "FROM activities a LEFT JOIN weather w USING (activity_id) WHERE a.start_time_local IS NOT NULL"
    ).fetchall()
    out = []
    for activity_id, kind, start, duration, raw_json, fetched_at in rows:
        day = date.fromisoformat(start[:10])
        if fetched_at and not redo:
            got = date.fromisoformat(fetched_at[:10])
            # fetched while still recent, and old enough now for the final history: once more
            if not ((got - day).days < FINAL_AFTER_DAYS <= (today - day).days):
                continue
        out.append({"id": activity_id, "type": kind, "start": start, "day": day,
                    "duration": duration or 0, "raw": raw_json})
    return out


# ---------------------------------------------------------------- fetching

def _get(session: requests.Session, url: str, params: dict[str, Any]) -> dict[str, Any]:
    res = session.get(url, params=params, timeout=TIMEOUT_S)
    if res.status_code == 429:
        raise Busy("Open-Meteo asked to slow down")
    body = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}
    if not res.ok or body.get("error"):
        raise RuntimeError(f"{res.status_code} {body.get('reason') or res.text[:200]}")
    return body


def _chunks(days: list[date]) -> list[tuple[date, date]]:
    """Runs of dates, each spanning at most CHUNK_DAYS; long gaps without workouts aren't requested."""
    out: list[tuple[date, date]] = []
    for d in sorted(set(days)):
        if out and (d - out[-1][0]).days < CHUNK_DAYS and (d - out[-1][1]).days <= 31:
            out[-1] = (out[-1][0], d)
        else:
            out.append((d, d))
    return out


def _hourly(body: dict[str, Any], names: list[str]) -> dict[str, dict[str, float | None]]:
    """{"2026-08-04T07:00": {"temperature_2m": 18.2, ...}, ...} (times are local, timezone=auto)."""
    h = body.get("hourly") or {}
    times = h.get("time") or []
    return {t: {n: (h.get(n) or [None] * len(times))[i] for n in names} for i, t in enumerate(times)}


def fetch_area(session: requests.Session, lat: float, lon: float, days: list[date], today: date) -> dict[str, dict]:
    """Hourly weather (and air quality, where it exists) for one area on the given days."""
    hours: dict[str, dict] = {}
    recent_from = today - timedelta(days=RECENT_DAYS)
    for start, end in _chunks(days):
        for lo, hi, url in ((start, min(end, recent_from - timedelta(days=1)), ARCHIVE),
                            (max(start, recent_from), end, RECENT)):
            if lo > hi:
                continue
            body = _get(session, url, {"latitude": lat, "longitude": lon, "start_date": lo.isoformat(),
                                       "end_date": hi.isoformat(), "hourly": ",".join(HOURLY), "timezone": "auto"})
            for t, v in _hourly(body, HOURLY).items():
                hours.setdefault(t, {}).update(v)
            time.sleep(PAUSE_S)
        lo = max(start, AIR_FROM)
        if lo <= end:
            try:
                body = _get(session, AIR, {"latitude": lat, "longitude": lon, "start_date": lo.isoformat(),
                                           "end_date": end.isoformat(), "hourly": ",".join(AIR_HOURLY),
                                           "timezone": "auto"})
                for t, v in _hourly(body, AIR_HOURLY).items():
                    hours.setdefault(t, {}).update(v)
            except Busy:
                raise
            except Exception as err:  # weather without air quality is still worth keeping
                log.debug("No air quality for %.2f,%.2f %s–%s: %s", lat, lon, lo, end, err)
            time.sleep(PAUSE_S)
    return hours


# ---------------------------------------------------------------- one workout's conditions

def _at(hours: dict[str, dict], when: datetime, name: str) -> float | None:
    """A value at any minute, read between the two hours around it."""
    h0 = when.replace(minute=0, second=0, microsecond=0)
    a = (hours.get(h0.strftime("%Y-%m-%dT%H:00")) or {}).get(name)
    b = (hours.get((h0 + timedelta(hours=1)).strftime("%Y-%m-%dT%H:00")) or {}).get(name)
    if a is None or b is None:
        return a if b is None else b
    f = (when - h0).total_seconds() / 3600
    return a + (b - a) * f


def conditions(hours: dict[str, dict], start: datetime, duration_s: float) -> dict[str, Any] | None:
    """Conditions over a workout: averaged across it (sampled every 10 minutes), worst sky and air."""
    end = start + timedelta(seconds=max(duration_s, 60))
    steps = max(1, int((end - start).total_seconds() // 600))
    times = [start + (end - start) * i / steps for i in range(steps + 1)]

    def mean(name: str) -> float | None:
        vals = [v for v in (_at(hours, t, name) for t in times) if v is not None]
        return sum(vals) / len(vals) if vals else None

    temp = mean("temperature_2m")
    if temp is None:
        return None
    # the hours the workout touched (hourly precipitation is the total for the hour before)
    touched = [hours.get(h.strftime("%Y-%m-%dT%H:00")) or {} for h in
               (start.replace(minute=0, second=0) + timedelta(hours=i)
                for i in range(int((end - start).total_seconds() // 3600) + 2))]
    codes = [h["weather_code"] for h in touched[:-1] if h.get("weather_code") is not None] or \
            [h["weather_code"] for h in touched if h.get("weather_code") is not None]
    aqis = [h["us_aqi"] for h in touched if h.get("us_aqi") is not None]
    gusts = [h["wind_gusts_10m"] for h in touched if h.get("wind_gusts_10m") is not None]
    precip = [h["precipitation"] for h in touched[1:] if h.get("precipitation") is not None]
    dirs = [(h["wind_direction_10m"], h.get("wind_speed_10m") or 0) for h in touched
            if h.get("wind_direction_10m") is not None]
    wind_dir = None
    if dirs:  # average direction weighted by speed, as a vector
        x = sum(s * math.sin(math.radians(d)) for d, s in dirs)
        y = sum(s * math.cos(math.radians(d)) for d, s in dirs)
        wind_dir = round(math.degrees(math.atan2(x, y))) % 360 if (x or y) else None
    dew = mean("dew_point_2m")
    r1 = lambda v: None if v is None else round(v, 1)  # noqa: E731
    out = {
        "temp_c": r1(temp), "feels_c": r1(mean("apparent_temperature")), "dew_c": r1(dew),
        "humidity": None if mean("relative_humidity_2m") is None else round(mean("relative_humidity_2m")),
        "wind_kmh": r1(mean("wind_speed_10m")), "gust_kmh": r1(max(gusts)) if gusts else None,
        "wind_dir": wind_dir, "precip_mm": r1(sum(precip)) if precip else None,
        "code": int(max(codes)) if codes else None,
        "aqi": round(max(aqis)) if aqis else None, "pm25": r1(mean("pm2_5")),
        "heat_pct": heat_pct(temp, dew),
    }
    if duration_s > 90 * 60:
        out["temp_start_c"] = r1(_at(hours, start, "temperature_2m"))
        out["temp_end_c"] = r1(_at(hours, end, "temperature_2m"))
    return out


# ---------------------------------------------------------------- the whole job

def update(conn: sqlite3.Connection, today: date | None = None, redo: bool = False,
           session: requests.Session | None = None) -> dict[str, int]:
    """Look up the weather for every workout that needs it. Never raises for network trouble."""
    today = today or date.today()
    session = session or requests.Session()
    stamp = datetime.now().isoformat(timespec="seconds")
    done = {"weather": 0, "indoor": 0, "missing": 0}
    areas: dict[tuple[float, float], list[dict[str, Any]]] = defaultdict(list)
    for w in _wanted(conn, today, redo):
        point = None if _indoor(w["type"]) else _start_point(conn, w["id"], w["raw"])
        if point is None:  # treadmill, gym, or no GPS: weather doesn't apply
            conn.execute("INSERT OR REPLACE INTO weather (activity_id, fetched_at, data) VALUES (?, ?, ?)",
                         (w["id"], stamp, json.dumps({"indoor": True})))
            done["indoor"] += 1
            continue
        w["point"] = point
        areas[(round(point[0], 1), round(point[1], 1))].append(w)
    conn.commit()
    for key, runs in sorted(areas.items(), key=lambda kv: -len(kv[1])):
        # the request uses the area's first start point, rounded to about a kilometre
        lat, lon = round(runs[0]["point"][0], 2), round(runs[0]["point"][1], 2)
        try:
            hours = fetch_area(session, lat, lon, [r["day"] for r in runs], today)
        except Busy as err:
            log.warning("Weather: %s; the rest will be filled in at the next sync.", err)
            break
        except Exception as err:  # offline, or the service is down: try again next time
            log.warning("Couldn't get weather for the area around %.1f, %.1f: %s", key[0], key[1], err)
            continue
        for r in runs:
            c = conditions(hours, datetime.fromisoformat(r["start"].replace(" ", "T")[:19]), r["duration"])
            if c is None:  # the service answered but has nothing for that hour: don't ask every sync
                conn.execute("INSERT OR REPLACE INTO weather (activity_id, fetched_at, data) VALUES (?, ?, ?)",
                             (r["id"], stamp, json.dumps({"unavailable": True})))
                done["missing"] += 1
                continue
            conn.execute("INSERT OR REPLACE INTO weather (activity_id, fetched_at, data) VALUES (?, ?, ?)",
                         (r["id"], stamp, json.dumps(c, separators=(",", ":"))))
            done["weather"] += 1
        conn.commit()
    if done["weather"]:
        log.info("Weather added for %d workout%s", done["weather"], "" if done["weather"] == 1 else "s")
    return done


def update_quietly(conn: sqlite3.Connection, **kwargs) -> dict[str, int] | None:
    try:
        return update(conn, **kwargs)
    except Exception as err:  # never let weather stop a sync
        log.warning("Couldn't update the weather: %s", err)
        return None


def for_activity(conn: sqlite3.Connection, activity_id: int) -> dict[str, Any] | None:
    row = conn.execute("SELECT data FROM weather WHERE activity_id = ?", (activity_id,)).fetchone()
    return json.loads(row[0]) if row else None
