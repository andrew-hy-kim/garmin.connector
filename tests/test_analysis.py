from __future__ import annotations

import pytest

from fitgen import intervals, run_walk, steady_run, write_fit
from garmin_connector import analysis, db, fit, processing


def test_parse_reads_samples_laps_and_hr_source(tmp_path):
    samples, laps = intervals(reps=3)
    parsed = fit.parse(write_fit(tmp_path / "a.fit", samples, laps, external_hr=True))

    assert len(parsed.samples) == len(samples)
    first, last = parsed.samples[0], parsed.samples[-1]
    assert first.t == 0 and last.t == len(samples) - 1
    assert first.hr == 140 and first.cadence == 164  # 82 per leg -> 164 steps/min
    assert last.distance == pytest.approx(samples[-1]["distance"], abs=0.1)
    assert first.lat == pytest.approx(47.6, abs=1e-3)

    assert [lap.intensity for lap in parsed.laps] == ["warmup", "active", "rest", "active", "rest", "active", "rest", "cooldown"]
    assert parsed.laps[1].start_t == 600 and parsed.laps[1].avg_hr == 178
    assert parsed.external_hr is True
    assert fit.parse(write_fit(tmp_path / "b.fit", samples, laps)).external_hr is False


def test_clean_hr_removes_wrist_spikes():
    hr = [150] * 30
    hr[10] = 205
    hr[20] = None
    cleaned = analysis.clean_hr(hr)
    assert cleaned[10] == 150
    assert cleaned[20] is None
    assert cleaned[0] == 150


def test_zones_from_max_hr_and_threshold():
    by_max = analysis.hr_zones(200)
    assert [(z.low, z.high) for z in by_max][:2] == [(0, 140), (140, 160)]
    by_lthr = analysis.hr_zones(200, lthr=170)
    assert by_lthr[3].high == 170 and by_lthr[4].low == 170


def test_time_in_zones_ignores_pauses():
    t = [0, 1, 2, 3, 200, 201]  # paused between 3 and 200
    hr = [100, 100, 100, 100, 190, 190]
    secs = analysis.time_in_zones(t, hr, analysis.hr_zones(200))
    assert sum(secs) == 6
    assert secs[0] == 4 and secs[4] == 2


def test_trimp_rewards_intensity():
    t = list(range(1800))
    easy = analysis.trimp(t, [130] * 1800, 60, 190)
    hard = analysis.trimp(t, [175] * 1800, 60, 190)
    assert 0 < easy < hard
    assert analysis.trimp_from_summary(1800, 130, 60, 190) == pytest.approx(easy, rel=0.01)


def test_best_efforts_finds_fastest_stretch():
    samples, _ = intervals(reps=6, rep_s=240)  # 4 min at 4.6 m/s = 1104 m per rep
    t = [s["t"] for s in samples]
    dist = [s["distance"] for s in samples]
    efforts = analysis.best_efforts(t, dist)
    assert efforts["1 km"]["seconds"] == pytest.approx(1000 / 4.6, abs=1)
    assert "Half marathon" not in efforts


def test_best_efforts_rejects_gps_glitch():
    t = list(range(100))
    dist = [i * 3.0 for i in range(100)]
    dist[50:] = [d + 1000 for d in dist[50:]]  # 1 km jump in one second
    assert "1 km" not in analysis.best_efforts(t, dist)


def test_grade_adjusted_speed_is_faster_uphill():
    distance = [float(i) for i in range(0, 200, 2)]
    altitude = [d * 0.08 for d in distance]  # 8% climb
    g = analysis.grades(distance, altitude)
    assert g[-1] == pytest.approx(0.08, abs=0.005)
    gap = analysis.grade_adjusted_speed([2.5] * len(distance), g)
    assert gap[-1] > 3.0


