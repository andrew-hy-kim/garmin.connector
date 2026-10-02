from __future__ import annotations

import gzip
import json
from datetime import date, datetime, timedelta, timezone

import pytest

from fitgen import intervals, steady_run, write_fit
from garmin_connector import api, db, export, planner, processing


@pytest.fixture(scope="module")
def conn(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("export")
    conn = db.connect(tmp / "e.db")
    for k, v in (("lthr", 170), ("max_hr", 190)):
        db.set_setting(conn, k, v)
    today = date.today()
    for n in range(6):
        day = (today - timedelta(days=1 + n * 3)).isoformat()
        samples, laps = intervals(reps=5, rep_s=180) if n == 2 else steady_run(minutes=40, start_hr=138)
        db.upsert_activities(conn, [{
            "activityId": 900 + n, "activityName": f"Run {n}", "startTimeLocal": f"{day} 07:00:00",
            "activityType": {"typeKey": "running"}, "distance": samples[-1]["distance"], "duration": len(samples),
        }])
        start = datetime.fromisoformat(f"{day}T14:00:00").replace(tzinfo=timezone.utc)
        processing.import_fit(conn, 900 + n, write_fit(tmp / f"{n}.fit", samples, laps, start=start))
    db.upsert_activities(conn, [{"activityId": 999, "activityName": "Manual ride", "startTimeLocal": f"{today} 09:00:00",
                                 "activityType": {"typeKey": "cycling"}, "duration": 3600, "manualActivity": True}])
    processing.refresh(conn)
    planner.save(conn, planner.generate(conn, "base", weeks=4, runs_per_week=4))
    conn.execute("INSERT INTO ai_reviews (key, created_at, text) VALUES ('overview::mi', '2026-10-01 20:00:00', 'Nice.')")
    conn.commit()
    yield conn
    conn.close()


def test_downsample_buckets_by_time():
    streams = {"t": [0, 1, 2, 3, 4, 5, 6, 30, 31], "hr": [100, 110, None, 120, 130, 140, 150, 90, 92],
               "distance": [0, 3, 6, 9, 12, 15, 18, 20, 23], "lat": [47.1234567] * 9, "lon": [-122.1] * 9,
               "speed": [3.0] * 9, "altitude": [10.04] * 9, "cadence": [None] * 9}
    small = export.downsample(streams, step=5)
    assert small["t"] == [4, 6, 31]              # buckets 0-4, 5-6, then after a pause 30-31
    assert small["hr"] == [115, 145, 91]         # means, ignoring gaps
    assert small["distance"] == [12, 18, 23]     # last value
    assert small["lat"][0] == 47.12346           # first value, 5 decimals
    assert small["cadence"] == [None, None, None]


def test_snapshot_matches_the_dashboard(conn):
    snap = export.snapshot(conn)
    assert snap["format"] == "garmin-dashboard" and snap["version"] == export.FORMAT_VERSION
    ov = snap["overview"]
    assert ov["activities"] == json.loads(json.dumps(api.activities(conn)))
    assert ov["records"] == json.loads(json.dumps(api.records(conn)))
    assert ov["plan"]["plan"]["goal"] == "base" and len(ov["plan"]["progress"]) == 4
    assert ov["settings"]["lthr"] == 170 and len(ov["settings"]["zones"]) == 5
    assert ov["training_load"][-1]["state"]["key"]
    assert ov["ai_reviews"]["overview::mi"]["text"] == "Nice."

    assert set(snap["details"]) == {str(a["activity_id"]) for a in ov["activities"]}
    run = snap["details"]["900"]
    full = api.activity_detail(conn, 900)
    assert run["metrics"] == json.loads(json.dumps(full["metrics"]))
    assert run["insights"] == full["insights"] and run["laps"] == full["laps"]
    assert run["sample_step_s"] == 5
    n_full, n_small = len(full["streams"]["t"]), len(run["streams"]["t"])
    assert n_small == pytest.approx(n_full / 5, abs=2)
    assert set(run["streams"]) == set(full["streams"])
    assert snap["details"]["999"]["streams"] is None  # manual activity: summary only


def test_write_is_gzip_json_and_cached(conn, tmp_path):
    path = export.write(conn, tmp_path)
    assert path.name == "garmin-dashboard.data"
    raw = path.read_bytes()
    assert raw[:2] == b"\x1f\x8b"
    data = json.loads(gzip.decompress(raw))
    assert len(data["details"]) == 7
    assert not (tmp_path / "garmin-dashboard.data.tmp").exists()
    # streams are cached, so a second export gives the same workout data
    keys = {r[0] for r in conn.execute("SELECT key FROM export_streams")}
    assert keys == {export.CACHE_KEY}
    again = json.loads(gzip.decompress(export.write(conn, tmp_path).read_bytes()))
    assert again["details"]["901"]["streams"] == data["details"]["901"]["streams"]


def test_default_folder(monkeypatch, tmp_path):
    monkeypatch.setenv("GARMIN_CONNECTOR_EXPORT", str(tmp_path / "x"))
    assert export.default_dir() == tmp_path / "x"
    monkeypatch.delenv("GARMIN_CONNECTOR_EXPORT")
    monkeypatch.setattr(export, "icloud_drive", lambda: tmp_path)
    assert export.default_dir() == tmp_path / "Garmin Dashboard"
    monkeypatch.setattr(export, "icloud_drive", lambda: tmp_path / "missing")
    assert export.default_dir().name == "export"


def test_cli_export(conn, tmp_path, capsys):
    from garmin_connector import cli, config

    path = conn.execute("PRAGMA database_list").fetchone()[2]
    import shutil
    shutil.copy(path, config.db_path())
    cli.main(["export", "--to", str(tmp_path / "out")])
    assert (tmp_path / "out" / "garmin-dashboard.data").exists()
    assert "Import it in the phone app" in capsys.readouterr().out
