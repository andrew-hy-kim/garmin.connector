"""A small local dashboard: ``garmin-connector dashboard`` then open http://127.0.0.1:8765."""

from __future__ import annotations

import json
import logging
import threading
from contextlib import closing
from dataclasses import asdict
from pathlib import Path

import anthropic
from flask import Flask, abort, jsonify, request, send_from_directory

from . import ai, analysis, auth, config, db, insights, planner, processing, sync

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

    @app.get("/plan")
    def plan_page():
        return send_from_directory(STATIC, "plan.html")

    def plan_response(c):
        plan = planner.load(c)
        ctx = planner.context(c)
        return {
            "plan": plan,
            "progress": planner.progress(c, plan) if plan else None,
            "goals": {k: {"label": v["label"], "blurb": v["blurb"]} for k, v in planner.GOALS.items()},
            "defaults": {"runs_per_week": max(3, min(6, round(ctx["runs_per_week_4wk"]) or 3)), "long_day": "Sun",
                         "weeks": 6, "goal": "return" if ctx["comeback"] else "base"},
            "context": ctx,
        }

    @app.get("/api/plan")
    def get_plan():
        with conn() as c:
            return jsonify(plan_response(c))

    @app.post("/api/plan")
    def make_plan():
        body = request.get_json(force=True) or {}
        goal = body.get("goal")
        if goal not in planner.GOALS:
            return jsonify({"error": "Pick a goal."}), 400
        with conn() as c:
            plan = planner.generate(c, goal, weeks=int(body.get("weeks") or 6),
                                    runs_per_week=int(body.get("runs_per_week") or 0) or None,
                                    long_day="Sat" if body.get("long_day") == "Sat" else "Sun")
            planner.save(c, plan)
            return jsonify(plan_response(c))

    @app.delete("/api/plan")
    def delete_plan():
        with conn() as c:
            planner.delete(c)
            return jsonify(plan_response(c))

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
                "json_extract(m.data, '$.workout.type') AS workout_type, "
                "json_extract(m.data, '$.workout.label') AS workout_label, "
                "json_extract(m.data, '$.intensity_seconds') AS intensity_seconds, "
                "s.activity_id IS NOT NULL AS has_streams "
                "FROM activities a LEFT JOIN activity_metrics m USING (activity_id) "
                "LEFT JOIN streams s USING (activity_id) ORDER BY a.start_time_local DESC"
            ).fetchall()
        out = []
        for r in rows:
            row = dict(r)
            row["intensity_seconds"] = json.loads(row["intensity_seconds"]) if row["intensity_seconds"] else None
            out.append(row)
        return jsonify(out)

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
            "zones": [asdict(z) for z in analysis.zones_for(settings)],
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
        with conn() as c:
            result["insights"] = insights.workout_insights(c, activity_id)
        return jsonify(result)

    @app.get("/api/vo2max")
    def vo2max():
        with conn() as c:
            rows = c.execute("SELECT date, sport, value FROM vo2max ORDER BY date").fetchall()
        return jsonify([dict(r) for r in rows])

    @app.get("/api/training-load")
    def training_load():
        with conn() as c:
            series = processing.training_load_series(c)
        if series:
            series[-1]["state"] = insights.form_state(series[-1]["fitness"], series[-1]["form"])
        return jsonify(series)

    @app.get("/api/insights")
    def overview_insights():
        with conn() as c:
            return jsonify(insights.overview_insights(c))

    @app.get("/api/ai/review")
    def get_ai_review():
        scope, activity_id, units = _review_args(request.args)
        with conn() as c:
            return jsonify({"configured": ai.is_configured(),
                            "review": ai.cached_review(c, scope, activity_id, units)})

    @app.post("/api/ai/review")
    def make_ai_review():
        scope, activity_id, units = _review_args(request.get_json(force=True) or {})
        try:
            with conn() as c:
                return jsonify({"configured": True, "review": ai.review(c, scope, activity_id, units)})
        except ai.NotConfigured as err:
            return jsonify({"error": str(err)}), 400
        except anthropic.AuthenticationError:
            return jsonify({"error": "Anthropic rejected the API key. Set a new one with: garmin-connector set-api-key"}), 400
        except anthropic.RateLimitError:
            return jsonify({"error": "Anthropic rate limit hit. Try again in a minute."}), 429
        except anthropic.APIConnectionError:
            return jsonify({"error": "Couldn't reach Anthropic. Check your internet connection."}), 502
        except (anthropic.APIStatusError, RuntimeError) as err:
            log.exception("AI review failed")
            return jsonify({"error": f"Review failed: {err}"}), 500

    @app.get("/api/records")
    def records():
        """Your times at each standard distance, from every run, fastest first."""
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
        # Every effort, fastest first, so the dashboard can also show the best within a date range.
        return jsonify({
            label: sorted(efforts, key=lambda e: e["seconds"])
            for label, efforts in by_distance.items() if efforts
        })

    def settings_with_zones(c):
        settings = processing.effective_settings(c)
        settings["zones"] = [asdict(z) for z in analysis.zones_for(settings)]
        return settings

    @app.get("/api/settings")
    def get_settings():
        with conn() as c:
            return jsonify(settings_with_zones(c))

    @app.post("/api/settings")
    def save_settings():
        body = request.get_json(force=True) or {}
        with conn() as c:
            if body.get("zone_system") in ("threshold", "garmin"):
                db.set_text_setting(c, "zone_system", body["zone_system"])
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


def _review_args(args) -> tuple[str, int | None, str]:
    scope = args.get("scope") if args.get("scope") in ("activity", "plan") else "overview"
    activity_id = int(args["activity_id"]) if scope == "activity" else None
    units = "km" if args.get("units") == "km" else "mi"
    return scope, activity_id, units