def test_decoupling_detects_drift():
    samples, _ = steady_run(minutes=60, drift_bpm=15)
    t = [s["t"] for s in samples]
    speed = [s["speed"] for s in samples]
    drifting = analysis.aerobic_decoupling(t, speed, [s["hr"] for s in samples])
    assert drifting > 3
    flat = analysis.aerobic_decoupling(t, speed, [150] * len(samples))
    assert flat == 0
    assert analysis.aerobic_decoupling(t[:1500], speed[:1500], [150] * 1500) is None


def test_cadence_lock_flags_hr_matching_steps():
    assert analysis.cadence_lock_fraction([168] * 10, [168] * 10) == 1
    assert analysis.cadence_lock_fraction([150] * 10, [168] * 10) == 0


def test_training_load_rises_and_falls():
    days = [f"2026-01-{d:02d}" for d in range(1, 31)]
    series = analysis.training_load({d: 100 for d in days[:14]}, days)
    assert series[13]["fatigue"] > series[13]["fitness"] > 0
    assert series[13]["form"] < 0  # tired after two hard weeks
    assert series[-1]["form"] > 0  # fresh after two weeks off


def test_import_and_analyze_end_to_end(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    samples, laps = steady_run(minutes=50)
    path = write_fit(tmp_path / "run.fit", samples, laps, wrist_spikes=True)
    db.upsert_activities(conn, [{"activityId": 1, "activityName": "Easy", "startTimeLocal": "2026-09-01 07:00:00",
                                 "activityType": {"typeKey": "running"}, "duration": 3000, "maxHR": 205}])
    processing.import_fit(conn, 1, path)

    assert processing.refresh(conn) == 1
    metrics = conn.execute("SELECT * FROM activity_metrics").fetchone()
    assert metrics["trimp"] > 0
    assert metrics["max_hr_30s"] < 180  # the 205 spikes were cleaned out
    assert metrics["decoupling_pct"] is not None

    settings = processing.effective_settings(conn)
    assert settings["max_hr"] == round(metrics["max_hr_30s"]) and "max_hr" in settings["estimated"]

    db.set_setting(conn, "max_hr", 195)
    assert processing.refresh(conn) == 1  # changed settings -> re-analyzed
    assert processing.effective_settings(conn)["max_hr"] == 195

    load = processing.training_load_series(conn)
    assert load[0]["date"] == "2026-09-01" and load[0]["load"] > 0


def test_interval_workouts_skip_hr_drift(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    samples, laps = intervals(reps=8, rep_s=240, warm_s=900)
    db.upsert_activities(conn, [{"activityId": 2, "startTimeLocal": "2026-09-02 07:00:00",
                                 "activityType": {"typeKey": "running"}}])
    processing.import_fit(conn, 2, write_fit(tmp_path / "iv.fit", samples, laps))
    processing.refresh(conn)
    row = conn.execute("SELECT decoupling_pct, trimp FROM activity_metrics").fetchone()
    assert row["decoupling_pct"] is None and row["trimp"] > 0


def test_activity_detail_api(tmp_path):
    from garmin_connector.web import create_app

    path = tmp_path / "w.db"
    conn = db.connect(path)
    samples, laps = steady_run(minutes=20)
    db.upsert_activities(conn, [{"activityId": 3, "activityName": "Hills", "startTimeLocal": "2026-09-03 07:00:00",
                                 "activityType": {"typeKey": "running"}}])
    processing.import_fit(conn, 3, write_fit(tmp_path / "r.fit", samples, laps, external_hr=True))
    processing.refresh(conn)
    conn.close()

    client = create_app(path).test_client()
    body = client.get("/api/activities/3").get_json()
    assert body["external_hr"] is True
    assert len(body["streams"]["t"]) == 1200 and len(body["streams"]["gap"]) == 1200
    assert len(body["zones"]) == 5 and body["metrics"]["trimp"] > 0
    assert list(body["metrics"]["best_efforts"])[:2] == ["400 m", "1 km"]  # distance order, not alphabetical
    assert client.get("/api/activities/999").status_code == 404
    assert client.get("/activity/3").status_code == 200
    saved = client.post("/api/settings", json={"max_hr": 188, "lthr": 170}).get_json()
    assert saved["max_hr"] == 188 and saved["zones"][3]["high"] == 170
    assert list(client.get("/api/records").get_json())[0] == "400 m"


def _streams(samples):
    return {k: [s.get(k) for s in samples] for k in ("t", "speed", "hr", "distance", "cadence")}


def test_classify_steady_runs():
    lthr = 170
    easy, _ = steady_run(minutes=45, start_hr=135, drift_bpm=5)
    s = _streams(easy)
    assert analysis.classify_workout("running", s["t"], s["speed"], s["hr"], s["distance"], lthr)["type"] == "easy"

    long_run, _ = steady_run(minutes=95, start_hr=135, drift_bpm=8)
    s = _streams(long_run)
    assert analysis.classify_workout("running", s["t"], s["speed"], s["hr"], s["distance"], lthr)["type"] == "long"

    tempo, _ = steady_run(minutes=40, start_hr=158, drift_bpm=2)  # ~93% of threshold
    s = _streams(tempo)
    tag = analysis.classify_workout("running", s["t"], s["speed"], s["hr"], s["distance"], lthr)
    assert tag["type"] == "tempo" and tag["quality"]

    assert analysis.classify_workout("cycling", s["t"], s["speed"], s["hr"], s["distance"], lthr) is None
    assert analysis.classify_workout("running", s["t"], s["speed"], s["hr"], s["distance"], lthr,
                                     is_race=True)["type"] == "race"


def test_classify_intervals_from_laps_and_from_pace():
    samples, laps = intervals(reps=6, rep_s=180)  # reps at 178 bpm, 105% of 170
    s = _streams(samples)
    lap_dicts = [{"start_t": a, "elapsed_s": b, "intensity": c} for a, b, c in laps]
    tag = analysis.classify_workout("running", s["t"], s["speed"], s["hr"], s["distance"], 170, lap_dicts)
    assert tag["type"] == "intervals_vo2" and "6 × 3 min" in tag["reason"]

    # Same session without workout laps (e.g. auto-lap every mile): found from the pace surges.
    tag = analysis.classify_workout("running", s["t"], s["speed"], s["hr"], s["distance"], 170, [])
    assert tag["type"] == "intervals_vo2"

    # Same reps, but at 96% of a higher threshold HR -> threshold intervals.
    tag = analysis.classify_workout("running", s["t"], s["speed"], s["hr"], s["distance"], 185, lap_dicts)
    assert tag["type"] == "intervals_threshold"



def test_run_walk_at_an_easy_heart_rate_is_an_easy_run():
    # 8 × 2 min running between walks, heart rate well inside the easy zone: structure, not effort
    samples, laps = run_walk(reps=8, run_s=120, walk_s=60, run_mps=2.6, run_hr=140, walk_hr=118)
    s = _streams(samples)
    tag = analysis.classify_workout("running", s["t"], s["speed"], s["hr"], s["distance"], 172, [])
    assert tag["type"] == "easy" and not tag["quality"] and "heart rate stayed easy" in tag["reason"]
    # the same structure with the running stretches pushed into tempo is still a fartlek
    samples, laps = run_walk(reps=8, run_s=120, walk_s=60, run_mps=3.6, run_hr=160, walk_hr=130)
    s = _streams(samples)
    tag = analysis.classify_workout("running", s["t"], s["speed"], s["hr"], s["distance"], 172, [])
    assert tag["type"] == "fartlek" and tag["quality"]


def test_walk_share_marks_run_walk():
    samples, _ = run_walk(reps=8, run_s=120, walk_s=60, run_mps=2.6, run_hr=140, walk_hr=118)
    assert analysis.walk_share(_streams(samples)["speed"]) > analysis.WALK_SHARE_MAX
    samples, _ = steady_run(minutes=40, pace_mps=2.4)  # a slow, continuous jog is still running
    assert analysis.walk_share(_streams(samples)["speed"]) == 0
