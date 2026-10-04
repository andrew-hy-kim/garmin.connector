"""Running analysis computed from second-by-second data.

All functions here are pure (lists in, numbers out) so they're easy to test.
``streams`` is a dict of equal-length lists keyed by ``t``, ``hr``, ``speed``,
``distance``, ``cadence``, ``altitude``, ``power``, ``lat``, ``lon``; any value
may be ``None`` where the watch didn't record it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import median
from typing import Any, Sequence

# Records stop while the watch is paused; a gap longer than this is a pause,
# not time spent at that heart rate.
MAX_SAMPLE_GAP_S = 10
# Below this a runner is standing still (≈ 33 min/km).
MOVING_SPEED_MPS = 0.5

BEST_EFFORT_DISTANCES = {
    "400 m": 400.0,
    "1 km": 1000.0,
    "1 mile": 1609.344,
    "5 km": 5000.0,
    "10 km": 10000.0,
    "Half marathon": 21097.5,
    "Marathon": 42195.0,
}
# Faster than this over 400 m+ is a GPS glitch, not a world record.
MAX_PLAUSIBLE_SPEED_MPS = 7.0


def is_run(activity_type: str | None) -> bool:
    return bool(activity_type) and ("run" in activity_type)


def is_outdoor_run(activity_type: str | None) -> bool:
    return is_run(activity_type) and not any(
        k in activity_type for k in ("treadmill", "indoor", "virtual")
    )


# ---------------------------------------------------------------- helpers

def sample_durations(t: Sequence[int]) -> list[float]:
    """Seconds each sample represents, with pauses counted as 1 s."""
    out = []
    for i in range(len(t)):
        gap = t[i] - t[i - 1] if i else 1
        out.append(gap if 0 < gap <= MAX_SAMPLE_GAP_S else 1)
    return out


def rolling_mean(values: Sequence[float | None], window: int) -> list[float | None]:
    """Centered rolling mean that skips missing values."""
    half = window // 2
    out: list[float | None] = []
    for i in range(len(values)):
        chunk = [v for v in values[max(0, i - half): i + half + 1] if v is not None]
        out.append(sum(chunk) / len(chunk) if chunk else None)
    return out


# ---------------------------------------------------------------- heart rate

def clean_hr(hr: Sequence[int | None]) -> list[float | None]:
    """Remove the spikes and dropouts typical of wrist (optical) heart rate.

    Out-of-range readings are dropped, and any reading more than 20 bpm away
    from the median of the surrounding 11 seconds is replaced by that median.
    """
    valid = [v if v is not None and 35 <= v <= 225 else None for v in hr]
    out: list[float | None] = []
    for i, v in enumerate(valid):
        window = [x for x in valid[max(0, i - 5): i + 6] if x is not None]
        if v is None or not window:
            out.append(None)
            continue
        m = median(window)
        out.append(m if abs(v - m) > 20 else float(v))
    return out


def cadence_lock_fraction(hr: Sequence[float | None], cadence: Sequence[float | None]) -> float:
    """Share of running time where heart rate sits on top of cadence.

    Optical sensors sometimes lock onto your arm swing and report your
    cadence (≈160-185) as heart rate. Lots of overlap means the HR is suspect.
    """
    both = [(h, c) for h, c in zip(hr, cadence) if h is not None and c is not None and c > 130]
    if not both:
        return 0.0
    return sum(1 for h, c in both if abs(h - c) <= 2) / len(both)


@dataclass
class Zone:
    name: str
    low: float  # bpm, inclusive
    high: float  # bpm, exclusive


ZONE_NAMES = ["Recovery", "Aerobic", "Tempo", "Threshold", "VO2 max"]


def hr_zones(max_hr: float, lthr: float | None = None) -> list[Zone]:
    """Five heart-rate zones.

    With a lactate-threshold HR, zones are anchored to threshold, the approach
    COROS uses, with Joe Friel's running percentages: <85%, 85-90%, 90-95%,
    95-100%, ≥100% of LTHR. Without one they use % of max HR: <70%, 70-80%,
    80-87%, 87-93%, ≥93%.
    """
    if lthr:
        edges = [0.85 * lthr, 0.90 * lthr, 0.95 * lthr, lthr]
    else:
        edges = [0.70 * max_hr, 0.80 * max_hr, 0.87 * max_hr, 0.93 * max_hr]
    bounds = [0.0, *[round(e) for e in edges], 999.0]
    return [Zone(ZONE_NAMES[i], bounds[i], bounds[i + 1]) for i in range(5)]


def zones_from_floors(floors: Sequence[float]) -> list[Zone]:
    """Zones from the lower bound (floor) of each of Garmin's five zones.

    Heart rate below zone 1's floor is counted in zone 1.
    """
    bounds = [0.0, *[float(f) for f in floors[1:5]], 999.0]
    return [Zone(ZONE_NAMES[i], bounds[i], bounds[i + 1]) for i in range(5)]


def zones_for(settings: dict[str, Any]) -> list[Zone]:
    """The zones to use: Garmin's own when available, otherwise computed."""
    if settings.get("zone_floors"):
        return zones_from_floors(settings["zone_floors"])
    return hr_zones(settings["max_hr"], settings.get("lthr"))


