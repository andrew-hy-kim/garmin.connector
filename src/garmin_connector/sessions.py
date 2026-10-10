"""Building blocks for suggested workouts: session recipes and your recent training.

``context`` reads your recent running time, how often you run, your threshold HR, paces
from recent best efforts and any comeback from a break; the recipes progress each kind of
hard session (VO2 max reps, threshold, tempo, hills) as you do more of them.
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta
from statistics import median
from typing import Any

from . import insights, processing

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

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
    """What the suggested workouts are based on: your recent running, form, paces and any comeback."""
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
