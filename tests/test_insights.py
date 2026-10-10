from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from fitgen import intervals, steady_run, write_fit
from garmin_connector import ai, db, insights, processing


def _add_run(conn, tmp_path, activity_id, day, samples, laps, **extra):
    db.upsert_activities(conn, [{
        "activityId": activity_id, "activityName": f"Run {activity_id}", "startTimeLocal": f"{day} 07:00:00",
        "activityType": {"typeKey": "running"}, "distance": samples[-1]["distance"], "duration": len(samples),
        "averageHR": sum(s["hr"] for s in samples) / len(samples), "averageSpeed": samples[-1]["distance"] / len(samples),
        **extra,
    }])
    start = datetime.fromisoformat(f"{day}T14:00:00").replace(tzinfo=timezone.utc)
    processing.import_fit(conn, activity_id, write_fit(tmp_path / f"{activity_id}.fit", samples, laps, start=start))


@pytest.fixture(scope="module")
def conn(tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("insights")
    conn = db.connect(tmp_path / "i.db")
    db.set_setting(conn, "lthr", 170)
    db.set_setting(conn, "max_hr", 190)
    today = date.today()
    for n in range(6):  # easy runs over the last few weeks
        day = (today - timedelta(days=3 + n * 3)).isoformat()
        _add_run(conn, tmp_path, 100 + n, day, *steady_run(minutes=45, start_hr=135, drift_bpm=4))
    _add_run(conn, tmp_path, 200, (today - timedelta(days=1)).isoformat(), *intervals(reps=6, rep_s=180))
    _add_run(conn, tmp_path, 300, today.isoformat(), *steady_run(minutes=45, start_hr=150, drift_bpm=6))
    processing.refresh(conn)
    yield conn
    conn.close()


def test_workout_insights(conn):
    notes = insights.workout_insights(conn, 200)
    titles = [n["title"] for n in notes]
    assert titles[0] == "Tagged: VO2 max intervals"
    assert "Even reps" in titles

    easy_notes = {n["title"]: n for n in insights.workout_insights(conn, 105)}
    assert "Tagged: Easy run" in easy_notes and "Kept it easy" in easy_notes

    # 45 min at ~90% of threshold, harder than the athlete's usual easy runs
    hard_notes = [n["title"] for n in insights.workout_insights(conn, 300)]
    assert any(t.startswith("Tagged: Tempo") for t in hard_notes)


def test_overview_insights_and_form_state(conn):
    titles = [n["title"] for n in insights.overview_insights(conn)]
    # under six weeks of history: base and fatigue (42- and 7-day averages) don't mean anything yet
    assert not any(t.startswith("Form: ") for t in titles)
    assert any("easy" in t for t in titles)  # intensity distribution note
    assert insights.form_state(100, 15)["key"] == "fresh"
    assert insights.form_state(100, 0)["key"] == "neutral"
    assert insights.form_state(100, -20)["key"] == "productive"
    assert insights.form_state(100, -40)["key"] == "overreaching"


def test_ai_review_request_and_cache(conn, monkeypatch):
    calls = []

    class FakeMessages:
        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(stop_reason="end_turn",
                                   content=[SimpleNamespace(type="text", text="### Summary\nNice work.")])

    monkeypatch.setattr(ai, "_client", lambda: SimpleNamespace(beta=SimpleNamespace(messages=FakeMessages())))
    result = ai.review(conn, "activity", 200, "mi")
    assert result["text"].startswith("### Summary")

    sent = calls[0]
    assert sent["model"] == "claude-opus-5-5" and sent["fallbacks"] == "default"
    assert sent["betas"] == ["server-side-fallback-2026-07-01"]
    payload = sent["messages"][0]["content"]
    data = json.loads(payload.split("<training_data>\n")[1].split("\n</training_data>")[0])
    assert data["workout"]["tag"] == "VO2 max intervals" and len(data["workout"]["reps"]) == 6
    assert '"lat"' not in payload and '"lon"' not in payload and "position" not in payload  # no GPS sent

    # Saved locally, so reopening the page doesn't call the API again
    assert ai.cached_review(conn, "activity", 200, "mi")["text"] == result["text"]
    assert ai.cached_review(conn, "activity", 200, "km") is None

    ai.review(conn, "overview", None, "km")
    assert "activities_last_8_weeks" in calls[1]["messages"][0]["content"]


def test_comeback_after_injury(tmp_path):
    from fitgen import run_walk

    conn = db.connect(tmp_path / "c.db")
    db.set_setting(conn, "lthr", 172)
    today = date.today()
    for n in range(4):  # training before the injury, ~3 months ago
        _add_run(conn, tmp_path, 10 + n, (today - timedelta(days=95 + n * 2)).isoformat(),
                 *steady_run(minutes=30, start_hr=140))
    for n, days_ago in enumerate([4, 2, 0]):  # run/walk comeback
        _add_run(conn, tmp_path, 20 + n, (today - timedelta(days=days_ago)).isoformat(),
                 *run_walk(reps=4 + n, run_s=300 - n * 60))
    processing.refresh(conn)

    first = [n["title"] for n in insights.workout_insights(conn, 20)]
    assert "First run back after 13 weeks off" in first
    latest = [n["title"] for n in insights.workout_insights(conn, 22)]
    assert any(t.startswith("Comeback") for t in latest)

    overview = {n["title"]: n for n in insights.overview_insights(conn)}
    assert "Rebuilding after 13 weeks off" in overview
    form = next(n for t, n in overview.items() if t.startswith("Form: "))
    if form["title"] == "Form: Fresh":
        assert "not a sign to race" in form["detail"]


def test_form_note_once_there_are_six_weeks_of_history(tmp_path):
    conn = db.connect(tmp_path / "f.db")
    today = date.today()
    db.upsert_activities(conn, [{
        "activityId": n, "activityName": f"Run {n}", "activityType": {"typeKey": "running"},
        "startTimeLocal": f"{today - timedelta(days=n * 2)} 07:00:00", "distance": 8000, "duration": 2700,
        "averageHR": 140} for n in range(1, 30)])  # every other day for eight weeks, summaries only
    titles = [n["title"] for n in insights.overview_insights(conn)]
    assert any(t.startswith("Form: ") for t in titles)


def _with_bests(conn, aid, day, bests):
    db.upsert_activities(conn, [{"activityId": aid, "activityName": f"Run {aid}", "activityType": {"typeKey": "running"},
                                 "startTimeLocal": f"{day} 07:00:00", "distance": 10000, "duration": 3000}])
    db.save_metrics(conn, aid, {"trimp": 50, "best_efforts": {k: {"seconds": s, "meters": m} for k, (s, m) in bests.items()}})


def test_new_bests_need_runs_to_beat_and_come_as_one_note(tmp_path):
    conn = db.connect(tmp_path / "b.db")
    slow = {"1 km": (300, 1000), "5 km": (1600, 5000)}
    _with_bests(conn, 1, "2026-09-01", slow)
    _with_bests(conn, 2, "2026-09-03", {"1 km": (280, 1000), "5 km": (1500, 5000)})
    # one run to beat: not yet a "best" worth a note
    assert not [n for n in insights.workout_insights(conn, 2) if n["title"].startswith("New best")]
    _with_bests(conn, 3, "2026-09-05", slow)
    _with_bests(conn, 4, "2026-09-07", slow)
    _with_bests(conn, 5, "2026-09-09", {"1 km": (270, 1000), "5 km": (1450, 5000)})
    titles = [n["title"] for n in insights.workout_insights(conn, 5)]
    assert "New bests at 2 distances" in titles and not any(t.startswith("New best 1 km") for t in titles)