def time_in_zones(t: Sequence[int], hr: Sequence[float | None], zones: list[Zone]) -> list[float]:
    seconds = [0.0] * len(zones)
    for dt, h in zip(sample_durations(t), hr):
        if h is None:
            continue
        for i, z in enumerate(zones):
            if z.low <= h < z.high:
                seconds[i] += dt
                break
    return seconds


def trimp(t: Sequence[int], hr: Sequence[float | None], resting_hr: float, max_hr: float, male: bool = True) -> float:
    """Banister TRIMP: training load from time spent at each heart rate.

    Harder minutes count exponentially more than easy ones.
    """
    k = 1.92 if male else 1.67
    total = 0.0
    for dt, h in zip(sample_durations(t), hr):
        if h is None:
            continue
        reserve = min(max((h - resting_hr) / (max_hr - resting_hr), 0.0), 1.0)
        total += dt / 60 * reserve * 0.64 * math.exp(k * reserve)
    return total


def trimp_from_summary(duration_s: float, avg_hr: float, resting_hr: float, max_hr: float,
                       male: bool = True) -> float:
    """TRIMP for activities without second-by-second data, assuming a steady average HR."""
    reserve = min(max((avg_hr - resting_hr) / (max_hr - resting_hr), 0.0), 1.0)
    return duration_s / 60 * reserve * 0.64 * math.exp((1.92 if male else 1.67) * reserve)


# ---------------------------------------------------------------- pace

def _minetti_cost(grade: float) -> float:
    """Energy cost of running (J/kg/m) at a gradient (Minetti et al., 2002)."""
    g = max(min(grade, 0.45), -0.45)
    return 155.4 * g**5 - 30.4 * g**4 - 43.3 * g**3 + 46.3 * g**2 + 19.5 * g + 3.6


def grades(distance: Sequence[float | None], altitude: Sequence[float | None], span_m: float = 30.0) -> list[float | None]:
    """Gradient at each sample, measured over the previous ~``span_m`` of distance.

    Measuring over a stretch rather than sample-to-sample smooths out GPS and
    barometer noise. Samples without distance get None.
    """
    valid = [i for i in range(len(distance)) if distance[i] is not None and altitude[i] is not None]
    out: list[float | None] = [None] * len(distance)
    last = 0.0
    j = 0  # index into ``valid`` of the start of the stretch
    for n, i in enumerate(valid):
        while j + 1 < n and distance[i] - distance[valid[j + 1]] >= span_m:
            j += 1
        k = valid[j]
        run = distance[i] - distance[k]
        if run >= span_m / 2:
            last = (altitude[i] - altitude[k]) / run
        out[i] = last
    return out


def grade_adjusted_speed(speed: Sequence[float | None], grade: Sequence[float | None]) -> list[float | None]:
    """Speed you'd have run on flat ground for the same effort."""
    flat = _minetti_cost(0)
    return [
        s * _minetti_cost(g) / flat if s is not None and g is not None else s
        for s, g in zip(speed, grade)
    ]


# ---------------------------------------------------------------- efforts

