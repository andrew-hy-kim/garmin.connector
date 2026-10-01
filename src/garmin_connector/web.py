"""A small local dashboard: ``garmin-connector dashboard`` then open http://127.0.0.1:8765."""

from __future__ import annotations

import logging
import threading
from contextlib import closing
from pathlib import Path

from flask import Flask, jsonify, send_from_directory

from . import auth, config, db, sync

log = logging.getLogger(__name__)
STATIC = Path(__file__).parent / "static"


def create_app(db_path: Path | str | None = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    db_path = db_path or config.db_path()
    sync_lock = threading.Lock()

    def conn():
        return closing(db.connect(db_path))

    @app.get("/")
    def index():
        return send_from_directory(STATIC, "index.html")

    @app.get("/static/<path:filename>")
    def static_file(filename):
        return send_from_directory(STATIC, filename)

    @app.get("/api/activities")
    def activities():
        with conn() as c:
            rows = c.execute(
                "SELECT activity_id, name, activity_type, start_time_local, distance_m, duration_s, "
                "moving_duration_s, elevation_gain_m, avg_hr, max_hr, avg_speed_mps, calories, "
                "avg_power_w, aerobic_te, anaerobic_te, vo2max, location "
                "FROM activities ORDER BY start_time_local DESC"
            ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.get("/api/vo2max")
    def vo2max():
        with conn() as c:
            rows = c.execute("SELECT date, sport, value FROM vo2max ORDER BY date").fetchall()
        return jsonify([dict(r) for r in rows])

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
