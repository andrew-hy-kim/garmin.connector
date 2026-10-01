"""Goal-based training plans, built from your recent training.

Pick a goal and the planner looks at your recent running time, how often you
run, your fitness and form, any comeback from a break, your threshold HR and
recent best efforts, then lays out a week-by-week plan. Everything is
rule-based and local; the rules follow widely used coaching practice: mostly
easy running, volume growing ~5–12% a week depending on the goal, a lighter
week every fourth week, hard days at least 48 hours apart, and no hard
sessions until you've been running consistently for about four weeks after a
break.
"""

from __future__ import annotations

import json
import math
import sqlite3
from datetime import date, timedelta
from statistics import median
from typing import Any

from . import db, insights, processing

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

GOALS = {
    "base": {
        "label": "Build aerobic base",
        "blurb": "More easy running, a longer long run, strides and hills. The foundation everything else is built on.",
        "growth": 0.10, "long_share": 0.30,
    },
    "vo2": {
        "label": "Improve VO2 max",
        "blurb": "One session a week of 2–5 minute hard reps, on top of steady easy volume.",
        "growth": 0.05, "long_share": 0.27,
    },
    "threshold": {
        "label": "Raise threshold",
        "blurb": "Longer reps at threshold effort, so you can hold a faster pace for longer (10K to half marathon).",
        "growth": 0.05, "long_share": 0.27,
    },
    "return": {
        "label": "Return from a break",
        "blurb": "Easy running only, building time gradually; strides once you're consistent. For after injury, illness or time off.",
        "growth": 0.12, "long_share": 0.28,
    },
    "maintain": {
        "label": "Maintain fitness",
        "blurb": "Hold your current volume with one quality session a week, alternating threshold and VO2 max work.",
        "growth": 0.0, "long_share": 0.27,
    },
}

# Run days for each runs-per-week, with Sunday long runs. Quality sessions go on the
# first two listed hard days. Saturday long runs shift everything a day earlier.
DAY_PATTERNS = {
    3: (["Tue", "Thu", "Sun"], ["Tue", "Thu"]),
    4: (["Tue", "Wed", "Fri", "Sun"], ["Tue", "Fri"]),
    5: (["Mon", "Tue", "Thu", "Fri", "Sun"], ["Tue", "Thu"]),
    6: (["Mon", "Tue", "Wed", "Thu", "Fri", "Sun"], ["Tue", "Thu"]),
}

WARMUP_MIN, COOLDOWN_MIN = 15, 10
VO2_SETS = [(5, 3, 2), (6, 3, 2), (5, 4, 2.5), (6, 4, 2.5), (5, 5, 3)]  # reps, minutes, jog minutes
THRESHOLD_SETS = [(3, 8, 2), (4, 8, 2), (3, 10, 2), (4, 10, 2), (2, 15, 3), (2, 20, 3)]
TEMPO_MINUTES = [15, 20, 25, 30]
HILL_SETS = [(6, 45), (8, 45), (8, 60), (10, 60)]  # reps, seconds uphill


def _r5(minutes: float) -> int:
    return max(5, int(5 * round(minutes / 5)))


def _fmt_reps(reps: int, minutes: float, jog: float) -> str:
    jog_s = f"{int(jog)} min" if jog == int(jog) else f"{int(jog)}:{int(jog % 1 * 60):02d}"
    return f"{reps} × {int(minutes)} min hard, {jog_s} easy jog between"


# ---------------------------------------------------------------- your current training