def best_efforts(t: Sequence[int], distance: Sequence[float | None]) -> dict[str, dict[str, float]]:
    """Fastest time over each standard distance anywhere within the activity."""
    pts = [(ti, d) for ti, d in zip(t, distance) if d is not None]
    results: dict[str, dict[str, float]] = {}
    if len(pts) < 2:
        return results
    for label, target in BEST_EFFORT_DISTANCES.items():
        if pts[-1][1] - pts[0][1] < target:
            continue
        best = None
        start = 0
        for end in range(len(pts)):
            # advance start as far as possible while still covering the distance
            while start + 1 < end and pts[end][1] - pts[start + 1][1] >= target:
                start += 1
            covered = pts[end][1] - pts[start][1]
            if covered < target:
                continue
            # scale the time down to exactly the target distance
            secs = (pts[end][0] - pts[start][0]) * target / covered
            if best is None or secs < best[0]:
                best = (secs, pts[start][0])
        if best and target / best[0] <= MAX_PLAUSIBLE_SPEED_MPS:
            results[label] = {"seconds": round(best[0], 1), "start_t": best[1], "meters": target}
    return results


def aerobic_decoupling(
    t: Sequence[int], speed: Sequence[float | None], hr: Sequence[float | None], warmup_s: int = 600
) -> float | None:
    """How much heart rate drifted relative to pace between the two halves (Pa:HR).

    Under 5% on a long steady run suggests a solid aerobic base. Only meaningful
    for steady efforts of 40 minutes or more, so returns None otherwise.
    """
    moving = [
        (ti, s, h) for ti, s, h in zip(t, speed, hr)
        if ti >= warmup_s and s is not None and h and s > MOVING_SPEED_MPS
    ]
    if len(moving) < 1800:  # need at least 30 min after the warm-up
        return None
    half = len(moving) // 2

    def efficiency(chunk):
        return (sum(s for _, s, _ in chunk) / len(chunk)) / (sum(h for _, _, h in chunk) / len(chunk))

    first, second = efficiency(moving[:half]), efficiency(moving[half:])
    return round((first - second) / first * 100, 1)


WALK_SPEED_MPS = 1.8    # about 15 min/mi (9:15 /km); slower than this is walking
WALK_SHARE_MAX = 0.15   # runs with more walking than this are run/walk sessions


def walk_share(speed: Sequence[float | None]) -> float | None:
    """Share of moving time spent walking (10-second average, so GPS jitter doesn't count)."""
    smooth = rolling_mean(speed, 10)
    moving = [s for s in smooth if s is not None and s > MOVING_SPEED_MPS]
    if len(moving) < 300:
        return None
    return round(sum(1 for s in moving if s < WALK_SPEED_MPS) / len(moving), 3)


def efficiency_factor(speed: Sequence[float | None], hr: Sequence[float | None]) -> float | None:
    """Meters per minute per heartbeat while moving. Rises as aerobic fitness improves."""
    pairs = [(s, h) for s, h in zip(speed, hr) if s is not None and h and s > MOVING_SPEED_MPS]
    if len(pairs) < 300:
        return None
    avg_speed = sum(s for s, _ in pairs) / len(pairs)
    avg_hr = sum(h for _, h in pairs) / len(pairs)
    return round(avg_speed * 60 / avg_hr, 3)


# ---------------------------------------------------------------- training load

def training_load(daily_load: dict[str, float], days: list[str]) -> list[dict[str, Any]]:
    """Fitness, fatigue and form for each day.

    Fitness is a 42-day exponentially weighted average of daily load, fatigue a
    7-day one; form (fitness minus fatigue) is positive when you're fresh and
    negative when you're carrying fatigue.
    """
    fitness = fatigue = 0.0
    out = []
    for day in days:
        load = daily_load.get(day, 0.0)
        form = fitness - fatigue  # form going into the day
        fitness += (load - fitness) / 42
        fatigue += (load - fatigue) / 7
        out.append({"date": day, "load": round(load, 1), "fitness": round(fitness, 1),
                    "fatigue": round(fatigue, 1), "form": round(form, 1)})
    return out


# ---------------------------------------------------------------- workout tagging

# Intensity bands as a share of lactate-threshold HR, the way threshold-based
# systems (COROS, Friel) define them. Used for tagging regardless of which zone
# system the dashboard displays.
LTHR_BANDS = [("easy", 0.0, 0.90), ("tempo", 0.90, 0.95), ("threshold", 0.95, 1.00), ("vo2", 1.00, 9.0)]

WORKOUT_LABELS = {
    "race": "Race",
    "recovery": "Recovery run",
    "easy": "Easy run",
    "easy_strides": "Easy + strides",
    "long": "Long run",
    "progression": "Progression run",
    "tempo": "Tempo run",
    "threshold": "Threshold run",
    "intervals_threshold": "Threshold intervals",
    "intervals_vo2": "VO2 max intervals",
    "speed": "Speed session",
    "fartlek": "Fartlek",
}
QUALITY_TYPES = {"race", "progression", "tempo", "threshold", "intervals_threshold", "intervals_vo2", "speed", "fartlek"}


