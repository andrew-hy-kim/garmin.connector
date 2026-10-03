"""Optional coach's review written by Claude.

Off until you add an Anthropic API key (``garmin-connector set-api-key``).
Only when you click "Ask Claude" does the dashboard send a summary of your
training (workout tags, distances, heart rate, load, coach notes; no GPS) to
the Anthropic API. Reviews are saved locally so you only pay once per review.
"""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import anthropic
import keyring

from . import insights, processing, races

MODEL = "claude-opus-5-5"
KEYCHAIN_SERVICE = "garmin-connector"
KEYCHAIN_USER = "anthropic-api-key"

SYSTEM_PROMPT = """You are an experienced running coach reviewing an athlete's own training data, exported \
from their Garmin watch and analyzed by their personal dashboard. The athlete is a runner; other \
activities are supplemental.

Write a short review the athlete will read in the dashboard:
- Start with a one- or two-sentence summary of the main takeaway.
- Then 3 to 5 specific observations, each tied to numbers in the data.
- End with concrete suggestions for the next 1 to 2 weeks (what to do, not just what to avoid).

Ground every claim in the data provided. If something can't be judged from the data (sleep, nutrition, \
how a session felt), say so rather than guessing. Heart-rate zones are relative to the athlete's \
threshold HR. Wrist-based heart rate can be noisy on short, fast reps. Don't give medical diagnoses; if \
something looks like a health concern, suggest seeing a professional.

Format with Markdown: short paragraphs, "###" headings, and bullet lists. Keep it under about 350 words. \
Express paces in the units given."""


class NotConfigured(Exception):
    """No Anthropic API key available."""


def set_api_key(key: str) -> None:
    keyring.set_password(KEYCHAIN_SERVICE, KEYCHAIN_USER, key.strip())


def remove_api_key() -> None:
    try:
        keyring.delete_password(KEYCHAIN_SERVICE, KEYCHAIN_USER)
    except keyring.errors.PasswordDeleteError:
        pass


def _keychain_key() -> str | None:
    try:
        return keyring.get_password(KEYCHAIN_SERVICE, KEYCHAIN_USER)
    except keyring.errors.KeyringError:
        return None


def is_configured() -> bool:
    """A key in the Keychain, ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile."""
    return bool(
        _keychain_key()
        or os.environ.get("ANTHROPIC_API_KEY")
        or os.environ.get("ANTHROPIC_AUTH_TOKEN")
        or (Path.home() / ".config" / "anthropic").is_dir()
    )


def _client() -> anthropic.Anthropic:
    if not is_configured():
        raise NotConfigured("No Anthropic API key set. Run: garmin-connector set-api-key")
    key = _keychain_key()
    return anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()


# ---------------------------------------------------------------- context

def _pace(mps: float | None, units: str) -> str | None:
    if not mps or mps < 0.5:
        return None
    meters = 1609.344 if units == "mi" else 1000
    s = round(meters / mps)
    return f"{s // 60}:{s % 60:02d}/{units}"


def _run_line(row: sqlite3.Row, m: dict[str, Any], units: str) -> dict[str, Any]:
    workout = m.get("workout") or {}
    dist = (row["distance_m"] or 0) / (1609.344 if units == "mi" else 1000)
    return {
        "date": row["start_time_local"][:10],
        "type": row["activity_type"],
        "tag": workout.get("label"),
        "tag_reason": workout.get("reason"),
        "distance": f"{dist:.2f} {units}",
        "minutes": round((row["duration_s"] or 0) / 60),
        "avg_pace": _pace(row["avg_speed_mps"], units),
        "avg_hr": round(row["avg_hr"]) if row["avg_hr"] else None,
        "training_load": round(m["trimp"]) if m.get("trimp") else None,
        "hr_drift_pct": m.get("decoupling_pct"),
        "hr_sensor": "arm band/strap" if m.get("external_hr") else "wrist",
    }


def _overview_context(conn: sqlite3.Connection, units: str) -> dict[str, Any]:
    settings = processing.effective_settings(conn)
    load = processing.training_load_series(conn)
    since = (date.today() - timedelta(days=56)).isoformat()
    rows = conn.execute(
        "SELECT a.*, m.data FROM activities a LEFT JOIN activity_metrics m USING (activity_id) "
        "WHERE a.start_time_local >= ? ORDER BY a.start_time_local", (since,)
    ).fetchall()
    recent = [_run_line(r, json.loads(r["data"]) if r["data"] else {}, units) for r in rows]
    weekly = [{"week_ending": d["date"], "fitness": d["fitness"], "fatigue": d["fatigue"], "form": d["form"]}
              for d in load[-56::7]]
    vo2 = conn.execute("SELECT date, value FROM vo2max WHERE sport = 'running' AND date >= ? ORDER BY date",
                       (since,)).fetchall()
    return {
        "today": date.today().isoformat(),
        "units": units,
        "heart_rate_settings": {k: settings[k] for k in ("max_hr", "resting_hr", "lthr")},
        "training_load_explained": "Fitness = 42-day average daily load (TRIMP); fatigue = 7-day; form = fitness - fatigue.",
        "training_load_now": load[-1] if load else None,
        "form_state": insights.form_state(load[-1]["fitness"], load[-1]["form"]) if load else None,
        "training_load_weekly": weekly,
        "activities_last_8_weeks": recent,
        "vo2max_running": [{"date": d, "value": v} for d, v in vo2],
        "dashboard_coach_notes": insights.overview_insights(conn),
        "race_predictions_seconds": [{k: r[k] for k in ("race", "seconds", "garmin_seconds")}
                                     for r in races.predictions(conn)["races"]],
    }