def context(conn: sqlite3.Connection, today: date | None = None) -> dict[str, Any]:
    """What the plan is based on."""
    today = today or date.today()
    runs = insights._runs(conn, (today - timedelta(days=400)).isoformat())

    def minutes(days_from: int, days_to: int) -> float:
        lo = (today - timedelta(days=days_from)).isoformat()
        hi = (today - timedelta(days=days_to)).isoformat()
        return sum((r["duration_s"] or 0) for r in runs if lo < r["date"] <= hi) / 60

    last7, prev7 = minutes(7, 0), minutes(14, 7)
    last28 = minutes(28, 0)
    runs28 = [r for r in runs if r["date"] > (today - timedelta(days=28)).isoformat()]

    # Your "normal": median weekly running time over the weeks you ran in the last year.
    weekly: dict[str, float] = {}
    for r in runs:
        d = date.fromisoformat(r["date"])
        if d > today - timedelta(days=365):
            wk = (d - timedelta(days=d.weekday())).isoformat()
            weekly[wk] = weekly.get(wk, 0) + (r["duration_s"] or 0) / 60
    typical = median(weekly.values()) if len(weekly) >= 4 else None

    settings = processing.effective_settings(conn)
    load = processing.training_load_series(conn)
    form = insights.form_state(load[-1]["fitness"], load[-1]["form"]) if load else None

    easy_speeds = [r["distance_m"] / r["duration_s"] for r in runs
                   if r["workout"] in ("easy", "long", "recovery") and r["duration_s"] and r["distance_m"]
                   and r["date"] > (today - timedelta(days=60)).isoformat()]
    return {
        "today": today.isoformat(),
        "last7_minutes": round(last7),
        "prev7_minutes": round(prev7),
        "avg_week_minutes_4wk": round(last28 / 4),
        "runs_per_week_4wk": round(len(runs28) / 4, 1),
        "typical_week_minutes": round(typical) if typical else None,
        "comeback": insights.comeback(runs, today.isoformat()),
        "fitness": round(load[-1]["fitness"]) if load else None,
        "form": form,
        "lthr": settings["lthr"],
        "lthr_source": settings["sources"]["lthr"],
        "paces": _paces(runs, today, median(easy_speeds) if easy_speeds else None),
    }


def _paces(runs, today: date, easy_mps: float | None) -> dict[str, Any]:
    """Target speeds (m/s) from your best effort of the last 4 months, via Riegel's formula.

    Threshold ≈ a bit slower than 10K race pace; VO2 max reps ≈ 5K race pace.
    Without a recent effort, sessions are described by heart rate and feel only.
    """
    recent = (today - timedelta(days=120)).isoformat()
    best = None
    for r in runs:
        if r["date"] <= recent:
            continue
        for label, e in (r["metrics"].get("best_efforts") or {}).items():
            if e["meters"] < 1600:
                continue
            # prefer the effort that predicts the fastest 10K
            t10 = e["seconds"] * (10000 / e["meters"]) ** 1.06
            if best is None or t10 < best["t10"]:
                best = {"t10": t10, "label": label, "seconds": e["seconds"], "meters": e["meters"], "date": r["date"]}
    out: dict[str, Any] = {"easy_mps": easy_mps}
    if best:
        t5 = best["seconds"] * (5000 / best["meters"]) ** 1.06
        out.update({
            "based_on": f"your {best['label']} on {date.fromisoformat(best['date']):%b %-d}",
            "vo2_mps": 5000 / t5,
            "threshold_mps": 10000 / best["t10"] / 1.03,
            "tempo_mps": 10000 / best["t10"] / 1.08,
        })
    return out


# ---------------------------------------------------------------- the plan

