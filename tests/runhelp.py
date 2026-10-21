"""Adding a synthetic run (summary plus .fit streams) to a test database."""

from __future__ import annotations

from fitgen import write_fit
from garmin_connector import db, processing


def _add(conn, tmp_path, activity_id, day, samples, laps):
    db.upsert_activities(conn, [{
        "activityId": activity_id, "activityName": f"Run {activity_id}", "startTimeLocal": f"{day} 07:00:00",
        "activityType": {"typeKey": "running"}, "distance": samples[-1]["distance"], "duration": len(samples),
    }])
    # The file's own start time isn't read back (the date comes from the summary above), so every
    # run is stamped the same and identical runs are written once (fitgen caches them).
    processing.import_fit(conn, activity_id, write_fit(tmp_path / f"{activity_id}.fit", samples, laps))
