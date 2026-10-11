from __future__ import annotations

import math
from datetime import date, timedelta

import pytest

from fitgen import steady_run
from garmin_connector import db, performance as perf, processing
from test_sessions import _add as _add_run


def _add(conn, tmp_path, activity_id, day, samples, laps):
    """A run with the average heart rate Garmin's summary always carries."""
    _add_run(conn, tmp_path, activity_id, day, samples, laps)
    hr = [s["hr"] for s in samples if s.get("hr")]
    conn.execute("UPDATE activities SET avg_hr = ? WHERE activity_id = ?", (sum(hr) / len(hr), activity_id))


def test_daniels_gilbert_matches_the_tables():
    # Daniels' VDOT tables: 20:00 for 5K is VDOT ~49.8; 40:00 for 10K ~51.9 (well, 51.8-52.0)
    assert abs(perf.vo2max_from_race(5000, 1200) - 49.8) < 0.3
    assert abs(perf.vo2max_from_race(10000, 2400) - 51.9) < 0.3
    # and back again
    assert abs(perf.race_seconds(49.8, 5000) - 1200) < 5
    assert perf.race_seconds(5, 5000) is None  # not a plausible VO2max
    # speed_at_vo2 inverts vo2_at
    assert abs(perf.vo2_at(perf.speed_at_vo2(45.0)) - 45.0) < 1e-6


def test_effective_vo2max_from_heart_rate():
    # at max heart rate the run's own speed is the VO2max speed
    speed = 250.0  # m/min
    assert abs(perf.vo2max_from_hr(5000, 5000 / speed * 60, 190, 190) - perf.vo2_at(speed * 1.0)) < 0.5
    # the same pace at a lower heart rate means a bigger engine
    assert perf.vo2max_from_hr(10000, 3000, 150, 190) > perf.vo2max_from_hr(10000, 3000, 170, 190)
    assert perf.vo2max_from_hr(10000, 3000, None, 190) == 0.0


def test_marathon_shape_requirements():
    assert round(perf.required_shape(10)) == 17
    assert round(perf.required_shape(21.0975), 1) == 42.5
    assert round(perf.required_shape(42.195)) == 100
    # enough shape: no penalty; none at all: 60 % of VO2max usable
    assert perf.shape_factor(120, 42.195) == 1.0
    assert perf.shape_factor(0, 42.195) == pytest.approx(0.6, abs=0.01)


def test_load_extras():
    flat = [{"date": f"d{i}", "load": 50.0, "fitness": 40.0, "fatigue": 50.0, "form": -10} for i in range(10)]
    out = perf.load_extras(flat)
    assert out["monotony"] == 10.0  # the same load every day is as monotonous as it gets
    assert out["week_load"] == 350 and out["rest_days"] >= 1
    varied = flat[:-7] + [{**flat[0], "load": x} for x in (0, 120, 0, 60, 0, 150, 30)]
    v = perf.load_extras(varied)
    assert v["monotony"] < 1.5 and v["strain"] < out["strain"]
    fresh = [{**f, "fitness": 60.0, "fatigue": 30.0} for f in flat]
    assert perf.load_extras(fresh)["rest_days"] == 0 and perf.load_extras(fresh)["balanced_load"] > 60
    assert perf.load_extras(flat[:3]) is None


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "p.db")
    db.set_setting(c, "max_hr", 190)
    db.set_setting(c, "lthr", 172)
    db.set_setting(c, "resting_hr", 50)
    today = date.today()
    for n in range(30):  # every other day for two months, easy runs at 3.2 m/s
        _add(c, tmp_path, 100 + n, (today - timedelta(days=1 + 2 * n)).isoformat(),
             *steady_run(minutes=50, pace_mps=3.2, start_hr=140, drift_bpm=6))
    processing.refresh(c)
    yield c
    c.close()