def generate(conn: sqlite3.Connection, goal: str, weeks: int = 6, runs_per_week: int | None = None,
             long_day: str = "Sun", start: date | None = None, today: date | None = None) -> dict[str, Any]:
    if goal not in GOALS:
        raise ValueError(f"Unknown goal: {goal}")
    ctx = context(conn, today)
    today = date.fromisoformat(ctx["today"])
    spec = GOALS[goal]
    weeks = max(2, min(int(weeks), 16))
    if not runs_per_week:
        runs_per_week = round(ctx["runs_per_week_4wk"]) or 3
    runs_per_week = max(3, min(int(runs_per_week), 6))
    # Plans start on a Monday: this week if it's early in the week, otherwise next week.
    if start is None:
        start = today - timedelta(days=today.weekday())
        if today.weekday() >= 2:
            start += timedelta(days=7)

    back = ctx["comeback"]
    notes: list[str] = []

    # Where volume starts. Use the last week if you're mid-comeback (it's the most honest),
    # otherwise a blend of the last two weeks.
    if back:
        base_min = ctx["last7_minutes"]
    else:
        base_min = (ctx["last7_minutes"] + ctx["prev7_minutes"]) / 2
    floor = 60 if goal == "return" or back else 90
    base_min = max(base_min, floor)
    typical = ctx["typical_week_minutes"]
    cap = base_min * 1.35
    if goal == "return":
        cap = max(base_min, (typical or base_min * 2) * 0.9)
    elif typical:
        cap = max(cap, typical * 1.1 if goal == "base" else typical)

    if ctx["form"] and ctx["form"]["key"] == "overreaching":
        notes.append("You're carrying a lot of fatigue, so week 1 starts lighter and without hard sessions.")

    # After a break, no hard sessions until ~4 weeks of consistent running.
    rebuild_weeks = 0
    if back and goal != "return":
        rebuild_weeks = min(weeks - 1, math.ceil(max(0, 28 - back["days_back"]) / 7))
        if rebuild_weeks:
            notes.append(f"You're {back['days_back']} days into a comeback, so the first {rebuild_weeks} "
                         f"week{'s' if rebuild_weeks > 1 else ''} rebuild easy volume before any hard sessions.")
    if goal == "return" and not back:
        notes.append("No recent break detected; this plan still builds gradually with easy running only.")

    days_all, hard_days = DAY_PATTERNS[runs_per_week]
    shift = -1 if long_day == "Sat" else 0

    def day(name: str) -> str:
        return DAYS[(DAYS.index(name) + shift) % 7]

    plan_weeks = []
    volume = base_min
    quality_index = 0
    for i in range(weeks):
        recovery = (i + 1) % 4 == 0 and weeks > 4 or (i == weeks - 1 and weeks >= 6 and goal != "return")
        if i == 0 and ctx["form"] and ctx["form"]["key"] == "overreaching":
            target = base_min * 0.8
        elif recovery:
            target = volume * 0.8
        else:
            # Grow from the previous normal week; after a light first week, return to your usual volume first.
            after_light_start = i == 1 and ctx["form"] and ctx["form"]["key"] == "overreaching"
            grow = i > 0 and not after_light_start
            volume = min(cap, volume * (1 + spec["growth"])) if grow else min(cap, volume)
            target = volume
        rebuilding = goal == "return" or i < rebuild_weeks
        light_start = i == 0 and ctx["form"] and ctx["form"]["key"] == "overreaching"

        # quality sessions for this week
        sessions: list[dict[str, Any]] = []
        if not rebuilding and not light_start:
            sessions = _quality_sessions(goal, quality_index, recovery, runs_per_week)
            if not recovery:
                quality_index += 1

        plan_weeks.append(_layout_week(
            goal, i, start + timedelta(days=7 * i), target, spec, sessions, days_all, hard_days, day, ctx,
            recovery=recovery, rebuilding=rebuilding, strides=_strides(goal, i, rebuilding, rebuild_weeks),
        ))

    return {
        "goal": goal,
        "goal_label": spec["label"],
        "goal_blurb": spec["blurb"],
        "created": today.isoformat(),
        "start": start.isoformat(),
        "params": {"weeks": weeks, "runs_per_week": runs_per_week, "long_day": long_day},
        "context": ctx,
        "notes": notes,
        "guidance": _guidance(goal, ctx),
        "weeks": plan_weeks,
    }


def _strides(goal: str, week: int, rebuilding: bool, rebuild_weeks: int) -> int:
    """How many easy runs get strides this week."""
    if goal == "return":
        return 1 if week >= 2 else 0
    if rebuilding:
        return 1 if week == rebuild_weeks - 1 else 0
    return 2 if goal == "base" else 1


