from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from fitgen import intervals, steady_run, write_fit
from garmin_connector import db, planner, processing


def _add(conn, tmp_path, activity_id, day, samples, laps):
    db.upsert_activities(conn, [{
        "activityId": activity_id, "activityName": f"Run {activity_id}", "startTimeLocal": f"{day} 07:00:00",
        "activityType": {"typeKey": "running"}, "distance": samples[-1]["distance"], "duration": len(samples),
    }])
    start = datetime.fromisoformat(f"{day}T14:00:00").replace(tzinfo=timezone.utc)
    processing.import_fit(conn, activity_id, write_fit(tmp_path / f"{activity_id}.fit", samples, laps, start=start))


@pytest.fixture(scope="module")
def conn(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("plan")
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
    ctx = planner.context(conn)
    assert 120 <= ctx["last7_minutes"] <= 200
    assert ctx["runs_per_week_4wk"] >= 3
    assert ctx["lthr"] == 170 and ctx["comeback"] is None
    assert ctx["paces"]["vo2_mps"] > ctx["paces"]["threshold_mps"] > ctx["paces"]["tempo_mps"]


@pytest.fixture
def neutral_form(monkeypatch):
    """The fixture's short history reads as overreaching; pin form to 'maintaining' for these tests."""
    real = planner.context

    def ctx(c, today=None):
        out = real(c, today)
        out["form"] = {"key": "neutral", "label": "Maintaining", "advice": "", "ratio": 0.0}
        return out

    monkeypatch.setattr(planner, "context", ctx)


@pytest.mark.parametrize("goal", list(planner.GOALS))
def test_every_goal_builds_a_sensible_plan(conn, goal, neutral_form):
    plan = planner.generate(conn, goal, weeks=6, runs_per_week=4)
    assert len(plan["weeks"]) == 6
    for w in plan["weeks"]:
        runs = [d for d in w["days"] if d["type"] != "rest"]
        assert len(runs) == 4 and len(w["days"]) == 7
        hard = [DAY for DAY, d in enumerate(w["days"]) if d["type"] in ("vo2", "threshold", "tempo", "hills")]
        assert all(b - a >= 2 for a, b in zip(hard, hard[1:]))  # hard days 48h+ apart
        long_run = next(d for d in w["days"] if d["type"] == "long")
        assert long_run["day"] == "Sun"
        assert long_run["minutes"] >= max(d["minutes"] for d in runs if d["type"] == "easy")
    minutes = [w["minutes"] for w in plan["weeks"]]
    assert plan["weeks"][3]["recovery"] and minutes[3] < minutes[2]
    # never more than ~15% above the biggest week so far (coming back up after a lighter week is fine)
    assert all(minutes[i] <= max(minutes[:i]) * 1.15 + 10 for i in range(1, len(minutes)))
    if goal == "return":
        assert all(w["quality"] == 0 for w in plan["weeks"])
    if goal in ("vo2", "threshold"):
        assert plan["weeks"][0]["quality"] == 1
        kinds = {d["type"] for w in plan["weeks"] for d in w["days"]}
        assert goal in kinds


def test_vo2_reps_progress(conn, neutral_form):
    plan = planner.generate(conn, "vo2", weeks=4, runs_per_week=4)
    sessions = [d["details"] for w in plan["weeks"] for d in w["days"] if d["type"] == "vo2"]
    assert sessions[0] != sessions[1] and "5 × 3 min" in sessions[0]


def test_saturday_long_runs_and_six_days(conn):
    plan = planner.generate(conn, "base", weeks=4, runs_per_week=6, long_day="Sat")
    week = plan["weeks"][0]
    assert next(d for d in week["days"] if d["type"] == "long")["day"] == "Sat"
    assert sum(1 for d in week["days"] if d["type"] == "rest") == 1


def test_comeback_delays_hard_sessions(tmp_path):
    conn = db.connect(tmp_path / "c.db")
    db.set_setting(conn, "lthr", 170)
    db.set_setting(conn, "max_hr", 190)
    today = date.today()
    for n in range(4):
        _add(conn, tmp_path, 10 + n, (today - timedelta(days=100 + n * 2)).isoformat(), *steady_run(minutes=30))
    for n, ago in enumerate([5, 3, 1]):
        _add(conn, tmp_path, 20 + n, (today - timedelta(days=ago)).isoformat(), *steady_run(minutes=25, start_hr=135))
    processing.refresh(conn)

    plan = planner.generate(conn, "vo2", weeks=6, runs_per_week=3)
    assert plan["context"]["comeback"]
    assert plan["weeks"][0]["quality"] == 0 and plan["weeks"][1]["quality"] == 0
    assert any("comeback" in n for n in plan["notes"])
    assert any(w["quality"] for w in plan["weeks"][3:])
    assert plan["weeks"][0]["minutes"] <= 110  # starts from ~75 min/week, not a big jump


def test_save_and_progress(conn):
    plan = planner.generate(conn, "threshold", weeks=4, runs_per_week=4,
                            start=date.today() - timedelta(days=date.today().weekday() + 7))
    planner.save(conn, plan)
    loaded = planner.load(conn)
    assert loaded["goal"] == "threshold"
    prog = planner.progress(conn, loaded)
    assert prog[0]["status"] == "past" and prog[1]["status"] == "current"
    assert prog[0]["done_runs"] >= 3 and prog[0]["done_minutes"] > 100
    planner.delete(conn)
    assert planner.load(conn) is None


def test_overreaching_starts_light_then_returns_to_normal(conn, monkeypatch):
    real = planner.context

    def tired(c, today=None):
        ctx = real(c, today)
        ctx["form"] = {"key": "overreaching", "label": "Overreaching", "advice": "", "ratio": -0.4}
        return ctx

    monkeypatch.setattr(planner, "context", tired)
    plan = planner.generate(conn, "vo2", weeks=4, runs_per_week=4)
    w1, w2 = plan["weeks"][0], plan["weeks"][1]
    assert w1["quality"] == 0 and w2["quality"] == 1
    assert w2["minutes"] <= w1["minutes"] * 1.35  # back to usual volume, no extra growth on top
    assert any("fatigue" in n for n in plan["notes"])


def test_plan_api(conn):
    from garmin_connector import web

    path = conn.execute("PRAGMA database_list").fetchone()[2]  # the fixture's database file
    client = web.create_app(path).test_client()

    empty = client.get("/api/plan").get_json()
    assert empty["plan"] is None and "vo2" in empty["goals"] and 3 <= empty["defaults"]["runs_per_week"] <= 6
    assert client.post("/api/plan", json={"goal": "nope"}).status_code == 400

    made = client.post("/api/plan", json={"goal": "threshold", "weeks": 4, "runs_per_week": 5, "long_day": "Sat"}).get_json()
    assert made["plan"]["goal"] == "threshold" and len(made["plan"]["weeks"]) == 4
    assert made["plan"]["params"] == {"weeks": 4, "runs_per_week": 5, "long_day": "Sat"}
    assert len(made["progress"]) == 4
    assert client.get("/plan").status_code == 200
    assert client.delete("/api/plan").get_json()["plan"] is None
