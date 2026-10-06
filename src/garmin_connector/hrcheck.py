"""`garmin hr-check`: your running heart rate year by year, to tell real fitness change from
sensor trouble.

For each year of runs: how hard your heart worked at one fixed pace (the fairest fitness
comparison across years), your average heart rate and pace, the highest 30-second heart rate,
effective VO2max, and two signs of a misreading wrist sensor: heart rate locked onto your step
rate, and spikes (readings far from the seconds around them).
"""

from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from statistics import median
from typing import Any

from . import analysis, apple, db, performance

LOCKED = 0.2       # cadence lock above this: the run's heart rate is suspect
SPIKY = 0.05       # more than this share of readings were spikes


def _hr_at(rows: list[list[float]], mps: float, width: float = 0.15) -> tuple[float, float]:
    """(heart-rate seconds, seconds) of steady running within ``width`` m/s of ``mps``."""
    hs = secs = 0.0
    for speed, hr, s in rows:
        if abs(speed - mps) <= width:
            hs += hr * s
            secs += s
    return hs, secs


def report(conn: sqlite3.Connection) -> dict[str, Any]:
    perf = performance.summary(conn)["per_activity"]
    runs = conn.execute(
        "SELECT a.activity_id, substr(a.start_time_local, 1, 4) AS year, a.avg_hr, a.distance_m, "
        "coalesce(a.moving_duration_s, a.duration_s), m.cadence_lock, m.max_hr_30s, "
        "json_extract(m.data, '$.hr_by_speed') "
        "FROM activities a JOIN activity_metrics m USING (activity_id) "
        "WHERE a.activity_type LIKE '%run%' AND a.avg_hr IS NOT NULL ORDER BY a.start_time_local").fetchall()
    # one pace to compare every year at: the steady pace with the most running in the year with the least
    by_year_speed: dict[str, dict[float, float]] = defaultdict(lambda: defaultdict(float))
    for aid, year, *_, hbs in runs:
        for speed, _, s in json.loads(hbs or "[]"):
            by_year_speed[year][round(speed, 1)] += s
    speeds = {s for v in by_year_speed.values() for s in v}
    with_data = [y for y, v in by_year_speed.items() if v]
    ref = max(speeds, key=lambda s: (min(by_year_speed[y].get(s, 0) for y in with_data),
                                     sum(by_year_speed[y].get(s, 0) for y in with_data))) if speeds else None
    years: dict[str, dict[str, Any]] = {}
    for aid, year, avg_hr, meters, secs, lock, max30, hbs in runs:
        y = years.setdefault(year, {"runs": 0, "apple": 0, "hr_t": 0.0, "t": 0.0, "m": 0.0, "max30": [], "vo2": [],
                                    "locked": 0, "spiky": 0, "ref_hs": 0.0, "ref_s": 0.0})
        y["runs"] += 1
        y["apple"] += apple.is_apple(aid)
        if secs:
            y["hr_t"] += avg_hr * secs
            y["t"] += secs
            y["m"] += meters or 0
        if max30:
            y["max30"].append(max30)
        if perf.get(str(aid)):
            y["vo2"].append(perf[str(aid)])
        if (lock or 0) > LOCKED:
            y["locked"] += 1
        if ref is not None:
            hs, s = _hr_at(json.loads(hbs or "[]"), ref)
            y["ref_hs"] += hs
            y["ref_s"] += s
        loaded = db.load_streams(conn, aid)
        if loaded:
            hr = loaded[0]["hr"]
            cleaned = analysis.clean_hr(hr)
            n = sum(v is not None for v in hr)
            changed = sum(1 for a, b in zip(hr, cleaned) if a is not None and b is not None and abs(a - b) > 0.5)
            if n and changed / n > SPIKY:
                y["spiky"] += 1
    out = []
    for year, y in sorted(years.items()):
        out.append({
            "year": year, "runs": y["runs"], "apple": y["apple"],
            "avg_hr": round(y["hr_t"] / y["t"]) if y["t"] else None,
            "pace_mps": y["m"] / y["t"] if y["t"] else None,
            "hr_at_ref": round(y["ref_hs"] / y["ref_s"]) if y["ref_s"] >= 600 else None,
            "max30": round(max(y["max30"])) if y["max30"] else None,
            "max30_typical": round(median(y["max30"])) if y["max30"] else None,
            "vo2": round(median(y["vo2"]), 1) if y["vo2"] else None,
            "locked": y["locked"], "spiky": y["spiky"],
        })
    return {"ref_mps": ref, "years": out}


def _pace(mps: float | None, unit: str) -> str:
    if not mps:
        return "–"
    s = (1609.344 if unit == "mi" else 1000) / mps
    return f"{int(s // 60)}:{int(s % 60):02d}"


def print_report(conn: sqlite3.Connection, unit: str = "mi") -> None:
    r = report(conn)
    if not r["years"]:
        print("No runs with heart rate yet.")
        return
    ref = _pace(r["ref_mps"], unit) + f" /{unit}" if r["ref_mps"] else "–"
    print(f"Heart rate by year (runs with heart rate). 'HR @ {ref}' is your settled heart rate when running")
    print("steadily at that pace: the fairest comparison between years, as it doesn't depend on how hard you ran.\n")
    head = f"{'Year':<6}{'Runs':>5}{'Apple':>6}{'Avg HR':>8}{'Pace':>7}{'HR @ ' + _pace(r['ref_mps'], unit):>11}" \
           f"{'Max 30s':>9}{'Typ. max':>10}{'VO2max':>8}{'Locked':>8}{'Spiky':>7}"
    print(head)
    print("-" * len(head))
    for y in r["years"]:
        f = lambda v: "–" if v is None else str(v)  # noqa: E731
        print(f"{y['year']:<6}{y['runs']:>5}{y['apple']:>6}{f(y['avg_hr']):>8}{_pace(y['pace_mps'], unit):>7}"
              f"{f(y['hr_at_ref']):>11}{f(y['max30']):>9}{f(y['max30_typical']):>10}{f(y['vo2']):>8}"
              f"{y['locked']:>8}{y['spiky']:>7}")
    print("\nMax 30s: highest 30-second heart rate that year; Typ. max: a typical run's highest.")
    print(f"Locked: runs where heart rate sat on your step rate over {LOCKED:.0%} of the time (sensor misreading).")
    print(f"Spiky: runs where over {SPIKY:.0%} of readings jumped far from the seconds around them.")