def _workout_context(conn: sqlite3.Connection, activity_id: int, units: str) -> dict[str, Any]:
    row = conn.execute(
        "SELECT a.*, m.data FROM activities a LEFT JOIN activity_metrics m USING (activity_id) "
        "WHERE activity_id = ?", (activity_id,)
    ).fetchone()
    m = json.loads(row["data"]) if row["data"] else {}
    laps = conn.execute(
        "SELECT idx, intensity, timer_s, distance_m, avg_speed, avg_hr, max_hr, avg_cadence FROM laps "
        "WHERE activity_id = ? ORDER BY idx", (activity_id,)
    ).fetchall()
    meters = 1609.344 if units == "mi" else 1000
    context = _overview_context(conn, units)
    context.pop("dashboard_coach_notes")
    return {
        "workout": {
            **_run_line(row, m, units),
            "name": row["name"],
            "elevation_gain_m": row["elevation_gain_m"],
            "max_hr": row["max_hr"],
            "minutes_by_intensity": dict(zip(
                ["easy (<90% LTHR)", "tempo (90-95%)", "threshold (95-100%)", "vo2max (>=100%)"],
                [round(s / 60, 1) for s in m.get("intensity_seconds") or []])),
            "efficiency_m_per_heartbeat": m.get("efficiency"),
            "pacing": {
                "first_half_pace": _pace((m.get("pacing") or {}).get("speed_halves", [None])[0], units),
                "second_half_pace": _pace(((m.get("pacing") or {}).get("speed_halves") or [None, None])[1], units),
                "hr_halves": (m.get("pacing") or {}).get("hr_halves"),
                "cadence_early_late": (m.get("pacing") or {}).get("cadence_thirds"),
            },
            "reps": [{"seconds": round(r["seconds"]), "distance": f"{(r['meters'] or 0) / meters:.2f} {units}",
                      "pace": _pace(r["meters"] / r["seconds"] if r.get("meters") and r["seconds"] else None, units),
                      "avg_hr_second_half": round(r["avg_hr"]) if r.get("avg_hr") else None,
                      "peak_hr": round(r["peak_hr"]) if r.get("peak_hr") else None}
                     for r in m.get("reps") or []],
            "laps": [{"lap": l["idx"], "type": l["intensity"], "seconds": round(l["timer_s"] or 0),
                      "pace": _pace(l["avg_speed"], units), "avg_hr": l["avg_hr"], "max_hr": l["max_hr"],
                      "cadence": l["avg_cadence"]} for l in laps][:40],
            "best_efforts_seconds": {k: v["seconds"] for k, v in (m.get("best_efforts") or {}).items()},
            "dashboard_coach_notes": insights.workout_insights(conn, activity_id),
        },
        "recent_training": context,
    }


# ---------------------------------------------------------------- review

def _cache_key(scope: str, activity_id: int | None, units: str) -> str:
    return f"{scope}:{activity_id or ''}:{units}"


def cached_review(conn: sqlite3.Connection, scope: str, activity_id: int | None, units: str) -> dict | None:
    row = conn.execute("SELECT created_at, text FROM ai_reviews WHERE key = ?",
                       (_cache_key(scope, activity_id, units),)).fetchone()
    return {"created_at": row[0], "text": row[1]} if row else None


def review(conn: sqlite3.Connection, scope: str, activity_id: int | None = None, units: str = "mi") -> dict:
    """Ask Claude for a review of one workout (scope "activity") or recent training ("overview")."""
    if scope == "activity":
        context, ask = _workout_context(conn, activity_id, units), "Review this workout in the context of my recent training."
    elif scope == "plan":
        from . import planner

        plan = planner.load(conn)
        if not plan:
            raise RuntimeError("There's no training plan to review yet.")
        context = {"plan": plan, "progress_so_far": planner.progress(conn, plan),
                   "recent_training": _overview_context(conn, units)}
        ask = ("Here's my training plan, generated by my dashboard's rules from my recent training. Review it "
               "for my goal and situation: is it appropriate, what would you change, and what should I watch "
               "for? Speeds in the plan are in meters per second.")
    else:
        context, ask = _overview_context(conn, units), "Review my recent training and tell me what to focus on next."

    response = _client().beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        output_config={"effort": "medium"},
        # If the model declines, the API retries on a fallback model automatically.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": f"{ask}\n\n<training_data>\n{json.dumps(context, default=str)}\n</training_data>"}],
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("Claude declined to review this data.")
    text = "".join(block.text for block in response.content if block.type == "text").strip()
    if not text:
        raise RuntimeError("Claude returned an empty review.")
    conn.execute("INSERT OR REPLACE INTO ai_reviews (key, created_at, text) VALUES (?, datetime('now'), ?)",
                 (_cache_key(scope, activity_id, units), text))
    conn.commit()
    return cached_review(conn, scope, activity_id, units)
