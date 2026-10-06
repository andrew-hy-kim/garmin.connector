from __future__ import annotations

from datetime import datetime

import pytest

from applegen import TZ, export_zip, run
from garmin_connector import api, apple, db, processing, sync


@pytest.fixture
def conn(tmp_path):
    conn = db.connect(tmp_path / "a.db")
    db.set_setting(conn, "max_hr", 190)
    db.set_setting(conn, "lthr", 170)
    db.set_setting(conn, "resting_hr", 55)
    # the Garmin era starts June 2023
    db.upsert_activities(conn, [{"activityId": 11_000_000_000, "activityName": "Garmin run", "activityType": {"typeKey": "running"},
                                 "startTimeLocal": "2023-06-05 07:00:00", "startTimeGMT": "2023-06-05 14:00:00",
                                 "distance": 8000, "duration": 2400}])
    return conn


def _export(tmp_path):
    d = lambda *a: datetime(*a, tzinfo=TZ)  # noqa: E731
    return export_zip(tmp_path / "export.zip", [
        run(d(2023, 3, 4, 7, 0), minutes=40, speed=3.2),                        # outdoor, newer export format
        run(d(2022, 9, 10, 8, 0), minutes=30, speed=2.9, new_format=False),     # older export format
        run(d(2023, 4, 2, 18, 0), minutes=25, speed=3.0, indoor=True, phone=True),  # treadmill, iPhone in pocket
        run(d(2023, 5, 1, 7, 0), minutes=60, speed=7.0, kind="HKWorkoutActivityTypeCycling"),
        run(d(2023, 7, 1, 7, 0), minutes=30),                                   # after the Garmin start: skipped
        run(d(2023, 6, 5, 7, 10), minutes=20),                                  # overlaps the Garmin run: skipped
        run(d(2023, 1, 1, 9, 0), minutes=20, kind="HKWorkoutActivityTypeYoga"),  # not a kind we import
    ], vo2=[(d(2023, 3, 4, 8, 0), 47.5), (d(2023, 5, 20, 8, 0), 48.1)])


def test_import_runs_rides_with_streams(conn, tmp_path):
    r = apple.import_export(conn, _export(tmp_path))
    assert r["imported"] == 4 and r["vo2max"] == 2
    acts = {a["start_time_local"]: a for a in api.activities(conn)}
    out = acts["2023-03-04 07:00:00"]
    assert apple.is_apple(out["activity_id"]) and out["activity_type"] == "running"
    assert abs(out["distance_m"] - 3.2 * 2400) < 50 and out["avg_hr"] and out["has_streams"]
    assert acts["2022-09-10 08:00:00"]["distance_m"] == pytest.approx(2.9 * 1800, rel=0.01)  # older format totals
    assert acts["2023-04-02 18:00:00"]["activity_type"] == "treadmill_running"
    assert acts["2023-05-01 07:00:00"]["activity_type"] == "cycling"
    assert "2023-07-01 07:00:00" not in acts  # Garmin era
    streams, _ = db.load_streams(conn, out["activity_id"])
    n = len(streams["t"])
    assert n == 2401
    assert sum(h is not None for h in streams["hr"]) > 0.95 * n
    assert sum(la is not None for la in streams["lat"]) > 0.95 * n
    assert streams["distance"][-1] == pytest.approx(3.2 * 2400, rel=0.02)
    assert 3.0 < streams["speed"][1200] < 3.4 and streams["cadence"][600] == 170
    tread, _ = db.load_streams(conn, acts["2023-04-02 18:00:00"]["activity_id"])
    # the watch's own distance and steps only, not the iPhone's on top
    assert tread["lat"][100] is None and tread["distance"][-1] == pytest.approx(3.0 * 1500, rel=0.05)
    assert tread["cadence"][700] == 170 and 2.8 < tread["speed"][700] < 3.2
    # analysed like any other run: zones, load, best efforts
    processing.refresh(conn)
    detail = api.activity_detail(conn, out["activity_id"])
    assert detail["source"] == "apple" and detail["metrics"]["trimp"] > 0
    assert "1 km" in (detail["metrics"].get("best_efforts") or {})
    # Apple's VO2 max fills the chart, before Garmin's
    assert {r["date"] for r in api.vo2max(conn)} >= {"2023-03-04", "2023-05-20"}


def test_import_again_updates_in_place(conn, tmp_path):
    path = _export(tmp_path)
    apple.import_export(conn, path)
    first = conn.execute("SELECT count(*) FROM activities").fetchone()[0]
    apple.import_export(conn, path)
    assert conn.execute("SELECT count(*) FROM activities").fetchone()[0] == first


def test_sync_leaves_apple_workouts_alone(conn, tmp_path, monkeypatch):
    apple.import_export(conn, _export(tmp_path))
    ids = [r[0] for r in conn.execute("SELECT activity_id FROM activities")]
    assert any(apple.is_apple(i) for i in ids)

    # never downloaded from Garmin, never checked for Garmin VO2 max
    asked = []

    class Client:
        def download_activity(self, activity_id, dl_fmt=None):
            asked.append(activity_id)
            raise RuntimeError("offline")
    monkeypatch.setattr(sync, "REQUEST_PAUSE_S", 0)
    sync.download_missing_fit(Client(), conn, tmp_path)
    assert asked == [11_000_000_000]  # only the Garmin run
    assert "2023-03-04" not in sync.vo2max_days_to_check(conn)


def test_bad_exports_explain_themselves(tmp_path):
    import zipfile
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(bad, "w") as z:
        z.writestr("something.txt", "hi")
    with pytest.raises(ValueError, match="export.xml"):
        apple.Export(bad)
    with pytest.raises(ValueError):
        apple.Export(tmp_path / "missing-folder")


def test_import_before_date(conn, tmp_path):
    r = apple.import_export(conn, _export(tmp_path), before="2023-01-01")
    assert r["imported"] == 1  # only the September 2022 run
