"""Sleep, resting HR and HRV from the nights you wore the watch, against a fake Garmin."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from garmin_connector import db, overnight, processing

TODAY = date(2026, 11, 1)


def night(day: str, sleep_h: float = 7.5, rhr: float = 60, hrv: float = 40, score: float = 78) -> dict:
    return {"calendarDate": day, "values": {
        "totalSleepTimeInSeconds": sleep_h * 3600, "deepTime": 5000, "lightTime": 15000, "remTime": 6000,
        "awakeTime": 300, "sleepScore": score, "sleepScoreQuality": "GOOD", "restingHeartRate": rhr,
        "avgOvernightHrv": hrv, "hrv7dAverage": hrv, "hrvStatus": "BALANCED", "respiration": 15.0,
        "localSleepStartTimeInMillis": 1698884520000, "localSleepEndTimeInMillis": 1698910200000}}


class FakeGarmin:
    def __init__(self, nights: list[dict], fail: bool = False):
        self.nights = {n["calendarDate"]: n for n in nights}
        self.calls: list[tuple[str, str]] = []
        self.hrv_calls: list[tuple[str, str]] = []
        self.fail = fail

    def get_sleep_daily(self, start, end):
        self.calls.append((start, end))
        if self.fail:
            raise ConnectionError("Garmin is down")
        assert (date.fromisoformat(end) - date.fromisoformat(start)).days < 28
        return [n for d, n in sorted(self.nights.items()) if start <= d <= end]

    def get_hrv_data_range(self, start, end):
        self.hrv_calls.append((start, end))
        return {"hrvSummaries": [{"calendarDate": d, "baseline": {"balancedLow": 34, "balancedUpper": 50}}
                                 for d in self.nights if start <= d <= end]}


def days_before(n: int) -> str:
    return (TODAY - timedelta(days=n)).isoformat()


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "test.db")
    yield c
    c.close()


@pytest.fixture(autouse=True)
def no_pause(monkeypatch):
    monkeypatch.setattr(overnight, "REQUEST_PAUSE_S", 0)


def add_workout(conn, day: str):
    db.upsert_activities(conn, [{"activityId": 1, "startTimeLocal": f"{day} 07:00:00", "activityType": {"typeKey": "running"}}])


def test_a_short_night_keeps_sleep_but_not_resting_hr_or_hrv():
    _, full = overnight.parse_night(night("2026-10-01"))
    _, short = overnight.parse_night(night("2026-10-02", sleep_h=2.5, rhr=95))
    assert full["resting_hr"] == 60 and full["hrv"] == 40 and full["bedtime"]
    assert short["sleep_s"] == 2.5 * 3600 and short["resting_hr"] is None and short["hrv"] is None
    assert overnight.parse_night({"calendarDate": "2026-10-03", "values": {"totalSleepTimeInSeconds": None}}) is None


def test_first_sync_goes_back_past_the_first_workout_until_a_year_without_nights(conn):
    add_workout(conn, days_before(400))
    old = days_before(700)  # a night from before your first workout still counts
    client = FakeGarmin([night(days_before(1)), night(days_before(2)), night(old)])
    assert overnight.fetch(client, conn, TODAY) == 3
    oldest_asked = min(a for a, _ in client.calls)
    assert oldest_asked < (date.fromisoformat(old) - timedelta(days=300)).isoformat()  # kept looking a year past it
    assert len(client.calls) < 60
    rows = conn.execute("SELECT date, resting_hr, hrv_low, hrv_high FROM nights ORDER BY date").fetchall()
    assert [r[0] for r in rows] == [old, days_before(2), days_before(1)]
    assert all(r[2] == 34 and r[3] == 50 for r in rows)  # Garmin's HRV range for you
    assert db.get_text_setting(conn, "nights_through") == TODAY.isoformat()


def test_later_syncs_only_recheck_the_last_few_nights(conn):
    client = FakeGarmin([night(days_before(5))])
    overnight.fetch(client, conn, TODAY - timedelta(days=1))
    client.calls.clear()
    client.nights[TODAY.isoformat()] = night(TODAY.isoformat(), rhr=58)
    assert overnight.fetch(client, conn, TODAY) == 1
    assert client.calls == [((TODAY - timedelta(days=1 + overnight.RECHECK_DAYS)).isoformat(), TODAY.isoformat())]


def test_garmin_failing_never_marks_the_history_done(conn):
    assert overnight.fetch_quietly(FakeGarmin([], fail=True), conn, TODAY) == 0
    assert db.get_text_setting(conn, "nights_through") is None


def test_resting_hr_comes_from_your_nights_and_only_moves_in_steps(conn):
    nights = [night(days_before(i), rhr=60 + (i % 3) - 1) for i in range(10)]  # 59..61, median 60
    overnight.fetch(FakeGarmin(nights), conn, TODAY)
    assert overnight.update_resting_hr(conn, TODAY) == 60
    s = processing.effective_settings(conn)
    assert s["resting_hr"] == 60 and s["sources"]["resting_hr"] == "nights"

    conn.execute("UPDATE nights SET resting_hr = resting_hr + 1")  # a 1 bpm shift doesn't move it
    assert overnight.update_resting_hr(conn, TODAY) == 60
    conn.execute("UPDATE nights SET resting_hr = resting_hr + 2")
    assert overnight.update_resting_hr(conn, TODAY) == 63

    db.set_setting(conn, "resting_hr", 50)  # what you set still wins
    assert processing.effective_settings(conn)["sources"]["resting_hr"] == "you"


def test_too_few_nights_leave_resting_hr_to_garmin(conn):
    overnight.fetch(FakeGarmin([night(days_before(1)), night(days_before(2))]), conn, TODAY)
    assert overnight.update_resting_hr(conn, TODAY) is None
    assert processing.effective_settings(conn)["sources"]["resting_hr"] != "nights"


def test_summary_flags_nights_in_a_row_off_your_normal(conn):
    nights = [night(days_before(i), rhr=58, hrv=42, sleep_h=5.5) for i in range(3, 20)]
    nights += [night(days_before(i), rhr=66, hrv=30, sleep_h=5) for i in range(0, 3)]
    overnight.fetch(FakeGarmin(nights), conn, TODAY)
    s = overnight.summary(conn, TODAY)
    assert s["recent"] and s["resting_hr_normal"] == 58 and s["worn_14"] == 14
    keys = {f["key"]: f for f in s["flags"]}
    assert keys["rhr"]["nights"] == 3 and keys["hrv"]["nights"] == 3 and "sleep" in keys
    assert "8 bpm above" in keys["rhr"]["text"]
    assert len(s["nights"]) == 20


def test_no_flags_from_old_nights(conn):
    nights = [night(days_before(i), rhr=58) for i in range(30, 50)] + [night(days_before(i), rhr=70) for i in range(27, 30)]
    overnight.fetch(FakeGarmin(nights), conn, TODAY)
    s = overnight.summary(conn, TODAY)
    assert not s["recent"] and s["flags"] == []


def test_night_before_a_workout(conn):
    nights = [night(days_before(i), rhr=58, hrv=42) for i in range(1, 15)] + [night(TODAY.isoformat(), rhr=64, hrv=30)]
    overnight.fetch(FakeGarmin(nights), conn, TODAY)
    n = overnight.night_before(conn, f"{TODAY} 17:30:00")
    assert n["resting_hr"] == 64 and n["resting_hr_normal"] == 58 and n["hrv_low"] == 34
    assert overnight.night_before(conn, f"{days_before(30)} 17:30:00") is None
