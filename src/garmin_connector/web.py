"""A small local dashboard: ``garmin-connector dashboard`` then open http://127.0.0.1:8765."""

from __future__ import annotations

import json
import logging
import threading
from contextlib import closing
from dataclasses import asdict
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory

from . import analysis, auth, config, db, processing, sync

log = logging.getLogger(__name__)
STATIC = Path(__file__).parent / "static"


def create_app(db_path: Path | str | None = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    app.json.sort_keys = False  # keep records and best efforts in distance order
    db_path = db_path or config.db_path()
    sync_lock = threading.Lock()

    def conn():
        return closing(db.connect(db_path))

    @app.get("/")
    def index():
        return send_from_directory(STATIC, "index.html")

    @app.get("/activity/<int:activity_id>")
    def activity_page(activity_id):
        return send_from_directory(STATIC, "activity.html")

    @app.get("/static/<path:filename>")
    def static_file(filename):
        return send_from_directory(STATIC, filename)

    @app.get("/api/activities")
    def activities():
        with conn() as c:
            rows = c.execute(
                "SELECT a.activity_id, a.name, a.activity_type, a.start_time_local, a.distance_m, a.duration_s, "
                "a.moving_duration_s, a.elevation_gain_m, a.avg_hr, a.max_hr, a.avg_speed_mps, a.calories, "
                "a.avg_power_w, a.aerobic_te, a.anaerobic_te, a.vo2max, a.location, "
                "m.trimp, m.decoupling_pct, m.efficiency, m.cadence_lock, s.external_hr, "
                "s.activity_id IS NOT NULL AS has_streams "
                "FROM activities a LEFT JOIN activity_metrics m USING (activity_id) "
                "LEFT JOIN streams s USING (activity_id) ORDER BY a.start_time_local DESC"
            ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.get("/api/activities/<int:activity_id>")
    def activity_detail(activity_id):
        with conn() as c:
            row = c.execute(
                "SELECT activity_id, name, activity_type, start_time_local, distance_m, duration_s, "
                "moving_duration_s, elevation_gain_m, avg_hr, max_hr, avg_speed_mps, calories, aerobic_te, "
                "anaerobic_te, vo2max, location FROM activities WHERE activity_id = ?",
                (activity_id,),
            ).fetchone()
            if row is None:
                abort(404)
            settings = processing.effective_settings(c)
            loaded = db.load_streams(c, activity_id)
            metrics_row = c.execute(
                "SELECT data FROM activity_metrics WHERE activity_id = ?", (activity_id,)
            ).fetchone()
            laps = [dict(r) for r in c.execute(
                "SELECT idx, start_t, elapsed_s, timer_s, distance_m, avg_hr, max_hr, avg_speed, avg_cadence, "
                "intensity, lap_trigger FROM laps WHERE activity_id = ? ORDER BY idx", (activity_id,)
            )]

        result = {
            "activity": dict(row),
            "laps": laps,
            "metrics": json.loads(metrics_row[0]) if metrics_row else None,
            "zones": [asdict(z) for z in analysis.hr_zones(settings["max_hr"], settings.get("lthr"))],
            "settings": settings,
            "streams": None,
            "external_hr": None,
        }
        if loaded:
            streams, external_hr = loaded
            hr = streams["hr"] if external_hr else analysis.clean_hr(streams["hr"])
            grade = analysis.grades(streams["distance"], streams["altitude"])
            result["streams"] = {
                **streams,
                "hr": hr,
                "grade": [round(g, 3) if g is not None else None for g in grade],
                "gap": [round(v, 3) if v is not None else None
                        for v in analysis.grade_adjusted_speed(streams["speed"], grade)],
            }
            result["external_hr"] = external_hr
        return jsonify(result)

    @app.get("/api/vo2max")
    def vo2max():
        with conn() as c:
            rows = c.execute("SELECT date, sport, value FROM vo2max ORDER BY date").fetchall()
        return jsonify([dict(r) for r in rows])

    @app.get("/api/training-load")
    def training_load():
        with conn() as c:
            return jsonify(processing.training_load_series(c))

    @app.get("/api/records")
    def records():
        """Your five fastest times at each standard distance, from any run."""
        with conn() as c:
            rows = c.execute(
                "SELECT a.activity_id, a.name, a.start_time_local, m.data FROM activity_metrics m "
                "JOIN activities a USING (activity_id)"
            ).fetchall()
        by_distance: dict[str, list] = {label: [] for label in analysis.BEST_EFFORT_DISTANCES}
        for r in rows:
            for label, effort in json.loads(r["data"]).get("best_efforts", {}).items():
                by_distance.setdefault(label, []).append({
                    "activity_id": r["activity_id"], "name": r["name"],
                    "date": r["start_time_local"][:10], **effort,
                })
        return jsonify({
            label: sorted(efforts, key=lambda e: e["seconds"])[:5]
            for label, efforts in by_distance.items() if efforts
        })

    def settings_with_zones(c):
        settings = processing.effective_settings(c)
        settings["zones"] = [asdict(z) for z in analysis.hr_zones(settings["max_hr"], settings.get("lthr"))]
        return settings

    @app.get("/api/settings")
    def get_settings():
        with conn() as c:
            return jsonify(settings_with_zones(c))

    @app.post("/api/settings")
    def save_settings():
        body = request.get_json(force=True) or {}
        with conn() as c:
            for key in ("max_hr", "resting_hr", "lthr"):
                if key in body:
                    value = body[key]
                    db.set_setting(c, key, float(value) if value not in (None, "", 0) else None)
            processing.refresh(c)
            return jsonify(settings_with_zones(c))

    @app.post("/api/sync")
    def sync_now():
        if not sync_lock.acquire(blocking=False):
            return jsonify({"error": "A sync is already running."}), 409
        try:
            with conn() as c:
                result = sync.sync(auth.get_client(), c)
            return jsonify(result)
        except SystemExit as err:  # e.g. "Not logged in yet"
            return jsonify({"error": str(err)}), 400
        except Exception as err:
            log.exception("Sync failed")
            return jsonify({"error": f"Sync failed: {err}"}), 500
        finally:
            sync_lock.release()

    return app
