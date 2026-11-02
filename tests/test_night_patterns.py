"""What your nights say: poor nights vs. runs, recovery by workout kind, bedtime, illness warning."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from garmin_connector import db, insights, night_patterns, overnight
from garmin_connector.web import create_app

START = date(2024, 1, 1)


def day(i: int) -> str:
    return (START + timedelta(days=i)).isoformat()


def night(sleep_h=7.5, hrv=40.0, rhr=55.0, score=78, bedtime="23:30", breathing=14.0, low=34.0, high=48.0):
    return {"sleep_s": sleep_h * 3600, "hrv": hrv, "resting_hr": rhr, "sleep_score": score, "bedtime": bedtime,
            "wake_time": "07:00", "respiration": breathing, "hrv_low": low, "hrv_high": high}


def run(i: int, kind="easy", eff=1.1, quality=False) -> dict:
    return {"date": day(i), "time": "17:00", "efficiency": eff, "steady": True, "type": kind, "quality": quality}


def test_short_nights_that_cost_efficiency_say_so():
    nights = {day(i): night(sleep_h=5.5 if i % 4 == 0 else 7.5) for i in range(120)}
    runs = [run(i, eff=(0.99 if i % 4 == 0 else 1.10) + (i % 3) * 0.005) for i in range(120)]
    short = next(f for f in night_patterns.sleep_and_runs(runs, nights) if f["key"] == "short")
    assert short["clear"] and short["diff_pct"] < -5
    assert short["text"].startswith("After short nights (under 6.5 hours), your easy runs cover 10% less")


def test_no_effect_is_reported_as_no_effect():
    nights = {day(i): night(sleep_h=5.5 if i % 4 == 0 else 7.5) for i in range(120)}
    runs = [run(i, eff=1.10 + (i % 3) * 0.01) for i in range(120)]
    short = next(f for f in night_patterns.sleep_and_runs(runs, nights) if f["key"] == "short")
    assert not short["clear"] and short["text"].startswith("No clear effect")


def test_too_few_runs_say_nothing():
    nights = {day(i): night(sleep_h=5.5 if i < 3 else 7.5) for i in range(40)}
    assert night_patterns.sleep_and_runs([run(i) for i in range(40)], nights) == []


def test_recovery_by_kind_of_workout():
    nights = {day(i): night() for i in range(200)}
    runs = []
    for k in range(6):  # six long runs, 20 days apart: HRV 10% down the night after, back the next
        d = 20 + k * 20
        runs.append(run(d, "long"))
        nights[day(d + 1)] = night(hrv=36.0, rhr=58.0)
    runs += [run(30 + k * 20, "intervals_vo2", quality=True) for k in range(3)]  # too few to judge
    found = night_patterns.recovery_by_kind(runs, nights)
    assert [f["kind"] for f in found] == ["Long runs"]
    assert found[0]["back_to_normal_night"] == 2 and found[0]["resting_hr_change"][1] == 3.0
    assert found[0]["text"] == "Long runs: HRV dips 10% the night after, back to normal by night 2 (6 long runs)."


def test_bedtime_that_splits_your_sleep_score():
    nights = {day(i): night(bedtime="23:15" if i % 3 else "01:45", score=(80 if i % 3 else 66) + i % 2) for i in range(150)}
    found = night_patterns.bedtime(nights)
    assert found["clear"] and found["text"].startswith("Asleep before 11:30 p.m.: sleep score 80 on average, against 66")
    flat = night_patterns.bedtime({day(i): night(bedtime="23:15" if i % 3 else "01:45", score=75 + i % 5) for i in range(150)})
    assert flat["text"] == "Bedtime makes little difference to your sleep score."


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "test.db")
    overnight.ensure(c)
    yield c
    c.close()


def add_nights(conn, rows: dict[str, dict]):
    for d, n in rows.items():
        conn.execute("INSERT INTO nights (date, sleep_s, hrv, resting_hr, sleep_score, bedtime, wake_time, respiration, hrv_low, hrv_high) "
                     "VALUES (?,?,?,?,?,?,?,?,?,?)", (d, n["sleep_s"], n["hrv"], n["resting_hr"], n["sleep_score"], n["bedtime"],
                                                      n["wake_time"], n["respiration"], n["hrv_low"], n["hrv_high"]))
    conn.commit()


def test_breathing_and_resting_hr_up_together_warns_of_illness(conn):
    today = date.today()
    rows = {(today - timedelta(days=i)).isoformat(): night() for i in range(1, 20)}
    rows[today.isoformat()] = night(breathing=15.4, rhr=59.0)
    add_nights(conn, rows)
    flags = overnight.summary(conn)["flags"]
    assert flags[0]["key"] == "ill"
    note = next(n for n in insights.overview_insights(conn) if n["title"] == "Signs your body may be fighting something")
    assert "15.4 a minute (normally 14.0)" in note["detail"] and "4 bpm above" in note["detail"]


def test_breathing_up_alone_is_not_a_warning(conn):
    today = date.today()
    rows = {(today - timedelta(days=i)).isoformat(): night() for i in range(1, 20)}
    rows[today.isoformat()] = night(breathing=16.0, rhr=56.0)
    add_nights(conn, rows)
    assert overnight.summary(conn)["flags"] == []


def test_api_carries_the_patterns(conn, tmp_path):
    add_nights(conn, {day(i): night(bedtime="23:15" if i % 3 else "01:45", score=80 if i % 3 else 66) for i in range(150)})
    client = create_app(tmp_path / "test.db").test_client()
    body = client.get("/api/nights").get_json()
    assert body["patterns"]["bedtime"]["clear"]
    assert create_app(tmp_path / "empty.db").test_client().get("/api/nights").get_json() is None