def intensity_seconds(t: Sequence[int], hr: Sequence[float | None], lthr: float) -> list[float]:
    """Seconds spent easy (<90% LTHR), tempo (90-95%), threshold (95-100%) and VO2 max (≥100%)."""
    zones = [Zone(name, lo * lthr, hi * lthr) for name, lo, hi in LTHR_BANDS]
    return time_in_zones(t, hr, zones)


@dataclass
class Rep:
    start: int  # sample index
    end: int    # sample index (inclusive)
    seconds: float
    meters: float | None
    avg_hr: float | None    # second half of the rep; HR lags at the start
    peak_hr: float | None


def _mean(values) -> float | None:
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def _make_rep(i0: int, i1: int, t, hr, distance) -> Rep:
    mid = (i0 + i1) // 2
    d0, d1 = distance[i0], distance[i1]
    return Rep(i0, i1, t[i1] - t[i0], (d1 - d0) if d0 is not None and d1 is not None else None,
               _mean(hr[mid:i1 + 1]), max((h for h in hr[i0:i1 + 1] if h is not None), default=None))


def _idx_at(t: Sequence[int], seconds: float) -> int:
    lo, hi = 0, len(t) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if t[mid] < seconds:
            lo = mid + 1
        else:
            hi = mid
    return lo


STRUCTURED_LAP_TYPES = {"warmup", "cooldown", "rest", "recovery", "interval"}