def test_summary(conn):
    s = perf.summary(conn)
    assert 35 < s["vo2max"] < 70
    assert s["correction_factor"] == 1.0 and s["calibrated_by"] is None  # no races marked
    assert len(s["per_activity"]) == 30
    assert s["history"] and s["history"][-1]["vo2max"] == s["vo2max"]
    # 50-minute runs only: weekly distance but no long runs, so the marathon is endurance-limited
    shape = s["marathon_shape"]
    assert shape["long_runs"] == 0 and 0 < shape["percent"] < 60
    by = {r["race"]: r for r in s["races"]}
    assert by["Marathon"]["limited_by_endurance"] and not by["5 km"]["limited_by_endurance"]
    assert by["5 km"]["seconds"] < by["10 km"]["seconds"] < by["Marathon"]["seconds"]
    # training paces get faster from easy to repetition, and easy brackets the runs' 3.2 m/s loosely
    paces = s["paces"]
    assert [p["key"] for p in paces] == ["easy", "marathon", "threshold", "interval", "repetition"]
    assert all(a["fast_mps"] < b["fast_mps"] for a, b in zip(paces, paces[1:]))
    assert paces[0]["slow_mps"] < 3.2 * 1.25


def test_races_marked_in_garmin_calibrate(conn, tmp_path):
    # a race at the same pace and heart rate as training would read low; the race result corrects it
    today = date.today()
    _add(conn, tmp_path, 900, (today - timedelta(days=4)).isoformat(),
         *steady_run(minutes=20, pace_mps=4.2, start_hr=176, drift_bpm=4))  # clear of cadence (168)
    conn.execute("UPDATE activities SET raw_json = json_set(raw_json, '$.eventType', json('{\"typeKey\": \"race\"}')) "
                 "WHERE activity_id = 900")
    processing.refresh(conn, force=True)
    s = perf.summary(conn)
    assert s["calibrated_by"] == 900 and s["correction_factor"] != 1.0


@pytest.mark.parametrize("vdot,meters,daniels", [
    (40, 5000, "24:08"), (40, 42195, "3:49:45"), (50, 5000, "19:57"), (50, 10000, "41:21"),
    (50, 21097.5, "1:31:35"), (60, 10000, "35:22"),
])
def test_race_times_match_daniels_tables(vdot, meters, daniels):
    want = sum(int(v) * 60 ** i for i, v in enumerate(reversed(daniels.split(":"))))
    assert abs(perf.race_seconds(vdot, meters) - want) <= 10


def test_training_paces_contain_daniels_paces():
    """VDOT 50 in Daniels' tables: M 4:31, T 4:15, I 4:00 and R 3:50 per km (92 s per 400 m)."""
    zones = {k: (perf.speed_at_vo2(50 * hi), perf.speed_at_vo2(50 * lo))
             for k, _, lo, hi, _ in perf.PACE_ZONES}
    for key, per_km in (("marathon", 271), ("threshold", 255), ("interval", 240), ("repetition", 230)):
        fast, slow = zones[key]
        assert 60000 / fast - 2 <= per_km <= 60000 / slow + 2, key


def test_trimp_uses_banisters_constants_for_women():
    from garmin_connector import analysis
    men, women = (analysis.trimp_from_summary(3600, 160, 50, 190, male=m) for m in (True, False))
    x = (160 - 50) / (190 - 50)
    assert men == pytest.approx(60 * x * 0.64 * math.exp(1.92 * x))
    assert women == pytest.approx(60 * x * 0.86 * math.exp(1.67 * x))


def test_summary_is_reused_until_the_data_changes(conn, tmp_path, monkeypatch):
    calls = []
    real = perf._summary
    monkeypatch.setattr(perf, "_summary", lambda c, today: calls.append(1) or real(c, today))
    first = perf.summary(conn)
    first["vo2max"] = -1  # a caller changing its copy doesn't change the cached one
    assert perf.summary(conn)["vo2max"] > 0 and len(calls) == 1
    # a new run, a re-analysis with other settings, or another day all work it out again
    _add(conn, tmp_path, 999, (date.today() - timedelta(days=1)).isoformat(),
         *steady_run(minutes=50, pace_mps=3.6, start_hr=150, drift_bpm=6))
    processing.refresh(conn)
    assert len(perf.summary(conn)["per_activity"]) == 31 and len(calls) == 2
    db.set_setting(conn, "max_hr", 200)
    processing.refresh(conn)
    perf.summary(conn)
    assert len(calls) == 3
    perf.summary(conn, date.today() + timedelta(days=1))
    assert len(calls) == 4
