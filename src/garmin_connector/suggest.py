"""Suggested next workouts, for the coach notes.

With a training plan running, these are simply its next sessions. Without one,
they come from your own history: the days you usually run, your usual long-run
day and lengths, the kinds of hard sessions you do (rotated and progressed),
your current form and any comeback from a break. The same rules as the planner
apply: mostly easy running, hard days at least 48 hours apart, never the day
before the long run, and no hard sessions early in a comeback or while
overreaching.
"""

from __future__ import annotations

import sqlite3
from collections import Counter
from datetime import date, timedelta
from statistics import median
from typing import Any

from . import health, insights, planner

DAYS = planner.DAYS
HISTORY_DAYS = 56          # what "usually" means: the last 8 weeks
MAX_COUNT = 7
LOOKAHEAD_DAYS = 28

# Your workout tags -> the planner's session kinds
KIND_OF = {
    "intervals_vo2": "vo2", "speed": "vo2", "fartlek": "vo2",
    "intervals_threshold": "threshold", "threshold": "threshold",
    "tempo": "tempo", "progression": "tempo",
}
KIND_LABEL = {"vo2": "VO2 max session", "threshold": "threshold session", "tempo": "tempo run", "hills": "hill session"}


def _session(kind: str, k: int, lthr: float, paces: dict[str, Any]) -> dict[str, Any]:
    """A hard session in the planner's format, progressed by how many of this kind you've done lately."""
    if kind == "vo2":
        reps, mins, jog = planner.VO2_SETS[min(k, len(planner.VO2_SETS) - 1)]
        title, main, main_min = "VO2 max intervals", planner._fmt_reps(reps, mins, jog), reps * mins + (reps - 1) * jog
        hr, speed = f"reaching {round(lthr)}+ bpm by the end of each rep", paces.get("vo2_mps")
    elif kind == "threshold":
        reps, mins, jog = planner.THRESHOLD_SETS[min(k, len(planner.THRESHOLD_SETS) - 1)]
        title = "Threshold intervals"
        main = planner._fmt_reps(reps, mins, jog).replace("hard", "at threshold")
        main_min = reps * mins + (reps - 1) * jog
        hr, speed = f"{round(0.95 * lthr)}–{round(lthr)} bpm", paces.get("threshold_mps")
    elif kind == "hills":
        reps, secs = planner.HILL_SETS[min(k, len(planner.HILL_SETS) - 1)]
        title, main, main_min = "Hill repeats", f"{reps} × {secs} s uphill at a strong effort, walk or jog back down", reps * secs * 2 / 60
        hr, speed = "hard but controlled; HR will lag on short hills", None
    else:
        mins = planner.TEMPO_MINUTES[min(k, len(planner.TEMPO_MINUTES) - 1)]
        title, main, main_min = "Tempo run", f"{mins} min steady at tempo effort", mins
        hr, speed = f"{round(0.90 * lthr)}–{round(0.94 * lthr)} bpm", paces.get("tempo_mps")
    return {
        "type": kind, "title": title,
        "minutes": planner._r5(planner.WARMUP_MIN + main_min + planner.COOLDOWN_MIN),
        "details": f"{planner.WARMUP_MIN} min easy, then {main}, then {planner.COOLDOWN_MIN} min easy.",
        "hr": hr, "speed": speed,
    }


def _from_plan(plan: dict[str, Any], today: date, ran_today: bool, count: int) -> list[dict[str, Any]]:
    out = []
    for w in plan["weeks"]:
        start = date.fromisoformat(w["start"])
        for k, d in enumerate(w["days"]):
            day = start + timedelta(days=k)
            if d["type"] == "rest" or day < today or (day == today and ran_today):
                continue
            out.append({**d, "date": day.isoformat(), "day": DAYS[day.weekday()],
                        "why": f"Week {w['week']} of your plan · {w['focus']}."})
    return out[:count]


