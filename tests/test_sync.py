"""Tests run against a fake Garmin client, so they never touch a real account."""

from __future__ import annotations

from contextlib import closing

import io
import tempfile
import zipfile
from datetime import date, timedelta
from pathlib import Path

import pytest

from fitgen import steady_run, write_fit
from garmin_connector import db, sync
from garmin_connector.web import create_app


def make_activity(activity_id: int, day: str, **extra):
    return {
        "activityId": activity_id,
        "activityName": f"Run {activity_id}",
        "startTimeLocal": f"{day} 07:00:00",
        "startTimeGMT": f"{day} 14:00:00",
        "activityType": {"typeKey": "running"},
        "distance": 5000.0,
        "duration": 1500.0,
        "averageHR": 150.0,
        "averageSpeed": 3.33,
        "vO2MaxValue": 50.0,
        **extra,
    }


class FakeGarmin:
    def __init__(self, activities):
        self.activities = activities
        self.activity_calls = []
        self.metric_days = []

    def get_activities_by_date(self, start, end=None):
        self.activity_calls.append((start, end))
        return [a for a in self.activities if start <= a["startTimeLocal"][:10] <= end]

    def get_max_metrics(self, day):
        self.metric_days.append(day)
        return [{"generic": {"calendarDate": day, "vo2MaxPreciseValue": 50.4, "vo2MaxValue": 50}, "cycling": None}]

    def download_activity(self, activity_id, dl_fmt=None):
        # Garmin sends the original .fit zipped
        with tempfile.TemporaryDirectory() as tmp:
            fit_bytes = write_fit(Path(tmp) / "x.fit", *steady_run(minutes=5)).read_bytes()
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr(f"{activity_id}_ACTIVITY.fit", fit_bytes)
        return buf.getvalue()


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "test.db")
    yield c
    c.close()


@pytest.fixture(autouse=True)
def no_pause(monkeypatch):
    monkeypatch.setattr(sync, "REQUEST_PAUSE_S", 0)


def days_ago(n: int) -> str:
    return (date.today() - timedelta(days=n)).isoformat()


def test_first_sync_pulls_full_history_and_vo2max(conn):
    client = FakeGarmin([make_activity(1, days_ago(30)), make_activity(2, days_ago(3))])
    result = sync.sync(client, conn, download_fit=False)

    assert client.activity_calls[0][0] == sync.EARLIEST.isoformat()
    assert result == {"activities": 2, "vo2max_readings": 2, "fit_files": 0, "analyzed": 0, "weather": 0}
    row = conn.execute("SELECT * FROM activities WHERE activity_id = 2").fetchone()
    assert row["activity_type"] == "running"
    assert row["distance_m"] == 5000.0
    assert conn.execute("SELECT value FROM vo2max WHERE sport = 'running' LIMIT 1").fetchone()[0] == 50.4


def test_later_sync_is_incremental_and_updates_edits(conn):
    client = FakeGarmin([make_activity(1, days_ago(10))])
    sync.sync(client, conn)

    client.activities = [make_activity(1, days_ago(10), activityName="Renamed"), make_activity(2, days_ago(1))]
    sync.sync(client, conn)

    assert client.activity_calls[1][0] == days_ago(10 + sync.OVERLAP_DAYS)
    assert conn.execute("SELECT count(*) FROM activities").fetchone()[0] == 2
    assert conn.execute("SELECT name FROM activities WHERE activity_id = 1").fetchone()[0] == "Renamed"


def test_fit_download_is_unzipped_parsed_and_analyzed_once(conn, tmp_path):
    client = FakeGarmin([make_activity(7, days_ago(1)), make_activity(8, days_ago(1), manualActivity=True)])
    result = sync.sync(client, conn, fit_dir=tmp_path)
    assert result["fit_files"] == 1  # the manual activity has no file to fetch
    assert (tmp_path / "7.fit").read_bytes()[8:12] == b".FIT"
    assert db.load_streams(conn, 7)[0]["hr"][0] is not None
    assert conn.execute("SELECT trimp FROM activity_metrics WHERE activity_id = 7").fetchone()[0] > 0
    # Already downloaded, so a second sync doesn't fetch it again.
    assert sync.sync(client, conn, fit_dir=tmp_path)["fit_files"] == 0


def test_vo2max_rows_handles_missing_sections():
    assert db.vo2max_rows(None) == []
    rows = db.vo2max_rows([
        {"generic": None, "cycling": {"calendarDate": "2026-01-02", "vo2MaxValue": 55}},
        {"generic": {"calendarDate": "2026-01-03"}},  # no value
    ])
    assert [(r["sport"], r["value"]) for r in rows] == [("cycling", 55)]


