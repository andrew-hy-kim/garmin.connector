"""Adding a synthetic run (summary plus .fit streams) to a test database."""

from __future__ import annotations

from datetime import datetime, timezone

from fitgen import write_fit
from garmin_connector import db, processing


def _add(conn, tmp_path, activity_id, day, samples, laps):
    db.upsert_activities(conn, [{
        "activityId": activity_id, "activityName": f"Run {activity_id}", "startTimeLocal": f"{day} 07:00:00",
        "activityType": {"typeKey": "running"}, "distance": samples[-1]["distance"], "duration": len(samples),
    }])
    start = datetime.fromisoformat(f"{day}T14:00:00").replace(tzinfo=timezone.utc)
    processing.import_fit(conn, activity_id, write_fit(tmp_path / f"{activity_id}.fit", samples, laps, start=start))
