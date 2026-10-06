from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from fitgen import intervals, steady_run, write_fit
from garmin_connector import db, processing, sessions


def _add(conn, tmp_path, activity_id, day, samples, laps):
    db.upsert_activities(conn, [{
        "activityId": activity_id, "activityName": f"Run {activity_id}", "startTimeLocal": f"{day} 07:00:00",
        "activityType": {"typeKey": "running"}, "distance": samples[-1]["distance"], "duration": len(samples),
    }])
    start = datetime.fromisoformat(f"{day}T14:00:00").replace(tzinfo=timezone.utc)
    processing.import_fit(conn, activity_id, write_fit(tmp_path / f"{activity_id}.fit", samples, laps, start=start))


@pytest.fixture(scope="module")
def conn(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("sessions")
    conn = db.connect(tmp / "p.db")
    db.set_setting(conn, "lthr", 170)
    db.set_setting(conn, "max_hr", 190)
    db.set_setting(conn, "resting_hr", 55)
    today = date.today()
    for n in range(14):  # earlier training, so fitness isn't starting from zero
        _add(conn, tmp, 400 + n, (today - timedelta(days=26 + n * 3)).isoformat(), *steady_run(minutes=40, start_hr=135))
    for n in range(12):  # ~4 runs a week for 3 weeks, ~45 min each, plus an interval session
        d = (today - timedelta(days=1 + n * 2)).isoformat()
        if n == 3:
            _add(conn, tmp, 500 + n, d, *intervals(reps=5, rep_s=180))
        else:
            _add(conn, tmp, 500 + n, d, *steady_run(minutes=45, start_hr=135))
    processing.refresh(conn)
    yield conn
    conn.close()


def test_context_reads_recent_training(conn):
    ctx = sessions.context(conn)
    assert 120 <= ctx["last7_minutes"] <= 200
    assert ctx["runs_per_week_4wk"] >= 3
    assert ctx["lthr"] == 170 and ctx["comeback"] is None
    assert ctx["paces"]["vo2_mps"] > ctx["paces"]["threshold_mps"] > ctx["paces"]["tempo_mps"]