def suggest(conn: sqlite3.Connection, count: int = MAX_COUNT, today: date | None = None) -> dict[str, Any]:
    """Your next `count` workouts, dated, with a reason for each."""
    today = today or date.today()
    count = max(1, min(count, MAX_COUNT))
    runs = insights._runs(conn, (today - timedelta(days=HISTORY_DAYS)).isoformat())
    runs = [r for r in runs if r["date"] <= today.isoformat()]
    ran_today = any(r["date"] == today.isoformat() for r in runs)

    plan = planner.load(conn)
    if plan:
        planned = _from_plan(plan, today, ran_today, count)
        if planned:
            return {"source": "plan", "basis": f"Your next sessions from your plan: {plan['goal_label']}.",
                    "workouts": planned}

    if len(runs) < 4:
        return {"source": "none", "basis": "Suggestions appear once a few weeks of runs are synced.", "workouts": []}

    ctx = planner.context(conn, today)
    lthr, paces = ctx["lthr"], ctx["paces"]
    easy_hr = round(0.89 * lthr)

    # --- your usual week, from the last 8 weeks
    by_week: dict[str, list[dict[str, Any]]] = {}
    for r in runs:
        d = date.fromisoformat(r["date"])
        by_week.setdefault((d - timedelta(days=d.weekday())).isoformat(), []).append(r)
    # runs a week over the last 4 full weeks (empty weeks count as zero)
    this_monday = today - timedelta(days=today.weekday())
    recent_weeks = [(this_monday - timedelta(days=7 * i)).isoformat() for i in range(1, 5)]
    per_week = round(sum(len({r["date"] for r in by_week.get(w, [])}) for w in recent_weeks) / 4)
    runs_per_week = max(2, min(6, per_week))
    day_freq = Counter(DAYS[date.fromisoformat(r["date"]).weekday()] for r in {r["date"]: r for r in runs}.values())
    # long run: the weekday your longest run of the week usually falls on
    long_days = Counter(DAYS[date.fromisoformat(max(by_week[w], key=lambda r: r["duration_s"] or 0)["date"]).weekday()]
                        for w in by_week)
    long_day = long_days.most_common(1)[0][0]
    run_days = [long_day] + [d for d, _ in day_freq.most_common() if d != long_day]
    run_days = set(run_days[:runs_per_week])
    while len(run_days) < runs_per_week:  # fill gaps evenly if your history is patchy
        for d in ("Tue", "Thu", "Sat", "Mon", "Wed", "Fri", "Sun"):
            if len(run_days) < runs_per_week:
                run_days.add(d)

    easy_runs = [r for r in runs if r["workout"] in ("easy", "recovery", "easy_strides") and r["duration_s"]]
    easy_min = planner._r5(median([r["duration_s"] / 60 for r in easy_runs])) if easy_runs else 40
    longest = [max((r["duration_s"] or 0) for r in by_week[w]) / 60 for w in by_week]
    long_min = planner._r5(max(easy_min * 1.25, median(longest))) if longest else planner._r5(easy_min * 1.5)

    # --- hard sessions: how many you do, which kinds, and when the last one was
    quality = [r for r in runs if (r["metrics"].get("workout") or {}).get("quality")]
    kinds_done = [KIND_OF.get(r["workout"]) for r in quality if KIND_OF.get(r["workout"])]
    q_per_week = len(quality) / max(1, len(by_week))
    back = ctx["comeback"]
    form = (ctx["form"] or {}).get("key")
    # resting HR or HRV off your normal: the next two days stay easy, whatever the load says
    recovery = health.summary(conn, today)
    strained = bool(recovery and recovery["flags"])
    rebuilding = bool(back and back["days_back"] < 28)
    if rebuilding or runs_per_week < 3:
        q_budget = 0
    elif q_per_week >= 1.5 and runs_per_week >= 5:
        q_budget = 2  # you already do two a week and run often enough to absorb them; never more
    else:
        q_budget = 1
    # the weekdays you usually do them on, so suggestions fit your routine
    q_days = [d for d, _ in Counter(DAYS[date.fromisoformat(r["date"]).weekday()] for r in quality).most_common()
              if d != long_day][:q_budget]
    for d in q_days:
        if d not in run_days:  # swap out your least-used easy day
            spare = sorted((x for x in run_days if x != long_day and x not in q_days), key=lambda x: day_freq[x])
            if spare:
                run_days.discard(spare[0])
            run_days.add(d)
    last_hard = max((date.fromisoformat(r["date"]) for r in quality), default=None)
    rotation = [k for k in ("tempo", "threshold", "vo2") if k in kinds_done] or ["tempo", "threshold", "vo2"]
    # start with the kind you've done least recently
    last_seen = {k: max((r["date"] for r in quality if KIND_OF.get(r["workout"]) == k), default="") for k in rotation}
    rotation.sort(key=lambda k: last_seen[k])
    done_count = Counter(kinds_done)

    basis = [f"Built from your last 8 weeks: about {runs_per_week} runs a week, easy runs around {easy_min} min "
             f"and a {long_min}-min long run on {_day_name(long_day)}s."]
    if rebuilding:
        basis.append(f"You're {back['days_back']} days back from a break, so it's all easy running for now.")
    elif form == "overreaching":
        basis.append("You're carrying a lot of fatigue, so the next few days stay easy.")
    elif strained:
        basis.append("Your resting heart rate or HRV is off your normal, so the next two days stay easy.")
    elif not quality:
        basis.append("No hard sessions lately, so one a week is worked back in.")
    elif q_per_week >= 1.5 and q_budget == 1:
        basis.append(f"You've been doing about {round(q_per_week)} hard sessions a week on {runs_per_week} runs; "
                     "one is suggested so most of your running stays easy.")

    out: list[dict[str, Any]] = []
    first = today if not ran_today else today + timedelta(days=1)
    week_q: Counter[str] = Counter()
    strides_week: set[str] = set()
    rot_i = 0
    for i in range(LOOKAHEAD_DAYS):
        if len(out) >= count:
            break
        d = first + timedelta(days=i)
        name = DAYS[d.weekday()]
        if name not in run_days:
            continue
        monday = (d - timedelta(days=d.weekday())).isoformat()
        day_before_long = DAYS[(d.weekday() + 1) % 7] == long_day
        gap_ok = last_hard is None or (d - last_hard).days >= 2
        tired = (form == "overreaching" and (d - today).days < 3) or (strained and (d - today).days < 2)
        if name == long_day:
            item = {"type": "long", "title": "Long run", "minutes": long_min,
                    "details": "Easy and conversational the whole way. It's fine if HR drifts up in the last 15 minutes.",
                    "hr": f"under {easy_hr} bpm", "speed": paces.get("easy_mps"),
                    "why": f"Your long run is usually on {_day_name(long_day)}s."}
        elif (week_q[monday] < q_budget and gap_ok and not day_before_long and not tired
              and (not q_days or name in q_days)):
            kind = rotation[rot_i % len(rotation)]
            rot_i += 1
            # progress gently: one step for every two of this kind you've done lately
            item = _session(kind, done_count[kind] // 2, lthr, paces)
            since = f"{(d - last_hard).days} days after your last hard day" if last_hard else "your first in a while"
            n = done_count[kind]
            item["why"] = (f"{'An' if KIND_LABEL[kind][0] in 'aeiou' else 'A'} {KIND_LABEL[kind]}, {since}. "
                           + (f"Builds on the {n} you've done in the last 8 weeks." if n > 1 else
                              "Builds on your last one." if n == 1 else "A gentle version to start."))
            done_count[kind] += 1
            week_q[monday] += 1
            last_hard = d
        else:
            strides = (q_budget <= 1 and not rebuilding and not tired and monday not in strides_week
                       and not day_before_long)
            if strides:
                strides_week.add(monday)
            item = {"type": "easy", "title": "Easy run" + (" + strides" if strides else ""), "minutes": easy_min,
                    "details": "Easy and conversational." + (" Finish with 6 × 20 s strides (quick and relaxed, "
                                                             "full recovery between)." if strides else ""),
                    "hr": f"under {easy_hr} bpm", "speed": paces.get("easy_mps"),
                    "why": ("Easy, because the day before your long run should be." if day_before_long
                            else "Easy, to recover from your last hard session." if last_hard and (d - last_hard).days < 2
                            else "Your usual easy run.")}
        out.append({**item, "date": d.isoformat(), "day": name})
    return {"source": "history", "basis": " ".join(basis), "workouts": out}


def _day_name(short: str) -> str:
    return {"Mon": "Monday", "Tue": "Tuesday", "Wed": "Wednesday", "Thu": "Thursday", "Fri": "Friday",
            "Sat": "Saturday", "Sun": "Sunday"}[short]