def test_dashboard_api(tmp_path):
    path = tmp_path / "web.db"
    with db.connect(path) as c:
        sync.sync(FakeGarmin([make_activity(1, days_ago(2))]), c, download_fit=False)
    client = create_app(path).test_client()

    assert client.get("/").status_code == 200
    acts = client.get("/api/activities").get_json()
    assert acts[0]["name"] == "Run 1" and "raw_json" not in acts[0]
    assert client.get("/api/vo2max").get_json()[0]["sport"] == "running"


def test_vo2max_only_for_run_days_and_resumes(conn):
    client = FakeGarmin([
        make_activity(1, days_ago(20)),
        make_activity(2, days_ago(15), activityType={"typeKey": "strength_training"}),
        make_activity(3, days_ago(10), activityType={"typeKey": "road_biking"}),
    ])
    sync.sync(client, conn, download_fit=False)
    assert client.metric_days == [days_ago(20)]  # no request for strength or ride days

    # Nothing new: the old days aren't asked for again.
    client.metric_days.clear()
    sync.sync(client, conn, download_fit=False)
    assert client.metric_days == []

    # An interrupted sync left a day unchecked: the next sync picks it up.
    conn.execute("DELETE FROM vo2max_checked WHERE date = ?", (days_ago(20),))
    conn.execute("DELETE FROM vo2max WHERE date = ?", (days_ago(20),))
    sync.sync(client, conn, download_fit=False)
    assert client.metric_days == [days_ago(20)]


class FakeGarminWithProfile(FakeGarmin):
    zones = [
        {"sport": "DEFAULT", "trainingMethod": "HR_MAX", "maxHeartRateUsed": 200, "restingHeartRateUsed": 55,
         "zone1Floor": 100, "zone2Floor": 120, "zone3Floor": 140, "zone4Floor": 160, "zone5Floor": 180},
        {"sport": "RUNNING", "trainingMethod": "HR_RESERVE", "maxHeartRateUsed": 192, "restingHeartRateUsed": 48,
         "lactateThresholdHeartRateUsed": None,
         "zone1Floor": 120, "zone2Floor": 135, "zone3Floor": 149, "zone4Floor": 164, "zone5Floor": 178},
    ]

    def connectapi(self, path, **kwargs):
        assert path == "/biometric-service/heartRateZones"
        return self.zones

    def get_user_profile(self):
        return {"userData": {"gender": "FEMALE", "lactateThresholdHeartRate": 171}}


def test_hr_settings_and_zones_come_from_garmin(conn):
    from garmin_connector import analysis, processing

    sync.sync(FakeGarminWithProfile([make_activity(1, days_ago(3))]), conn, download_fit=False)
    s = processing.effective_settings(conn)
    assert (s["max_hr"], s["resting_hr"], s["lthr"]) == (192, 48, 171)  # running zones win; LTHR from profile
    assert s["sources"] == {"max_hr": "garmin", "resting_hr": "garmin", "lthr": "garmin"}
    assert s["male"] is False

    # Default: threshold-based zones (COROS-style) around Garmin's threshold HR of 171.
    assert s["zone_system"] == "threshold" and s["zone_floors"] is None
    assert [z.high for z in analysis.zones_for(s)][:4] == [145, 154, 162, 171]

    # Option: Garmin's own zone boundaries, exactly as Garmin defines them.
    db.set_text_setting(conn, "zone_system", "garmin")
    s = processing.effective_settings(conn)
    assert s["zone_method"] == "HR_RESERVE"
    zones = analysis.zones_for(s)
    assert [(z.low, z.high) for z in zones] == [(0, 135), (135, 149), (149, 164), (164, 178), (178, 999)]

    # Setting your own max HR overrides Garmin's value and its zone boundaries.
    db.set_setting(conn, "max_hr", 200)
    s = processing.effective_settings(conn)
    assert s["sources"]["max_hr"] == "you" and s["zone_floors"] is None
    assert s["resting_hr"] == 48


def test_garmin_profile_errors_dont_stop_sync(conn):
    class Broken(FakeGarmin):
        def connectapi(self, path, **kwargs):
            raise RuntimeError("Garmin is down")

    result = sync.sync(Broken([make_activity(1, days_ago(3))]), conn, download_fit=False)
    assert result["activities"] == 1
    from garmin_connector import processing
    assert processing.effective_settings(conn)["sources"]["max_hr"] == "estimated"


def test_a_failed_profile_request_keeps_the_saved_zones(conn):
    from garmin_connector import processing

    sync.sync(FakeGarminWithProfile([make_activity(1, days_ago(3))]), conn, download_fit=False)
    db.set_text_setting(conn, "zone_system", "garmin")
    before = processing.effective_settings(conn)

    class Flaky(FakeGarminWithProfile):
        def connectapi(self, path, **kwargs):
            raise RuntimeError("Garmin hiccup")

    sync.sync(Flaky([make_activity(1, days_ago(3))]), conn, download_fit=False)
    after = processing.effective_settings(conn)
    assert after["zone_floors"] == before["zone_floors"] == [120, 135, 149, 164, 178]
    assert (after["max_hr"], after["resting_hr"]) == (192, 48)


