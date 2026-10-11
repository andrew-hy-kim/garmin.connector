"""A small local dashboard: ``garmin dashboard`` then open http://127.0.0.1:8765."""

from __future__ import annotations

import logging
import threading
from contextlib import closing
from pathlib import Path

import anthropic
from flask import Flask, abort, jsonify, redirect, request, send_from_directory

from . import ai, api, auth, config, db, export, focus, gear, heatmap, insights, performance, processing, races, suggest, sync

log = logging.getLogger(__name__)
# Heart-rate values you can set on the dashboard: (key, label, lowest, highest)
STATIC = Path(__file__).parent / "static"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def create_app(db_path: Path | str | None = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    app.json.sort_keys = False  # keep records and best efforts in distance order
    db_path = db_path or config.db_path()
    sync_lock = threading.Lock()

    def conn():
        return closing(db.connect(db_path))

    @app.before_request
    def only_this_mac():
        """The dashboard answers only to itself. Any website you visit can send requests to
        127.0.0.1: a page addressed through another name (DNS rebinding, to read your runs and
        where you live) is refused, and so is a change (settings, sync, a paid Claude review)
        sent from another site's page."""
        host = (request.host or "").rsplit(":", 1)[0].strip("[]")
        if host not in LOCAL_HOSTS:
            abort(403)
        if request.method != "GET":
            origin = request.headers.get("Origin")
            if request.headers.get("Sec-Fetch-Site") == "cross-site" or (
                    origin and origin.rstrip("/") != f"{request.scheme}://{request.host}"):
                abort(403)

    export_lock = threading.Lock()

    def export_in_background():
        """Refresh the phone app's data file after a change, without making the page wait."""
        def run():
            with export_lock, conn() as c:
                export.write_quietly(c)
        threading.Thread(target=run, daemon=True).start()

    @app.get("/")
    def index():
        return send_from_directory(STATIC, "index.html")

    @app.get("/plan")
    def plan_page():  # the training plan was removed; old links land on Today
        return redirect("/")

    @app.get("/progress")
    def progress_page():
        return send_from_directory(STATIC, "progress.html")

    @app.get("/activities")
    def activities_page():
        return send_from_directory(STATIC, "activities.html")

    @app.get("/map")
    def map_page():
        return send_from_directory(STATIC, "map.html")

    @app.get("/activity/<int:activity_id>")
    def activity_page(activity_id):
        return send_from_directory(STATIC, "activity.html")

    @app.get("/static/<path:filename>")
    def static_file(filename):
        return send_from_directory(STATIC, filename)

    @app.get("/api/activities")
    def activities():
        with conn() as c:
            return jsonify(api.activities(c))

    @app.get("/api/activities/<int:activity_id>")
    def activity_detail(activity_id):
        with conn() as c:
            result = api.activity_detail(c, activity_id)
        if result is None:
            abort(404)
        return jsonify(result)

    @app.get("/api/vo2max")
    def vo2max():
        with conn() as c:
            return jsonify(api.vo2max(c))

    @app.get("/api/training-load")
    def training_load():
        with conn() as c:
            return jsonify(api.training_load(c))

    @app.get("/api/insights")
    def overview_insights():
        with conn() as c:
            return jsonify(insights.overview_insights(c))

    @app.get("/api/suggestions")
    def next_workouts():
        with conn() as c:
            return jsonify(suggest.suggest(c))

    @app.get("/api/gear")
    def gear_summary():
        with conn() as c:
            return jsonify(gear.summary(c))

    @app.get("/api/heatmap")
    def heatmap_tracks():
        with conn() as c:
            return jsonify(heatmap.tracks(c))

    @app.get("/api/focus")
    def focus_areas():
        with conn() as c:
            return jsonify(focus.areas(c, performance.summary(c)))

    @app.get("/api/performance")
    def performance_summary():
        with conn() as c:
            return jsonify(performance.summary(c))

    @app.get("/api/race-predictions")
    def race_predictions():
        with conn() as c:
            return jsonify(races.predictions(c))

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
                result = {"configured": True, "review": ai.review(c, scope, activity_id, units)}
            export_in_background()  # so the review also shows on the phone
            return jsonify(result)
        except ai.NotConfigured as err:
            return jsonify({"error": str(err)}), 400
        except anthropic.AuthenticationError:
            return jsonify({"error": "Anthropic rejected the API key. Set a new one with: garmin set-api-key"}), 400
        except anthropic.RateLimitError:
            return jsonify({"error": "Anthropic rate limit hit. Try again in a minute."}), 429
        except anthropic.APIConnectionError:
            return jsonify({"error": "Couldn't reach Anthropic. Check your internet connection."}), 502
        except (anthropic.APIStatusError, RuntimeError) as err:
            log.exception("AI review failed")
            return jsonify({"error": f"Review failed: {err}"}), 500

    @app.get("/api/records")
    def records():
        with conn() as c:
            return jsonify(api.records(c))

    @app.get("/api/settings")
    def get_settings():
        with conn() as c:
            return jsonify(api.settings_with_zones(c))

    @app.post("/api/settings")
    def save_settings():
        body = request.get_json(force=True) or {}
        values = {}
        for key, label, _, _ in processing.HR_LIMITS:
            if key in body:
                value = body[key]
                try:
                    values[key] = float(value) if value not in (None, "", 0) else None
                except (TypeError, ValueError):
                    return jsonify({"error": f"{label} must be a number."}), 400
        with conn() as c:
            error = processing.check_hr_settings(c, values)
            if error:
                return jsonify({"error": error}), 400
            if body.get("zone_system") in ("threshold", "garmin"):
                db.set_text_setting(c, "zone_system", body["zone_system"])
            for key, value in values.items():
                db.set_setting(c, key, value)
            processing.refresh(c)
            result = api.settings_with_zones(c)
        export_in_background()
        return jsonify(result)

    @app.post("/api/sync")
    def sync_now():
        if not sync_lock.acquire(blocking=False):
            return jsonify({"error": "A sync is already running."}), 409
        try:
            with conn() as c:
                result = sync.sync(auth.get_client(), c)
            export_in_background()
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
    scope = args.get("scope") if args.get("scope") == "activity" else "overview"
    activity_id = int(args["activity_id"]) if scope == "activity" else None
    units = "km" if args.get("units") == "km" else "mi"
    return scope, activity_id, units
