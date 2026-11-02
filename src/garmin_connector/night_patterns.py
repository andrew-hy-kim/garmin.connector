"""What your nights say, from your own history: does a poor night change your runs, how long each
kind of workout takes to recover from, and whether bedtime moves your sleep score.

Each finding comes with a sentence ready to show, and says plainly when there's no clear
difference: a result is only called clear when the gap is more than twice its standard error,
and every group needs a minimum number of runs or nights before anything is said at all.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import date, timedelta
from statistics import mean, median, stdev
from typing import Any

from . import analysis, overnight

EASY = {"easy", "recovery", "long", "easy_strides"}
HOT_PCT = 3            # hot or humid runs are left out (heat lowers efficiency on its own)
SHORT_NIGHT_S = 6.5 * 3600
MIN_RUNS = 8           # per group, before comparing runs after poor and normal nights
MIN_SESSIONS = 5       # per kind of workout, before saying how long it takes to recover from
MIN_NIGHTS = 30        # per side of a bedtime, before comparing sleep scores
DIP = 0.03             # an HRV change smaller than this is "barely moves"
KINDS = [  # (label, workout types)
    ("Intervals", {"intervals_vo2", "speed", "intervals_threshold", "fartlek"}),
    ("Tempo & threshold", {"tempo", "threshold", "progression"}),
    ("Long runs", {"long"}),
    ("Races", {"race"}),
]


def _plus(d: str, days: int) -> str:
    return (date.fromisoformat(d) + timedelta(days=days)).isoformat()


def _clear(a: list[float], b: list[float]) -> tuple[float, bool]:
    """Difference of means, and whether it's more than twice its standard error."""
    diff = mean(a) - mean(b)
    se = (stdev(a) ** 2 / len(a) + stdev(b) ** 2 / len(b)) ** 0.5
    return diff, abs(diff) > 2 * se


def _runs(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT a.start_time_local, m.efficiency, m.cadence_lock, m.data, w.data AS weather "
        "FROM activities a JOIN activity_metrics m USING (activity_id) LEFT JOIN weather w USING (activity_id) "
        "WHERE a.activity_type LIKE '%run%' ORDER BY a.start_time_local").fetchall()
    out = []
    for r in rows:
        m, w = json.loads(r["data"]), json.loads(r["weather"]) if r["weather"] else {}
        workout = m.get("workout") or {}
        out.append({"date": r["start_time_local"][:10], "time": r["start_time_local"][11:16], "efficiency": r["efficiency"],
                    "steady": (r["cadence_lock"] or 0) < 0.2 and (m.get("walk_share") or 0) <= analysis.WALK_SHARE_MAX
                    and (w.get("heat_pct") or 0) < HOT_PCT,
                    "type": workout.get("type"), "quality": bool(workout.get("quality"))})
    return out


# ---------------------------------------------------------------- 1. poor nights and your runs

def sleep_and_runs(runs: list[dict[str, Any]], nights: dict[str, dict]) -> list[dict[str, Any]]:
    """Easy-run efficiency after short nights and low-HRV nights, against your other easy runs.
    Efficiency is taken relative to your easy runs within a month either side, so fitness
    changing over the years doesn't count as a sleep effect."""
    easy = [r for r in runs if r["type"] in EASY and r["efficiency"] and r["steady"]]
    days = [date.fromisoformat(r["date"]) for r in easy]
    rel = []
    for i, r in enumerate(easy):
        n = nights.get(r["date"])
        if not n or (n["wake_time"] and r["time"] < n["wake_time"]):
            continue  # no night recorded, or the run was before you woke
        around = [x["efficiency"] for j, x in enumerate(easy) if j != i and abs((days[j] - days[i]).days) <= 30]
        if len(around) >= 5:
            rel.append((n, (r["efficiency"] / median(around) - 1) * 100))
    out = []
    for key, label, poor in (
        ("short", "short nights (under 6.5 hours)", lambda n: n["sleep_s"] < SHORT_NIGHT_S),
        ("low_hrv", "nights with HRV below your normal range",
         lambda n: bool(n["hrv"] and n["hrv_low"] and n["hrv"] < n["hrv_low"])),
    ):
        judged = [(n, v) for n, v in rel if key == "short" or (n["hrv"] and n["hrv_low"])]
        a = [v for n, v in judged if poor(n)]
        b = [v for n, v in judged if not poor(n)]
        if len(a) < MIN_RUNS or len(b) < MIN_RUNS:
            continue
        diff, clear = _clear(a, b)
        if clear and diff < 0:
            text = f"After {label}, your easy runs cover {-diff:.0f}% less distance per heartbeat ({len(a)} runs)."
        elif clear:
            text = f"No sign {label} hold you back: easy runs after them were, if anything, {diff:.0f}% more efficient ({len(a)} runs)."
        else:
            text = f"No clear effect: easy runs after {label} were about as efficient as your others ({len(a)} runs)."
        out.append({"key": key, "runs": len(a), "other_runs": len(b), "diff_pct": round(diff, 1), "clear": clear, "text": text})
    return out


# ---------------------------------------------------------------- 2. recovery by kind of workout

