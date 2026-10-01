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


ZONE_NAMES = ["Recovery", "Aerobic", "Tempo", "Threshold", "Anaerobic"]


def hr_zones(max_hr: float, lthr: float | None = None) -> list[Zone]:
    """Five heart-rate zones.

    With a lactate-threshold HR, zones are set around threshold (as COROS does):
    <85%, 85-90%, 90-95%, 95-100%, ≥100% of LTHR. Otherwise they use % of max
    HR: <70%, 70-80%, 80-87%, 87-93%, ≥93%.
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


# ---------------------------------------------------------------- per activity

def analyze(activity_type: str | None, streams: dict[str, list], settings: dict[str, float],
            external_hr: bool, intervals: bool = False) -> dict[str, Any]:
    """All per-activity metrics, as stored in the ``activity_metrics`` table.

    ``intervals`` marks a structured workout (work and rest laps); HR drift
    only means something for steady efforts, so it's skipped for those.
    """
    t = streams["t"]
    hr = clean_hr(streams["hr"]) if not external_hr else [float(h) if h else None for h in streams["hr"]]
    zones = zones_for(settings)
    has_hr = any(h is not None for h in hr)
    run = is_run(activity_type)

    metrics: dict[str, Any] = {
        "external_hr": external_hr,
        "trimp": round(trimp(t, hr, settings["resting_hr"], settings["max_hr"], settings.get("male", True)), 1)
        if has_hr else None,
        "zone_seconds": time_in_zones(t, hr, zones) if has_hr else None,
        "max_hr_30s": max((v for v in rolling_mean(hr, 30) if v is not None), default=None) if has_hr else None,
        "decoupling_pct": None,
        "efficiency": None,
        "cadence_lock": None,
        "best_efforts": {},
    }
    if run:
        if not intervals:
            metrics["decoupling_pct"] = aerobic_decoupling(t, streams["speed"], hr)
        metrics["efficiency"] = efficiency_factor(streams["speed"], hr)
        if not external_hr:
            metrics["cadence_lock"] = round(cadence_lock_fraction(hr, streams["cadence"]), 3)
    if is_outdoor_run(activity_type):
        metrics["best_efforts"] = best_efforts(t, streams["distance"])
    return metrics
