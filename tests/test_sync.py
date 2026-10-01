"""Tests run against a fake Garmin client, so they never touch a real account."""

from __future__ import annotations

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
    assert result == {"activities": 2, "vo2max_readings": 2, "fit_files": 0, "analyzed": 0}
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


def test_vo2max_only_for_run_and_ride_days_and_resumes(conn):
    client = FakeGarmin([
        make_activity(1, days_ago(20)),
        make_activity(2, days_ago(15), activityType={"typeKey": "strength_training"}),
        make_activity(3, days_ago(10), activityType={"typeKey": "road_biking"}),
    ])
    sync.sync(client, conn, download_fit=False)
    assert client.metric_days == [days_ago(20), days_ago(10)]  # no strength-day request

    # Nothing new: the old days aren't asked for again.
    client.metric_days.clear()
    sync.sync(client, conn, download_fit=False)
    assert client.metric_days == []

    # An interrupted sync left a day unchecked: the next sync picks it up.
    conn.execute("DELETE FROM vo2max_checked WHERE date = ?", (days_ago(20),))
    sync.sync(client, conn, download_fit=False)
    assert client.metric_days == [days_ago(20)]
