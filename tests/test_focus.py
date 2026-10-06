from __future__ import annotations

from datetime import date, timedelta

from fitgen import steady_run
from garmin_connector import db, focus, insights, performance as perf, processing
from test_performance import _add


def _conn(tmp_path, every_days):
    c = db.connect(tmp_path / "f.db")
    db.set_setting(c, "max_hr", 190)
    db.set_setting(c, "lthr", 172)
    db.set_setting(c, "resting_hr", 50)
    today = date.today()
    for n in range(84 // every_days):
        _add(c, tmp_path, 100 + n, (today - timedelta(days=1 + every_days * n)).isoformat(),
             *steady_run(minutes=40, pace_mps=3.2, start_hr=135, drift_bpm=4))
    processing.refresh(c)
    return c


def test_regular_easy_running(tmp_path):
    c = _conn(tmp_path, 2)
    areas = focus.areas(c, perf.summary(c))
    by = {a["key"]: a for a in areas}
    assert by["consistency"]["level"] == "strength"
    # all easy, 40-minute runs: no workouts, and no long runs for endurance
    assert by["quality"]["level"] == "focus" and by["quality"]["action"]
    assert by["endurance"]["level"] == "focus"
    # areas to work on come first
    levels = [a["level"] for a in areas]
    assert levels == sorted(levels, key=focus.LEVEL_RANK.get)
    # paces and distances are tokens the dashboard shows in your units
    assert "{{r:" in by["quality"]["action"] and "{{d:" in by["endurance"]["detail"]
    assert "{{" not in insights.plain(by["endurance"]["detail"]) and " km" in insights.plain(by["endurance"]["detail"])
    c.close()


def test_sparse_running(tmp_path):
    c = _conn(tmp_path, 9)
    by = {a["key"]: a for a in focus.areas(c, perf.summary(c))}
    assert by["consistency"]["level"] == "focus"
    c.close()


def test_too_little_data(tmp_path):
    c = db.connect(tmp_path / "e.db")
    assert focus.areas(c, perf.summary(c)) == []


def test_plain_text():
    assert insights.plain("{{d:804672}} and {{d:5000}} at {{p:4.000}}") == "805 km and 5.0 km at 4:10 /km"


def test_comeback_after_a_break(tmp_path):
    c = db.connect(tmp_path / "b.db")
    db.set_setting(c, "max_hr", 190)
    db.set_setting(c, "lthr", 172)
    db.set_setting(c, "resting_hr", 50)
    today = date.today()
    # running every other day until 8 weeks ago, then six weeks off, then easy runs every other day
    days = [today - timedelta(days=d) for d in range(57, 120, 2)] + [today - timedelta(days=d) for d in range(1, 14, 2)]
    for n, d in enumerate(days):
        _add(c, tmp_path, 100 + n, d.isoformat(), *steady_run(minutes=35, pace_mps=3.0, start_hr=135, drift_bpm=4))
    processing.refresh(c)
    by = {a["key"]: a for a in focus.areas(c, perf.summary(c))}
    # no push for workouts while rebuilding, and consistency counts the weeks since coming back
    assert by["quality"]["level"] == "ok" and by["quality"]["headline"] == "Rebuilding first"
    assert by["consistency"]["level"] == "strength" and "Back running since" in by["consistency"]["detail"]
    notes = [n["title"] for n in insights.overview_insights(c)]
    assert "No workouts in two weeks" not in notes and not any(t.startswith("Mileage up") for t in notes)
    c.close()
