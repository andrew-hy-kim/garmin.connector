from __future__ import annotations

from datetime import date, timedelta

import pytest

from garmin_connector import db, health


class Watch:
    """Garmin's responses, shaped like the real ones."""

    def __init__(self, today, rhr=48, hrv=62, sleep_h=7.5, bad_days=0):
        self.today, self.rhr, self.hrv, self.sleep_h, self.bad_days = today, rhr, hrv, sleep_h, bad_days
        self.calls = 0

    def _bad(self, day):
        return (self.today - date.fromisoformat(day)).days < self.bad_days

    def get_rhr_day(self, day):
        self.calls += 1
        v = self.rhr + (8 if self._bad(day) else 0)
        return {"allMetrics": {"metricsMap": {"WELLNESS_RESTING_HEART_RATE": [{"value": v, "calendarDate": day}]}}}

    def get_hrv_data(self, day):
        v = self.hrv - (20 if self._bad(day) else 0)
        return {"hrvSummary": {"calendarDate": day, "lastNightAvg": v, "weeklyAvg": self.hrv, "status": "BALANCED",
                               "baseline": {"balancedLow": 55, "balancedUpper": 70}}}

    def get_sleep_data(self, day):
        h = self.sleep_h - (2.5 if self._bad(day) else 0)
        return {"dailySleepDTO": {"calendarDate": day, "sleepTimeSeconds": h * 3600, "deepSleepSeconds": 5400,
                                  "remSleepSeconds": 6000, "sleepScores": {"overall": {"value": 81}}}}

    def get_training_readiness(self, day):
        return [{"calendarDate": day, "score": 72, "level": "MODERATE"}]


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr(health, "REQUEST_PAUSE_S", 0)
    c = db.connect(tmp_path / "h.db")
    yield c
    c.close()


def test_first_fetch_takes_90_days_then_only_new_ones(conn):
    today = date.today()
    w = Watch(today)
    assert health.fetch(w, conn, today) == 90
    w2 = Watch(today)
    health.fetch(w2, conn, today + timedelta(days=2))
    assert w2.calls == 4  # yesterday-of-latest re-checked, plus the new days
    row = dict(conn.execute("SELECT * FROM daily_health WHERE date = ?", (today.isoformat(),)).fetchone())
    assert row["resting_hr"] == 48 and row["hrv"] == 62 and row["hrv_low"] == 55 and row["sleep_score"] == 81
    assert row["readiness"] == 72 and row["readiness_level"] == "MODERATE"


def test_normal_days_raise_no_flags(conn):
    today = date.today()
    health.fetch(Watch(today), conn, today)
    s = health.summary(conn, today)
    assert s["resting_hr"] == 48 and s["resting_hr_normal"] == 48 and not s["flags"]
    assert s["hrv"] == 62 and s["hrv_low"] == 55 and abs(s["sleep_week_avg_s"] - 7.5 * 3600) < 1
    assert len(s["history"]) == 90


def test_signs_of_strain_are_flagged(conn):
    today = date.today()
    health.fetch(Watch(today, bad_days=3), conn, today)
    s = health.summary(conn, today)
    assert s["rhr_high_days"] == 3 and s["hrv_low_days"] == 3
    assert any("Resting heart rate" in f for f in s["flags"]) and any("HRV" in f for f in s["flags"])


def test_watch_without_these_calls(conn):
    class Bare:
        pass
    assert health.fetch(Bare(), conn) == 0
    assert health.summary(conn) is None


def test_failing_requests_give_up_quickly(conn):
    class Down:
        calls = 0

        def get_rhr_day(self, day):
            Down.calls += 1
            raise RuntimeError("503")
        get_hrv_data = get_sleep_data = get_training_readiness = get_rhr_day
    health.fetch(Down(), conn)
    assert Down.calls <= 12
