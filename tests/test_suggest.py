from __future__ import annotations

from datetime import date, timedelta

import pytest

from fitgen import intervals, steady_run
from garmin_connector import db, processing, sessions, suggest
from test_sessions import _add


@pytest.fixture(scope="module")
def conn(tmp_path_factory):
    """Six weeks of a regular routine: easy Mon/Fri, intervals Tue, long run Sat."""
    tmp = tmp_path_factory.mktemp("suggest")
    conn = db.connect(tmp / "s.db")
    db.set_setting(conn, "lthr", 170)
    db.set_setting(conn, "max_hr", 190)
    db.set_setting(conn, "resting_hr", 55)
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    n = 0
    for week in range(1, 7):
        start = monday - timedelta(days=7 * week)
        for offset, kind in ((0, "easy"), (1, "intervals"), (4, "easy"), (5, "long")):
            d = (start + timedelta(days=offset)).isoformat()
            n += 1
            if kind == "intervals":
                _add(conn, tmp, 700 + n, d, *intervals(reps=5, rep_s=180))
            else:
                _add(conn, tmp, 700 + n, d, *steady_run(minutes=80 if kind == "long" else 40, start_hr=135))
    processing.refresh(conn)
    yield conn
    conn.close()


@pytest.fixture
def neutral_form(monkeypatch):
    real = sessions.context

    def ctx(c, today=None):
        out = real(c, today)
        out["form"] = {"key": "neutral", "label": "Maintaining", "advice": "", "ratio": 0.0}
        return out

    monkeypatch.setattr(sessions, "context", ctx)


def _dates(ws):
    return [date.fromisoformat(w["date"]) for w in ws]


def test_follows_your_routine(conn, neutral_form):
    out = suggest.suggest(conn, count=7)
    ws = out["workouts"]
    assert out["source"] == "history" and len(ws) == 7
    assert all(w["date"] >= date.today().isoformat() for w in ws)
    days = {w["day"] for w in ws}
    assert days <= {"Mon", "Tue", "Fri", "Sat"}            # the days you usually run
    assert all(w["type"] == "long" for w in ws if w["day"] == "Sat")
    hard = [w for w in ws if w["type"] not in ("easy", "long")]
    assert hard and all(w["day"] == "Tue" for w in hard)   # where you usually do them
    assert all(w["why"] and w["minutes"] > 0 and w["hr"] for w in ws)
    assert "Saturday" in out["basis"]


def test_safety_rules(conn, neutral_form):
    ws = suggest.suggest(conn, count=7)["workouts"]
    hard = [date.fromisoformat(w["date"]) for w in ws if w["type"] not in ("easy", "long")]
    assert all((b - a).days >= 2 for a, b in zip(hard, hard[1:]))
    longs = {date.fromisoformat(w["date"]) for w in ws if w["type"] == "long"}
    assert not any(h + timedelta(days=1) in longs for h in hard)  # never the day before the long run
    weeks = [h - timedelta(days=h.weekday()) for h in hard]
    assert all(weeks.count(w) <= 1 for w in weeks)           # 4 runs a week -> one hard session


def test_count_and_dates_ascend(conn, neutral_form):
    for n in (3, 5):
        ws = suggest.suggest(conn, count=n)["workouts"]
        assert len(ws) == n and _dates(ws) == sorted(_dates(ws))


def test_overreaching_keeps_the_next_days_easy(conn, monkeypatch):
    real = sessions.context

    def tired(c, today=None):
        out = real(c, today)
        out["form"] = {"key": "overreaching", "label": "Overreaching", "advice": "", "ratio": -0.4}
        return out

    monkeypatch.setattr(sessions, "context", tired)
    out = suggest.suggest(conn, count=7)
    soon = [w for w in out["workouts"] if (date.fromisoformat(w["date"]) - date.today()).days < 3]
    assert all(w["type"] in ("easy", "long") for w in soon)
    assert "fatigue" in out["basis"]


def test_not_enough_history(tmp_path):
    conn = db.connect(tmp_path / "e.db")
    out = suggest.suggest(conn)
    assert out["source"] == "none" and out["workouts"] == []
