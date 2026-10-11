from __future__ import annotations

import json
import math
from datetime import date, datetime, timedelta

import pytest

from garmin_connector import api, apple, db, weather

APPLE = apple.APPLE_ID_BASE  # Apple Watch workouts have IDs from here up


@pytest.fixture(autouse=True)
def _no_pause(monkeypatch):
    monkeypatch.setattr(weather, "PAUSE_S", 0)


class FakeResponse:
    def __init__(self, status, body):
        self.status_code, self._body = status, body
        self.ok = status < 400
        self.headers = {"content-type": "application/json; charset=utf-8"}
        self.text = json.dumps(body)

    def json(self):
        return self._body


class FakeOpenMeteo:
    """Answers like Open-Meteo: hourly arrays in local time for the requested dates."""

    def __init__(self, temp=lambda t: 15 + 8 * math.sin((t.hour - 9) / 24 * 2 * math.pi), status=200):
        self.calls, self.temp, self.status = [], temp, status

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, dict(params)))
        if self.status != 200:
            return FakeResponse(self.status, {"error": True, "reason": "Too many requests"})
        start, end = date.fromisoformat(params["start_date"]), date.fromisoformat(params["end_date"])
        times = [datetime(start.year, start.month, start.day) + timedelta(hours=h)
                 for h in range(((end - start).days + 1) * 24)]
        names = params["hourly"].split(",")
        gen = {
            "temperature_2m": self.temp,
            "apparent_temperature": lambda t: self.temp(t) + 1,
            "dew_point_2m": lambda t: self.temp(t) - 6,
            "relative_humidity_2m": lambda t: 65,
            "precipitation": lambda t: 0.4 if t.hour == 8 else 0.0,
            "weather_code": lambda t: 61 if t.hour == 8 else 2,
            "wind_speed_10m": lambda t: 12,
            "wind_gusts_10m": lambda t: 20 + t.hour % 3,
            "wind_direction_10m": lambda t: 350 if t.hour % 2 else 10,  # around north, either side
            "us_aqi": lambda t: 30 + t.hour,
            "pm2_5": lambda t: 5,
        }
        hourly = {"time": [t.strftime("%Y-%m-%dT%H:%M") for t in times]}
        for n in names:
            hourly[n] = [round(gen[n](t), 1) for t in times]
        return FakeResponse(200, {"latitude": params["latitude"], "longitude": params["longitude"],
                                  "timezone": "America/Los_Angeles", "utc_offset_seconds": -25200,
                                  "hourly_units": {n: "" for n in names}, "hourly": hourly})


def _add(conn, aid, start, kind="running", duration=3600, lat=47.61, lon=-122.33):
    raw = {"activityId": aid, "activityName": f"Run {aid}", "startTimeLocal": start,
           "activityType": {"typeKey": kind}, "distance": 10000, "duration": duration}
    if lat is not None:
        raw.update(startLatitude=lat, startLongitude=lon)
    db.upsert_activities(conn, [raw])


def test_heat_and_labels():
    assert weather.heat_pct(10, 5) == 0
    assert weather.heat_pct(25, 18) == 3.0       # 77°F + 64°F = 141
    assert weather.heat_pct(32, 26) == 7.5         # 90°F + 79°F: very humid heat
    assert weather.heat_pct(None, 5) is None
    assert weather.aqi_label(42) == "good" and weather.aqi_label(160) == "unhealthy"
    assert weather.sky(0) == "clear" and weather.sky(63) == "rain" and weather.sky(95) == "thunderstorm"


def test_conditions_average_over_the_run():
    hours = {}
    base = datetime(2026, 8, 4)
    for h in range(24):
        t = base + timedelta(hours=h)
        hours[t.strftime("%Y-%m-%dT%H:00")] = {"temperature_2m": float(h), "dew_point_2m": 5.0, "apparent_temperature": h + 1.0,
                                                "relative_humidity_2m": 60, "precipitation": 0.0, "weather_code": 1,
                                                "wind_speed_10m": 10, "wind_gusts_10m": 18, "wind_direction_10m": 90,
                                                "us_aqi": 40, "pm2_5": 4}
    c = weather.conditions(hours, datetime(2026, 8, 4, 7, 30), 3600)  # 7:30–8:30
    assert c["temp_c"] == 8.0 and c["dew_c"] == 5.0 and c["wind_dir"] == 90 and c["aqi"] == 40
    long_run = weather.conditions(hours, datetime(2026, 8, 4, 6, 0), 2 * 3600)
    assert long_run["temp_start_c"] == 6.0 and long_run["temp_end_c"] == 8.0
    assert weather.conditions({}, datetime(2026, 8, 4, 7), 3600) is None
    # a wind just west of north rounds to north as 0°, never 360°
    for t in hours:
        hours[t]["wind_direction_10m"] = 359.7
    assert weather.conditions(hours, datetime(2026, 8, 4, 7, 30), 3600)["wind_dir"] == 0