def detect_reps(t, speed, hr, distance, laps: list[dict] | None, gap=None) -> list[Rep]:
    """Work intervals.

    If the watch recorded a structured workout (laps marked warm-up, rest,
    cool-down...), the "active" laps between rest laps are the reps, and a
    workout without rest laps (warm-up, tempo, cool-down) has none. Otherwise
    reps are found from repeated surges of at least 45 s that are faster than
    the run's typical pace both as run (12%+) and grade-adjusted (10%+), so
    neither downhills nor holding pace up a hill look like a rep.
    """
    if laps and any(l.get("intensity") in STRUCTURED_LAP_TYPES for l in laps):
        if not any(l.get("intensity") in ("rest", "recovery") for l in laps):
            return []
        reps = []
        for lap in laps:
            if lap.get("intensity") == "active" and lap.get("elapsed_s"):
                i0 = _idx_at(t, lap["start_t"])
                i1 = min(_idx_at(t, lap["start_t"] + lap["elapsed_s"]), len(t) - 1)
                if i1 > i0:
                    reps.append(_make_rep(i0, i1, t, hr, distance))
        return reps

    def surge_flags(values, factor):
        smooth = rolling_mean(values, 21)
        moving = sorted(v for v in smooth if v is not None and v > MOVING_SPEED_MPS)
        if len(moving) < 600:
            return None
        typical = moving[len(moving) // 2]
        return [v is not None and v >= typical * factor for v in smooth]

    fast = surge_flags(speed, 1.12)
    if fast is None:
        return []
    if gap is not None:
        fast_gap = surge_flags(gap, 1.10) or fast
        fast = [a and b for a, b in zip(fast, fast_gap)]
    reps, i = [], 0
    while i < len(fast):
        if not fast[i]:
            i += 1
            continue
        j = i
        while j + 1 < len(fast) and fast[j + 1]:
            j += 1
        if t[j] - t[i] >= 45:
            reps.append(_make_rep(i, j, t, hr, distance))
        i = j + 1
    return reps if len(reps) >= 3 else []


def _thirds_speed(t, speed) -> list[float | None]:
    pts = [(ti, s) for ti, s in zip(t, speed) if s is not None and s > MOVING_SPEED_MPS]
    if len(pts) < 900:
        return [None, None, None]
    n = len(pts) // 3
    return [_mean(s for _, s in pts[k * n:(k + 1) * n]) for k in range(3)]


def classify_workout(activity_type: str | None, t, speed, hr, distance, lthr: float,
                     laps: list[dict] | None = None, is_race: bool = False, gap=None) -> dict[str, Any] | None:
    """Tag a run as easy, long, tempo, threshold, intervals, etc., and say why.

    ``gap`` (grade-adjusted speed) keeps hills from being mistaken for surges.
    """
    if not is_run(activity_type):
        return None
    moving_s = sum(dt for dt, s in zip(sample_durations(t), speed) if s is not None and s > MOVING_SPEED_MPS)
    smooth_hr = rolling_mean(hr, 30)
    bands = intensity_seconds(t, smooth_hr, lthr) if any(h is not None for h in hr) else None

    def tag(kind: str, reason: str) -> dict[str, Any]:
        return {"type": kind, "label": WORKOUT_LABELS[kind], "reason": reason, "quality": kind in QUALITY_TYPES}

    if is_race:
        return tag("race", "Marked as a race in Garmin Connect.")

    reps = detect_reps(t, speed, hr, distance, laps, gap)
    work_s = sum(r.seconds for r in reps)
    if reps and (work_s >= 360 or len(reps) >= 4):
        lengths = sorted(r.seconds for r in reps)
        typical = lengths[len(lengths) // 2]
        peaks = sorted(r.peak_hr for r in reps if r.peak_hr)
        avgs = sorted(r.avg_hr for r in reps if r.avg_hr)
        peak_rel = peaks[len(peaks) // 2] / lthr if peaks else 0
        avg_rel = avgs[len(avgs) // 2] / lthr if avgs else 0
        desc = f"{len(reps)} × {_fmt_s(typical)} reps"
        # Faster stretches that never take heart rate out of the easy zone (run/walk, relaxed
        # pickups) aren't a workout: the effort is what counts, not the structure.
        if peaks and peak_rel < LTHR_BANDS[0][2] and bands and bands[0] >= 0.9 * sum(bands):
            kind = "long" if moving_s >= 75 * 60 else "easy"
            return tag(kind, f"{len(reps)} faster stretches of about {_fmt_s(typical)} (run/walk or pickups), "
                             f"but heart rate stayed easy, peaking at {peak_rel:.0%} of threshold HR.")
        if typical < 90:
            if work_s < 300 and bands and bands[0] >= 0.7 * sum(bands):
                return tag("easy_strides", f"Easy running with {len(reps)} short pickups ({_fmt_s(typical)}).")
            return tag("speed", f"{desc}: short, fast repeats where pace matters more than heart rate.")
        if typical <= 360 and peak_rel >= 1.0:
            return tag("intervals_vo2", f"{desc} peaking at {peak_rel:.0%} of threshold HR.")
        if avg_rel >= 0.94 or peak_rel >= 0.97:
            return tag("intervals_threshold", f"{desc} at about {avg_rel:.0%} of threshold HR.")
        return tag("fartlek", f"{desc} below threshold intensity.")

    if not bands:
        if moving_s >= 75 * 60:
            return tag("long", f"{_fmt_s(moving_s)} of running (no heart rate recorded).")
        return tag("easy", "No heart rate recorded, so tagged by default.")

    easy, tempo, threshold, vo2 = bands
    total = sum(bands) or 1
    hard = threshold + vo2
    if hard >= 15 * 60:
        return tag("threshold", f"{_fmt_s(hard)} at or above 95% of threshold HR.")
    if tempo + hard >= 20 * 60 or (tempo + hard) / total >= 0.35:
        first, _, last = _thirds_speed(t, gap if gap is not None else speed)
        if first and last and last >= first * 1.06:
            return tag("progression", f"Finished {last / first - 1:.0%} faster than you started, "
                                      f"with {_fmt_s(tempo + hard)} at tempo or harder.")
        if not (moving_s >= 75 * 60 and easy / total >= 0.5):
            return tag("tempo", f"{_fmt_s(tempo + hard)} at 90% of threshold HR or higher.")
        # A long easy run whose heart rate drifted up late is still a long run.
        return tag("long", f"{_fmt_s(moving_s)}, mostly easy; heart rate drifted into tempo for "
                           f"{_fmt_s(tempo + hard)} without you speeding up.")
    if moving_s >= 75 * 60:
        return tag("long", f"{_fmt_s(moving_s)} at mostly easy effort.")
    avg_rel = (_mean(hr) or 0) / lthr
    if avg_rel < 0.78 and moving_s <= 40 * 60:
        return tag("recovery", f"Short and very easy: average HR {avg_rel:.0%} of threshold.")
    return tag("easy", f"{easy / total:.0%} of the time below 90% of threshold HR.")


def _fmt_s(seconds: float) -> str:
    seconds = int(round(seconds))
    h, m, s = seconds // 3600, seconds % 3600 // 60, seconds % 60
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}" if s else f"{m} min"


def pacing_stats(t, speed, hr, cadence) -> dict[str, Any]:
    """First vs second half pace and HR, and early vs late cadence, while moving."""
    pts = [(s, h, c) for s, h, c in zip(speed, hr, cadence) if s is not None and s > MOVING_SPEED_MPS]
    if len(pts) < 600:
        return {}
    half, third = len(pts) // 2, len(pts) // 3
    return {
        "speed_halves": [_mean(p[0] for p in pts[:half]), _mean(p[0] for p in pts[half:])],
        "hr_halves": [_mean(p[1] for p in pts[:half]), _mean(p[1] for p in pts[half:])],
        "cadence_thirds": [_mean(p[2] for p in pts[:third]), _mean(p[2] for p in pts[-third:])],
    }


# ---------------------------------------------------------------- per activity

def analyze(activity_type: str | None, streams: dict[str, list], settings: dict[str, Any],
            external_hr: bool, laps: list[dict] | None = None, is_race: bool = False) -> dict[str, Any]:
    """All per-activity metrics, as stored in the ``activity_metrics`` table."""
    t = streams["t"]
    hr = clean_hr(streams["hr"]) if not external_hr else [float(h) if h else None for h in streams["hr"]]
    zones = zones_for(settings)
    has_hr = any(h is not None for h in hr)
    run = is_run(activity_type)
    lthr = settings.get("lthr") or 0.9 * settings["max_hr"]
    structured = bool(laps) and any(l.get("intensity") in ("rest", "recovery") for l in laps)

    metrics: dict[str, Any] = {
        "external_hr": external_hr,
        "trimp": round(trimp(t, hr, settings["resting_hr"], settings["max_hr"], settings.get("male", True)), 1)
        if has_hr else None,
        "zone_seconds": time_in_zones(t, hr, zones) if has_hr else None,
        # Both zone systems at full resolution, so the phone app can switch exactly.
        "zone_seconds_by_system": {
            "threshold": time_in_zones(t, hr, hr_zones(settings["max_hr"], settings.get("lthr"))),
            "garmin": (time_in_zones(t, hr, zones_from_floors(settings["garmin_zone_floors"]))
                       if settings.get("garmin_zone_floors") else None),
        } if has_hr else None,
        "intensity_seconds": intensity_seconds(t, rolling_mean(hr, 30), lthr) if has_hr else None,
        "max_hr_30s": max((v for v in rolling_mean(hr, 30) if v is not None), default=None) if has_hr else None,
        "decoupling_pct": None,
        "efficiency": None,
        "cadence_lock": None,
        "best_efforts": {},
        "workout": None,
        "reps": [],
        "pacing": {},
        "walk_share": None,
    }
    if run:
        cadence = streams["cadence"]
        gap = grade_adjusted_speed(streams["speed"], grades(streams["distance"], streams["altitude"]))
        workout = classify_workout(activity_type, t, streams["speed"], hr, streams["distance"], lthr, laps,
                                   is_race, gap)
        metrics["workout"] = workout
        # Run/walk: pace-against-heart-rate measures (efficiency, drift, effective VO2max) assume
        # continuous running, and walking breaks would read as a collapse in fitness
        metrics["walk_share"] = walk_share(streams["speed"])
        run_walk = (metrics["walk_share"] or 0) > WALK_SHARE_MAX
        steady = workout and workout["type"] in ("easy", "long", "recovery", "tempo", "progression", "threshold")
        if steady and not structured and not run_walk:
            metrics["decoupling_pct"] = aerobic_decoupling(t, streams["speed"], hr)
        metrics["efficiency"] = None if run_walk else efficiency_factor(streams["speed"], hr)
        metrics["pacing"] = pacing_stats(t, streams["speed"], hr, cadence)
        metrics["reps"] = [
            {"seconds": r.seconds, "meters": r.meters, "avg_hr": r.avg_hr, "peak_hr": r.peak_hr,
             "start_t": t[r.start], "gap_mps": _mean(gap[r.start:r.end + 1])}
            for r in detect_reps(t, streams["speed"], hr, streams["distance"], laps, gap)
        ]
        if not external_hr:
            metrics["cadence_lock"] = round(cadence_lock_fraction(hr, cadence), 3)
    if is_outdoor_run(activity_type):
        metrics["best_efforts"] = best_efforts(t, streams["distance"])
    return metrics