def test_settings_reject_impossible_heart_rates(tmp_path):
    path = tmp_path / "s.db"
    db.connect(path).close()
    client = create_app(path).test_client()
    bad = [{"max_hr": "abc"}, {"max_hr": 400}, {"resting_hr": 5}, {"max_hr": 180, "lthr": 185}]
    for body in bad:
        res = client.post("/api/settings", json=body)
        assert res.status_code == 400 and res.get_json()["error"], body
    ok = client.post("/api/settings", json={"max_hr": 190, "lthr": 172, "resting_hr": None})
    assert ok.status_code == 200 and ok.get_json()["lthr"] == 172
    # clearing a value is always allowed
    assert client.post("/api/settings", json={"max_hr": None, "lthr": None}).status_code == 200
    # a threshold above the max HR from Garmin (not typed in) is caught too
    with closing(db.connect(path)) as c:
        db.set_garmin_profile(c, {"max_hr": 188})
    res = client.post("/api/settings", json={"lthr": 195})
    assert res.status_code == 400 and "188" in res.get_json()["error"]


def test_activities_deleted_in_garmin_are_removed(conn):
    client = FakeGarmin([make_activity(1, days_ago(5)), make_activity(2, days_ago(1)), make_activity(3, days_ago(1))])
    sync.sync(client, conn)
    conn.execute("INSERT INTO ai_reviews (key, created_at, text) VALUES ('activity:3:mi', 'now', 'x')")
    # run 3 was a duplicate, deleted in Garmin Connect; run 1 is older than the re-checked days
    client.activities = [make_activity(1, days_ago(5)), make_activity(2, days_ago(1))]
    sync.sync(client, conn)
    ids = [r[0] for r in conn.execute("SELECT activity_id FROM activities ORDER BY activity_id")]
    assert ids == [1, 2]
    for table in ("streams", "activity_metrics", "laps"):
        assert conn.execute(f"SELECT count(*) FROM {table} WHERE activity_id = 3").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM ai_reviews").fetchone()[0] == 0
    # an empty reply (a Garmin hiccup) never deletes anything
    client.activities = []
    sync.sync(client, conn)
    assert conn.execute("SELECT count(*) FROM activities").fetchone()[0] == 2


def test_dashboard_refuses_other_sites(tmp_path):
    """Websites can send requests to 127.0.0.1: a change from another site's page, or any request
    addressed through another name (DNS rebinding), is refused."""
    from garmin_connector.web import create_app
    client = create_app(tmp_path / "w.db").test_client()
    assert client.get("/api/settings").status_code == 200
    assert client.get("/api/settings", headers={"Host": "127.0.0.1:8765"}).status_code == 200
    assert client.get("/api/activities", headers={"Host": "evil.example:8765"}).status_code == 403
    # a form another site posts (plain text, so no CORS check stops it): refused
    hostile = {"Origin": "https://evil.example", "Content-Type": "text/plain"}
    assert client.post("/api/settings", data='{"max_hr": 230}', headers=hostile).status_code == 403
    assert client.post("/api/sync", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.post("/api/ai/review", data="{}", headers=hostile).status_code == 403
    # the dashboard's own page
    own = {"Origin": "http://localhost", "Sec-Fetch-Site": "same-origin"}
    assert client.post("/api/settings", json={"max_hr": 188}, headers=own).status_code == 200


def test_dashboard_and_sync_can_write_at_once(tmp_path):
    """A sync holding a write lock makes the dashboard wait its turn, not fail with "database is locked"."""
    import threading
    import time
    path = tmp_path / "both.db"
    db.connect(path).close()
    held = threading.Event()

    def sync_like():
        c = db.connect(path)
        c.execute("BEGIN IMMEDIATE")
        c.execute("INSERT INTO settings (key, value) VALUES ('a', 1)")
        held.set()
        time.sleep(6)  # longer than SQLite's default 5 s wait
        c.commit()
        c.close()
    t = threading.Thread(target=sync_like)
    t.start()
    held.wait()
    other = db.connect(path)
    assert other.execute("SELECT count(*) FROM activities").fetchone()[0] == 0  # reads go on meanwhile
    other.execute("INSERT INTO settings (key, value) VALUES ('b', 2)")  # waits for the commit
    other.commit()
    t.join()
    assert {r[0] for r in other.execute("SELECT key FROM settings")} >= {"a", "b"}
