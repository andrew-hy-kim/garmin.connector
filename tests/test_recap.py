from __future__ import annotations

from datetime import date, timedelta

from fitgen import steady_run
from garmin_connector import db, processing, recap
from test_performance import _add

TODAY = date(2026, 3, 1)


def _conn(tmp_path):
    c = db.connect(tmp_path / "r.db")
    db.set_setting(c, "max_hr", 190)
    db.set_setting(c, "lthr", 172)
    db.set_setting(c, "resting_hr", 50)
    # 2024 from its first week: runs every 4 days; 2025 likewise; 2026 so far: a few
    start = date(2024, 1, 2)
    n = 0
    while start + timedelta(days=4 * n) < TODAY:
        _add(c, tmp_path, 100 + n, (start + timedelta(days=4 * n)).isoformat(),
             *steady_run(minutes=30, pace_mps=3.0, start_hr=135, drift_bpm=3))
        n += 1
    db.upsert_activities(c, [{"activityId": 9000, "activityName": "Gym", "startTimeLocal": "2025-06-01 18:00:00",
                              "activityType": {"typeKey": "strength_training"}, "duration": 3600}])
    processing.refresh(c)
    return c


def test_full_years_only(tmp_path):
    c = _conn(tmp_path)
    r = recap.recap(c, TODAY)
    assert [y["year"] for y in r["years"]] == [2025, 2024]  # 2026 isn't over yet
    assert r["current"]["year"] == 2026 and r["current"]["runs"] > 0
    y = {y["year"]: y for y in r["years"]}[2025]
    assert y["runs"] == y["days_run"] == 91  # every fourth day, never two in one day
    assert y["week_streak"] >= 50 and y["day_streak"] == 1
    assert len(y["by_month_m"]) == 12 and abs(sum(y["by_month_m"]) - y["meters"]) < 12  # rounding only
    assert y["cross_hours"] == {"Strength": 1.0}
    assert y["kind"] in {"steady", "building", "big"}
    c.close()


def test_a_year_that_starts_late_is_left_out(tmp_path):
    c = db.connect(tmp_path / "late.db")
    _add(c, tmp_path, 1, "2024-06-01", *steady_run(minutes=20))
    _add(c, tmp_path, 2, "2025-03-01", *steady_run(minutes=20))
    processing.refresh(c)
    assert [y["year"] for y in recap.recap(c, TODAY)["years"]] == [2025]
    c.close()


def test_kind_picks_what_stood_out():
    base = {"longest": {"meters": 10000}, "vo2": {"start": 40, "end": 40.5}, "seconds": 360000,
            "runs": 150, "meters": 1_000_000, "cross_hours": {}}
    assert recap.kind({**base, "longest": {"meters": 42300}}, 2_000_000) == "marathon"
    assert recap.kind({**base, "vo2": {"start": 35, "end": 41}}, 2_000_000) == "engine"
    assert recap.kind(base, 1_000_000) == "big"
    assert recap.kind(base, 2_000_000) == "steady"
    assert recap.kind({**base, "runs": 10, "seconds": 18000, "cross_hours": {"Hiking & walking": 40}}, 2_000_000) == "trail"
    assert recap.kind({**base, "runs": 10, "vo2": None}, 2_000_000) == "quiet"