def test_backfill_groups_requests_and_stores(tmp_path):
    conn = db.connect(tmp_path / "w.db")
    today = date(2026, 10, 5)
    # five years of runs in one area, a few in another city, one treadmill run, one recent run
    d = date(2021, 6, 1)  # some before air-quality history begins
    n = 0
    while d < date(2026, 8, 1):
        _add(conn, 1000 + n, f"{d.isoformat()} 07:00:00"); n += 1
        d += timedelta(days=3)
    _add(conn, 1, "2025-05-10 08:15:00", lat=40.71, lon=-74.01)
    _add(conn, 2, "2025-05-11 08:15:00", lat=40.72, lon=-74.00)
    _add(conn, 3, "2026-09-20 18:00:00", kind="treadmill_running", lat=None)
    _add(conn, 4, "2026-10-03 07:00:00")
    _add(conn, APPLE + 5, "2026-09-21 07:00:00", lat=None)  # Apple, outdoors, no GPS: placed where the runs around it were
    _add(conn, APPLE + 6, "2019-06-01 07:00:00", lat=None)  # no GPS, and no runs for months either side
    _add(conn, 7, "2026-09-22 07:00:00", lat=None)  # Garmin "run" without GPS: indoors with GPS off, not placed
    fake = FakeOpenMeteo()
    r = weather.update(conn, today=today, session=fake)
    assert r["indoor"] == 1 and r["no_gps"] == 2 and r["weather"] == n + 4 and r["missing"] == 0
    weather_calls = [c for c in fake.calls if "air-quality" not in c[0]]
    assert len(weather_calls) <= 25, len(weather_calls)   # five years of runs: a couple of dozen requests
    for url, p in fake.calls:  # only rounded coordinates leave the Mac
        assert round(p["latitude"], 2) == p["latitude"] and p["timezone"] == "auto"
        assert (date.fromisoformat(p["end_date"]) - date.fromisoformat(p["start_date"])).days < weather.CHUNK_DAYS
        if "air-quality" in url:
            assert p["start_date"] >= weather.AIR_FROM.isoformat()
    assert any(u == weather.RECENT for u, _ in fake.calls)  # the recent run comes from the forecast service
    w = weather.for_activity(conn, 4)
    assert w["temp_c"] is not None and w["aqi"] is not None and w["heat_pct"] is not None
    assert weather.for_activity(conn, 3) == {"indoor": True}
    assert weather.for_activity(conn, APPLE + 5)["place_assumed"] and weather.for_activity(conn, APPLE + 5)["temp_c"] is not None
    assert weather.for_activity(conn, APPLE + 6) == {"no_gps": True}  # not called indoor
    assert weather.for_activity(conn, 7) == {"no_gps": True}
    assert weather.for_activity(conn, 4).get("place_assumed") is None
    old = weather.for_activity(conn, 1000)
    assert old["aqi"] is None and old["temp_c"] is not None   # before air-quality history
    # nothing left to do; a second run sends nothing
    fake2 = FakeOpenMeteo()
    assert weather.update(conn, today=today, session=fake2)["weather"] == 0 and not fake2.calls
    # a week later the recent run is fetched once more, for the final history
    fake3 = FakeOpenMeteo()
    assert weather.update(conn, today=today + timedelta(days=8), session=fake3)["weather"] == 1
    # in the API and the activity list
    acts = {a["activity_id"]: a for a in api.activities(conn)}
    assert acts[4]["weather"]["temp_c"] is not None and acts[3]["weather"] == {"indoor": True}
    # deleting an activity deletes its weather
    db.delete_activities(conn, [4])
    assert weather.for_activity(conn, 4) is None


