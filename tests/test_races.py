from __future__ import annotations

from datetime import date, timedelta

import pytest

from fitgen import steady_run
from garmin_connector import db, processing, races, sync
from test_sessions import _add


def test_riegel():
    # 20:00 for 5K -> about 41:42 for 10K
    assert round(races.riegel(1200, 5000, 10000)) == 2502
    assert races.riegel(1200, 5000, 5000) == 1200


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "r.db")
    db.set_setting(c, "lthr", 170)
    db.set_setting(c, "max_hr", 190)
    today = date.today()
    # Recent: 40-minute runs at 3.5 m/s (about 8.4 km, so 5K efforts but no 10K)
    for n in range(4):
        _add(c, tmp_path, 100 + n, (today - timedelta(days=3 + n * 7)).isoformat(), *steady_run(minutes=40, pace_mps=3.5))
    # Four months ago: slower, and a faster run long ago that must not count
    _add(c, tmp_path, 200, (today - timedelta(days=120)).isoformat(), *steady_run(minutes=40, pace_mps=3.2))
    _add(c, tmp_path, 300, (today - timedelta(days=400)).isoformat(), *steady_run(minutes=40, pace_mps=4.5))
    processing.refresh(c)
    yield c
    c.close()


def test_predictions_from_recent_efforts(conn):
    out = races.predictions(conn)
    by = {r["race"]: r for r in out["races"]}
    five, ten, half, full = by["5 km"], by["10 km"], by["Half marathon"], by["Marathon"]
    # 5K straight from the 5 km best effort at 3.5 m/s
    assert abs(five["seconds"] - 5000 / 3.5) <= 2
    assert five["basis"]["label"] == "5 km" and five["basis"]["race"] is False
    assert five["seconds"] < ten["seconds"] < half["seconds"]
    assert ten["seconds"] == round(races.riegel(five["basis"]["seconds"], 5000, 10000))
    # no 10 km effort in the last 90 days, so no marathon prediction from a 5K
    assert full["seconds"] is None
    # the half is predicted, with a note that recent long runs are short of it
    assert 8300 <= half["longest_run_m"] <= 8500
    # same distances as the records; short ones come from efforts at least that long
    assert [r["race"] for r in out["races"]] == ["400 m", "1 km", "1 mile", "5 km", "10 km", "Half marathon", "Marathon"]
    mile = by["1 mile"]
    # a 5 km at a steady 3.5 m/s means a faster mile than that pace (Riegel scales down too)
    assert mile["seconds"] == round(races.riegel(five["basis"]["seconds"], 5000, 1609.344)) < 1609.344 / 3.5
    assert by["400 m"]["seconds"] < by["1 km"]["seconds"] < mile["seconds"] < five["seconds"]
    assert mile["garmin_seconds"] is None  # Garmin doesn't predict the mile
    # faster than three months ago (3.2 m/s then)
    assert five["change_s"] < 0
    # the 4.5 m/s run from over a year ago is ignored
    assert five["seconds"] > 5000 / 4.5 + 60


def test_garmin_predictions_saved_at_sync(conn):
    today = date.today()

    class Client:
        def get_race_predictions(self, start, end, kind):
            assert kind == "daily" and end == today.isoformat()
            return [{"calendarDate": (today - timedelta(days=100)).isoformat(), "time5K": 1500, "time10K": 3150,
                     "timeHalfMarathon": 7000, "timeMarathon": 14800},
                    {"calendarDate": today.isoformat(), "time5K": 1440, "time10K": 3000,
                     "timeHalfMarathon": 6700, "timeMarathon": 14100},
                    {"calendarDate": "2026-01-01"}]  # nothing in it: skipped

    assert sync.fetch_race_predictions(Client(), conn, today) == 2
    by = {r["race"]: r for r in races.predictions(conn)["races"]}
    assert by["Marathon"]["garmin_seconds"] == 14100 and by["Marathon"]["garmin_change_s"] == -700
    assert by["5 km"]["garmin_seconds"] == 1440

    class Broken:
        def get_race_predictions(self, *a):
            raise RuntimeError("Garmin is down")

    assert sync.fetch_race_predictions(Broken(), conn, today) == 0  # never stops a sync


def test_no_runs_no_predictions(tmp_path):
    c = db.connect(tmp_path / "empty.db")
    out = races.predictions(c)
    assert all(r["seconds"] is None and r["garmin_seconds"] is None for r in out["races"])


def test_shortest_effort_for_each_race():
    assert races.shortest_effort(400) == 400 and races.shortest_effort(1609.344) == 1609.344
    assert races.shortest_effort(10000) == 5000 and races.shortest_effort(21097.5) == 5000
    assert races.shortest_effort(42195) > 9000  # the 10 km effort