def recovery_by_kind(runs: list[dict[str, Any]], nights: dict[str, dict]) -> list[dict[str, Any]]:
    """HRV and resting HR on the three nights after each kind of hard session, against your
    two weeks before it. A night after another hard session is left out: it can't say how
    long the first one took."""
    hard_days = {r["date"] for r in runs if r["quality"] or r["type"] == "long"}
    out = []
    for label, types in KINDS:
        hrv: dict[int, list[float]] = {1: [], 2: [], 3: []}
        rhr: dict[int, list[float]] = {1: [], 2: [], 3: []}
        sessions = 0
        for r in runs:
            if r["type"] not in types:
                continue
            before = [nights[d] for d in (_plus(r["date"], -k) for k in range(14)) if d in nights and nights[d]["hrv"]]
            after1 = nights.get(_plus(r["date"], 1))
            if len(before) < 4 or not (after1 and after1["hrv"]):
                continue
            base_hrv = median(b["hrv"] for b in before)
            base_rhr = median([b["resting_hr"] for b in before if b["resting_hr"]] or [0])
            sessions += 1
            for k in (1, 2, 3):
                if k > 1 and any(_plus(r["date"], j) in hard_days for j in range(1, k)):
                    break
                n = nights.get(_plus(r["date"], k))
                if n and n["hrv"]:
                    hrv[k].append(n["hrv"] / base_hrv - 1)
                    if n["resting_hr"] and base_rhr:
                        rhr[k].append(n["resting_hr"] - base_rhr)
        if sessions < MIN_SESSIONS:
            continue
        dips = {k: mean(v) for k, v in hrv.items() if len(v) >= MIN_SESSIONS}
        rhr_up = {k: mean(v) for k, v in rhr.items() if len(v) >= MIN_SESSIONS}
        first = dips.get(1, 0)
        what = "sessions" if label in ("Intervals", "Tempo & threshold") else label.lower()
        if first > -DIP:
            text = f"{label}: HRV barely moves the night after ({sessions} {what})."
            back = 1
        else:
            back = next((k for k in (2, 3) if k in dips and dips[k] > -DIP), None)
            text = (f"{label}: HRV dips {-first:.0%} the night after, back to normal by night {back} ({sessions} {what})."
                    if back else f"{label}: HRV dips {-first:.0%} the night after and is still down on night 3 ({sessions} {what}).")
        out.append({"kind": label, "sessions": sessions, "hrv_change_pct": {k: round(v * 100, 1) for k, v in dips.items()},
                    "resting_hr_change": {k: round(v, 1) for k, v in rhr_up.items()}, "back_to_normal_night": back,
                    "text": text})
    return out


# ---------------------------------------------------------------- 3. bedtime and sleep score

def _minutes(clock: str) -> int:
    """Minutes after 6 p.m., so a bedtime past midnight sorts after one before it."""
    return (int(clock[:2]) * 60 + int(clock[3:]) - 18 * 60) % 1440


def _clock(minutes: int) -> str:
    h, m = divmod((minutes + 18 * 60) % 1440, 60)
    return f"{(h - 1) % 12 + 1}:{m:02d} {'a.m.' if h < 12 else 'p.m.'}"


def bedtime(nights: dict[str, dict]) -> dict[str, Any] | None:
    """The bedtime that splits your sleep scores most clearly (on the half hour, 10 p.m. to 2 a.m.)."""
    pairs = [(_minutes(n["bedtime"]), n["sleep_score"]) for n in nights.values() if n["bedtime"] and n["sleep_score"]]
    best = None
    for cut in range(4 * 60, 8 * 60 + 1, 30):  # 10 p.m. .. 2 a.m.
        a = [s for b, s in pairs if b < cut]
        b_ = [s for b, s in pairs if b >= cut]
        if len(a) < MIN_NIGHTS or len(b_) < MIN_NIGHTS:
            continue
        diff, clear = _clear(a, b_)
        if best is None or (clear, diff) > (best["clear"], best["diff"]):
            best = {"cut": cut, "diff": diff, "clear": clear, "a": a, "b": b_}
    if best is None:
        return None
    a, b_, when = best["a"], best["b"], _clock(best["cut"])
    if best["clear"] and best["diff"] >= 2:
        text = (f"Asleep before {when}: sleep score {mean(a):.0f} on average, against {mean(b_):.0f} "
                f"when later ({len(a)} and {len(b_)} nights).")
    else:
        text = "Bedtime makes little difference to your sleep score."
    return {"before": when, "score_before": round(mean(a), 1), "score_after": round(mean(b_), 1),
            "nights_before": len(a), "nights_after": len(b_), "clear": best["clear"] and best["diff"] >= 2, "text": text}


# ---------------------------------------------------------------- all of it

def patterns(conn: sqlite3.Connection) -> dict[str, Any] | None:
    overnight.ensure(conn)
    nights = {r["date"]: dict(r) for r in conn.execute("SELECT * FROM nights")}
    if not nights:
        return None
    runs = _runs(conn)
    found = {"sleep_and_runs": sleep_and_runs(runs, nights), "recovery": recovery_by_kind(runs, nights),
             "bedtime": bedtime(nights)}
    return found if any(found.values()) else None
