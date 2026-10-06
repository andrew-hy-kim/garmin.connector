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
    assert r["with_route"] == 3 and r["no_route"] == 0  # two outdoor runs and the ride
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


def test_climb_from_the_route_when_apple_has_no_total(conn, tmp_path):
    d = lambda *a: datetime(*a, tzinfo=TZ)  # noqa: E731
    xml, recs, gpx = run(d(2021, 3, 4, 7, 0), minutes=40)
    xml = xml.replace('<MetadataEntry key="HKElevationAscended" value="2500 cm"/>', "")  # older workouts lack it
    apple.import_export(conn, export_zip(tmp_path / "e.zip", [(xml, recs, gpx)]))
    gain = conn.execute("SELECT elevation_gain_m FROM activities WHERE activity_id > ?", (apple.APPLE_ID_BASE,)).fetchone()[0]
    # the route rolls 10 m up and down (sin, period ~31 min): about 15 m of climb in 40 minutes, no jitter counted
    assert 10 < gain < 22


def test_climb_ignores_jitter():
    assert apple.climb_m([50, 51, 50, 51.5, 50, 51, 50]) == 0
    assert apple.climb_m([50, 52, 54, 53, 58, 50]) == 9  # 4 up, a dip, 5 up
    assert apple.climb_m([None, None]) is None


def test_routes_the_xml_does_not_name_are_matched_by_time(conn, tmp_path):
    import re
    d = lambda *a: datetime(*a, tzinfo=TZ)  # noqa: E731
    unnamed = run(d(2021, 3, 4, 7, 0), minutes=30)
    apart = run(d(2021, 3, 9, 7, 0), minutes=30)
    no_gps = run(d(2021, 3, 12, 7, 0), minutes=30)
    strip = lambda x: re.sub(r"<WorkoutRoute.*?</WorkoutRoute>", "", x[0])  # noqa: E731
    route_el = re.search(r"<WorkoutRoute.*?</WorkoutRoute>", apart[0]).group(0)
    workouts = [(strip(unnamed), unnamed[1], unnamed[2]),           # no route element at all
                (strip(apart) + route_el, apart[1], apart[2]),       # route listed apart from its workout
                (strip(no_gps), no_gps[1], None)]                    # an old watch without GPS
    r = apple.import_export(conn, export_zip(tmp_path / "e.zip", workouts))
    assert r["imported"] == 3 and r["with_route"] == 2 and r["no_route"] == 1
    acts = {a["start_time_local"][:10]: a for a in api.activities(conn)}
    for day in ("2021-03-04", "2021-03-09"):
        s, _ = db.load_streams(conn, acts[day]["activity_id"])
        assert s["lat"][600] is not None and acts[day]["activity_type"] == "running"
    # no GPS: still an outdoor run, and the weather doesn't call it indoor
    from garmin_connector import weather
    assert acts["2021-03-12"]["activity_type"] == "running"

    class Offline:
        def get(self, *a, **k):
            raise OSError("offline")
    weather.update(conn, session=Offline())
    assert weather.for_activity(conn, acts["2021-03-12"]["activity_id"]) == {"no_gps": True}


def _local_times(gpx, shift_s=0):
    """The same route with its times written in local time (-07:00), optionally shifted."""
    import re
    from datetime import timedelta

    def local(m):
        t = datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=apple.timezone.utc)
        return "<time>" + (t + timedelta(seconds=shift_s)).astimezone(TZ).strftime("%Y-%m-%dT%H:%M:%S.000%z")[:-2] + ":00</time>"
    return gpx[0], re.sub(r"<time>([^<]+)</time>", local, gpx[1])


def test_route_times_in_local_time_and_early_starts(conn, tmp_path):
    d = lambda *a: datetime(*a, tzinfo=TZ)  # noqa: E731
    local = run(d(2021, 4, 1, 7, 0), minutes=30)
    early = run(d(2021, 4, 3, 7, 0), minutes=30)
    import re
    early_xml = re.sub(r"<WorkoutRoute.*?</WorkoutRoute>", "", early[0])  # not named, and starts 5 min early
    r = apple.import_export(conn, export_zip(tmp_path / "e.zip", [
        (local[0], local[1], _local_times(local[2])),
        (early_xml, early[1], _local_times(early[2], shift_s=-300)),
    ]))
    assert r["with_route"] == 2 and r["no_route"] == 0, r
    acts = {a["start_time_local"][:10]: a for a in api.activities(conn)}
    s, _ = db.load_streams(conn, acts["2021-04-01"]["activity_id"])
    assert sum(x is not None for x in s["lat"]) > 0.95 * len(s["t"])
    assert abs(acts["2021-04-01"]["distance_m"] - 3.0 * 1800) < 60


def test_import_says_why_runs_have_no_map(conn, tmp_path):
    import re
    d = lambda *a: datetime(*a, tzinfo=TZ)  # noqa: E731
    gone = run(d(2021, 5, 1, 7, 0), minutes=30)        # route named, file not in the zip
    wrong = run(d(2021, 5, 2, 7, 0), minutes=30)       # route file from another day
    bare = run(d(2021, 5, 3, 7, 0), minutes=30)        # no route at all
    other = run(d(2021, 5, 20, 7, 0), minutes=30)
    wrong_xml = wrong[0].replace(wrong[2][0], "elsewhere.gpx")
    r = apple.import_export(conn, export_zip(tmp_path / "e.zip", [
        (gone[0], gone[1], None),
        (wrong_xml, wrong[1], ("elsewhere.gpx", other[2][1])),
        (re.sub(r"<WorkoutRoute.*?</WorkoutRoute>", "", bare[0]), bare[1], None),
    ]))
    assert r["no_route"] == 3 and r["why_no_route"] == {"missing": 1, "times": 1, "none": 1}
    assert r["no_route_days"][0].startswith("2021-05-01 07:00")