def test_busy_or_offline_never_breaks_and_resumes(tmp_path):
    conn = db.connect(tmp_path / "w.db")
    _add(conn, 1, "2025-05-10 08:15:00")
    busy = FakeOpenMeteo(status=429)
    assert weather.update(conn, today=date(2026, 10, 5), session=busy)["weather"] == 0
    assert weather.for_activity(conn, 1) is None   # left for next time

    class Offline:
        def get(self, *a, **k):
            raise ConnectionError("no network")
    assert weather.update(conn, today=date(2026, 10, 5), session=Offline())["weather"] == 0
    assert weather.update(conn, today=date(2026, 10, 5), session=FakeOpenMeteo())["weather"] == 1


def test_no_data_is_remembered_not_asked_every_sync(tmp_path):
    conn = db.connect(tmp_path / "w.db")
    _add(conn, 1, "2025-05-10 08:15:00")
    empty = FakeOpenMeteo()
    empty_get = empty.get
    def get(url, params=None, timeout=None):  # temperature comes back as nulls
        r = empty_get(url, params, timeout)
        h = r._body["hourly"]
        for k in h:
            if k != "time":
                h[k] = [None] * len(h["time"])
        return r
    empty.get = get
    assert weather.update(conn, today=date(2026, 10, 5), session=empty)["missing"] == 1
    assert weather.for_activity(conn, 1) == {"unavailable": True}
    again = FakeOpenMeteo()
    assert weather.update(conn, today=date(2026, 10, 5), session=again)["weather"] == 0 and not again.calls


@pytest.mark.parametrize("days,expected", [
    ([date(2026, 1, 1), date(2026, 1, 5)], 1),
    ([date(2026, 1, 1), date(2026, 3, 1)], 2),           # a gap of more than a month
    ([date(2026, 1, 1) + timedelta(days=7 * i) for i in range(30)], 3),  # 30 weeks, steady: ~92-day pieces
])
def test_chunks(days, expected):
    chunks = weather._chunks(days)
    assert len(chunks) == expected
    assert all((b - a).days < weather.CHUNK_DAYS for a, b in chunks)


def test_runs_filed_without_a_place_are_placed_later(tmp_path):
    """A run stored as indoor or no-GPS by an older version gets weather once a run nearby has GPS."""
    conn = db.connect(tmp_path / "w.db")
    _add(conn, APPLE + 1, "2021-05-01 07:00:00", lat=None)
    _add(conn, APPLE + 2, "2021-05-02 07:00:00", kind="treadmill_running", lat=None)
    today = date(2026, 10, 5)
    r = weather.update(conn, today=today, session=FakeOpenMeteo())
    assert r["no_gps"] == 1 and r["indoor"] == 1
    conn.execute("UPDATE weather SET data = '{\"indoor\": true}' WHERE activity_id = ?", (APPLE + 1,))  # how older versions filed it
    _add(conn, 3, "2021-05-08 07:00:00")
    r = weather.update(conn, today=today, session=FakeOpenMeteo())
    assert r["weather"] == 2 and weather.for_activity(conn, APPLE + 1)["place_assumed"]
    assert weather.for_activity(conn, APPLE + 2) == {"indoor": True}  # the treadmill stays indoors


def test_indoor_garmin_types():
    for t in ("treadmill_running", "indoor_cycling", "virtual_ride", "lap_swimming", "strength_training", "hiit",
              "pilates", "indoor_cardio", "floor_climbing", "yoga", "elliptical", "indoor_rowing"):
        assert weather._indoor(t), t
    for t in ("running", "trail_running", "track_running", "open_water_swimming", "cycling", "hiking", "walking"):
        assert not weather._indoor(t), t


def test_offline_stops_after_a_few_places(tmp_path):
    conn = db.connect(tmp_path / "w.db")
    for i in range(8):  # eight different places
        _add(conn, i + 1, "2025-05-10 08:15:00", lat=10 + i, lon=20 + i)

    class Offline:
        calls = 0

        def get(self, *a, **k):
            Offline.calls += 1
            raise ConnectionError("no network")
    assert weather.update(conn, today=date(2026, 10, 5), session=Offline())["weather"] == 0
    assert Offline.calls == 3