def _quality_sessions(goal: str, k: int, recovery: bool, runs_per_week: int) -> list[dict[str, Any]]:
    def vo2():
        reps, mins, jog = (6, 2, 2) if recovery else VO2_SETS[min(k, len(VO2_SETS) - 1)]
        return {"type": "vo2", "title": "VO2 max intervals", "main": _fmt_reps(reps, mins, jog),
                "main_minutes": reps * mins + (reps - 1) * jog}

    def threshold():
        reps, mins, jog = (3, 6, 2) if recovery else THRESHOLD_SETS[min(k, len(THRESHOLD_SETS) - 1)]
        return {"type": "threshold", "title": "Threshold intervals",
                "main": _fmt_reps(reps, mins, jog).replace("hard", "at threshold"),
                "main_minutes": reps * mins + (reps - 1) * jog}

    def tempo(level: int):
        mins = TEMPO_MINUTES[min(level, len(TEMPO_MINUTES) - 1)]
        return {"type": "tempo", "title": "Tempo run", "main": f"{mins} min steady at tempo effort",
                "main_minutes": mins}

    def hills():
        reps, secs = HILL_SETS[min(k, len(HILL_SETS) - 1)]
        return {"type": "hills", "title": "Hill repeats",
                "main": f"{reps} × {secs} s uphill at a strong effort, walk or jog back down",
                "main_minutes": reps * secs * 2 / 60}

    if goal == "base":
        if recovery:
            return []
        return [hills()] if k % 2 == 0 else [tempo(k // 2)]
    if goal == "vo2":
        out = [vo2()]
        if runs_per_week >= 5 and not recovery:
            out.append(tempo(k))
        return out
    if goal == "threshold":
        out = [threshold()]
        if runs_per_week >= 5 and not recovery:
            out.append(tempo(k))
        return out
    if goal == "maintain":
        return [threshold() if k % 2 == 0 else vo2()]
    return []


def _layout_week(goal, i, monday, target, spec, sessions, days_all, hard_days, day, ctx, *, recovery, rebuilding,
                 strides) -> dict[str, Any]:
    lthr = ctx["lthr"]
    paces = ctx["paces"]
    long_name = day("Sun")
    run_days = [day(d) for d in days_all]
    quality_days = [day(d) for d in hard_days][:len(sessions)]
    easy_days = [d for d in run_days if d != long_name and d not in quality_days]

    q_total = sum(WARMUP_MIN + s["main_minutes"] + COOLDOWN_MIN for s in sessions)
    long_min = min(150, max(30 if not rebuilding else 25, target * spec["long_share"]))
    easy_each = max(20, (target - q_total - long_min) / max(1, len(easy_days)))
    long_min = max(long_min, easy_each * 1.25)

    easy_hr = round(0.89 * lthr)
    plan_days = []
    strides_left = strides
    for d in DAYS:
        if d == long_name:
            plan_days.append({
                "day": d, "type": "long", "title": "Long run", "minutes": _r5(long_min),
                "details": "Easy and conversational the whole way. It's fine if HR drifts up in the last 15 minutes.",
                "hr": f"under {easy_hr} bpm", "speed": paces.get("easy_mps"),
            })
        elif d in quality_days:
            s = sessions[quality_days.index(d)]
            speed_key = {"vo2": "vo2_mps", "threshold": "threshold_mps", "tempo": "tempo_mps"}.get(s["type"])
            hr = {"vo2": f"reaching {round(lthr)}+ bpm by the end of each rep",
                  "threshold": f"{round(0.95 * lthr)}–{round(lthr)} bpm",
                  "tempo": f"{round(0.90 * lthr)}–{round(0.94 * lthr)} bpm",
                  "hills": "hard but controlled; HR will lag on short hills"}[s["type"]]
            plan_days.append({
                "day": d, "type": s["type"], "title": s["title"],
                "minutes": _r5(WARMUP_MIN + s["main_minutes"] + COOLDOWN_MIN),
                "details": f"{WARMUP_MIN} min easy, then {s['main']}, then {COOLDOWN_MIN} min easy.",
                "hr": hr, "speed": paces.get(speed_key) if speed_key else None,
            })
        elif d in easy_days:
            extra = ""
            if strides_left:
                extra = " Finish with 6 × 20 s strides (quick and relaxed, full recovery between)."
                strides_left -= 1
            detail = ("Easy and conversational. Run/walk is fine if you need it." if rebuilding
                      else "Easy and conversational.")
            plan_days.append({
                "day": d, "type": "easy", "title": "Easy run" + (" + strides" if extra else ""),
                "minutes": _r5(easy_each), "details": detail + extra,
                "hr": f"under {easy_hr} bpm", "speed": paces.get("easy_mps"),
            })
        else:
            plan_days.append({"day": d, "type": "rest", "title": "Rest or cross-train", "minutes": 0,
                              "details": "Off, or easy cross-training (bike, swim, strength).", "hr": None, "speed": None})

    focus = ("Recovery week: less volume so the training sinks in" if recovery
             else "Rebuild: easy running only" if rebuilding
             else {"base": "Build easy volume", "vo2": "VO2 max session + easy volume",
                   "threshold": "Threshold session + easy volume", "maintain": "Hold volume, one quality session",
                   "return": "Easy running only"}[goal])
    return {
        "week": i + 1,
        "start": monday.isoformat(),
        "focus": focus,
        "recovery": recovery,
        "minutes": sum(d["minutes"] for d in plan_days),
        "quality": len(sessions),
        "days": plan_days,
    }


def _guidance(goal: str, ctx: dict[str, Any]) -> list[str]:
    easy_hr = round(0.89 * ctx["lthr"])
    tips = [f"Easy means under about {easy_hr} bpm (below 90% of your threshold HR of {round(ctx['lthr'])}). "
            f"Most of your running should feel like you could hold a conversation."]
    if ctx["lthr_source"] == "estimated":
        tips.append("Your threshold HR is estimated (90% of max). Setting it in Garmin or on the dashboard makes "
                    "these targets more accurate.")
    tips.append({
        "base": "The long run and total easy time drive aerobic gains. If you're short on time, cut a weekday run "
                "rather than the long run.",
        "vo2": "VO2 max reps should feel hard but repeatable: the last rep about as fast as the first. "
               "If you can't hold pace, stop the session there.",
        "threshold": "Threshold effort is 'comfortably hard': you could hold it for about an hour in a race. "
                     "Finishing a rep and feeling you could do one more is right.",
        "return": "If the old problem flares up during a run, stop and walk. Repeat the previous week rather "
                  "than pushing on.",
        "maintain": "Keeping one quality session and your long run holds most of your fitness on less time.",
    }[goal])
    tips.append("Move days around to fit your week, but keep hard days at least 48 hours apart and don't "
                "put a hard session the day before the long run.")
    return tips


# ---------------------------------------------------------------- saved plan & progress

def save(conn: sqlite3.Connection, plan: dict[str, Any]) -> None:
    db.set_text_setting(conn, "plan", json.dumps(plan))
    _forget_plan_reviews(conn)


def _forget_plan_reviews(conn: sqlite3.Connection) -> None:
    """A saved Claude review of the old plan no longer applies."""
    conn.execute("DELETE FROM ai_reviews WHERE key LIKE 'plan:%'")
    conn.commit()


def load(conn: sqlite3.Connection) -> dict[str, Any] | None:
    raw = db.get_text_setting(conn, "plan")
    return json.loads(raw) if raw else None


def delete(conn: sqlite3.Connection) -> None:
    db.set_text_setting(conn, "plan", None)
    _forget_plan_reviews(conn)


def progress(conn: sqlite3.Connection, plan: dict[str, Any], today: date | None = None) -> list[dict[str, Any]]:
    """Planned vs. done for each week of the plan."""
    today = today or date.today()
    runs = insights._runs(conn, plan["start"])
    out = []
    for w in plan["weeks"]:
        start = date.fromisoformat(w["start"])
        end = start + timedelta(days=7)
        done = [r for r in runs if start.isoformat() <= r["date"] < end.isoformat()]
        status = "upcoming" if today < start else "current" if today < end else "past"
        out.append({
            "week": w["week"],
            "status": status,
            "planned_minutes": w["minutes"],
            "done_minutes": round(sum((r["duration_s"] or 0) for r in done) / 60),
            "planned_runs": sum(1 for d in w["days"] if d["type"] != "rest"),
            "done_runs": len(done),
            "planned_quality": w["quality"],
            "done_quality": sum(1 for r in done if (r["metrics"].get("workout") or {}).get("quality")),
            "runs": [{"activity_id": r["activity_id"], "date": r["date"],
                      "label": (r["metrics"].get("workout") or {}).get("label"),
                      "minutes": round((r["duration_s"] or 0) / 60)} for r in done],
        })
    return out
