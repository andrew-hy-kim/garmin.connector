"""Read the second-by-second data out of a .fit file.

A watch records a ``record`` message about once a second (heart rate, speed,
distance, cadence, altitude, GPS, power) plus ``lap`` messages for each lap or
workout step, and ``device_info`` messages for each sensor that was connected.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import fitdecode

_SEMICIRCLE_TO_DEG = 180 / 2**31
# FIT device-type code for a heart-rate monitor (ANT+ and BLE share it).
_HR_DEVICE_TYPE = 120


@dataclass
class Sample:
    t: int  # seconds since the activity started
    hr: int | None = None
    speed: float | None = None  # m/s
    distance: float | None = None  # m, cumulative
    cadence: float | None = None  # steps per minute (both feet)
    altitude: float | None = None  # m
    power: float | None = None  # W
    lat: float | None = None
    lon: float | None = None


@dataclass
class Lap:
    index: int
    start_t: int  # seconds since the activity started
    elapsed_s: float | None
    timer_s: float | None
    distance_m: float | None
    avg_hr: float | None
    max_hr: float | None
    avg_speed: float | None
    avg_cadence: float | None
    intensity: str | None  # active / rest / warmup / cooldown / recovery / interval
    trigger: str | None  # manual / distance / time / ...


@dataclass
class FitActivity:
    start_time: datetime | None = None
    samples: list[Sample] = field(default_factory=list)
    laps: list[Lap] = field(default_factory=list)
    # True when an external HR sensor (chest strap, arm band) was connected.
    external_hr: bool = False


def _get(frame: fitdecode.FitDataMessage, *names: str) -> Any:
    """First non-empty value among the given field names."""
    for name in names:
        if frame.has_field(name):
            value = frame.get_value(name)
            if value is not None:
                return value
    return None


def _is_hr_sensor(frame: fitdecode.FitDataMessage) -> bool:
    for name in ("antplus_device_type", "ble_device_type", "device_type"):
        value = _get(frame, name)
        if value in ("heart_rate", _HR_DEVICE_TYPE):
            return True
    return False


def _steps_per_min(frame: fitdecode.FitDataMessage) -> float | None:
    # Running cadence is stored per leg ("strides per minute"), with an optional
    # fractional part; double it to get steps per minute.
    cadence = _get(frame, "cadence")
    if cadence is None:
        return None
    return 2 * (cadence + (_get(frame, "fractional_cadence") or 0))


def parse(path: Path | str) -> FitActivity:
    activity = FitActivity()
    laps: list[tuple[datetime, dict[str, Any]]] = []
    start: datetime | None = None

    with fitdecode.FitReader(str(path), check_crc=fitdecode.CrcCheck.DISABLED) as reader:
        for frame in reader:
            if not isinstance(frame, fitdecode.FitDataMessage):
                continue

            if frame.name == "record":
                ts = _get(frame, "timestamp")
                if ts is None:
                    continue
                if start is None:
                    start = ts
                lat, lon = _get(frame, "position_lat"), _get(frame, "position_long")
                activity.samples.append(
                    Sample(
                        t=int((ts - start).total_seconds()),
                        hr=_get(frame, "heart_rate"),
                        speed=_get(frame, "enhanced_speed", "speed"),
                        distance=_get(frame, "distance"),
                        cadence=_steps_per_min(frame),
                        altitude=_get(frame, "enhanced_altitude", "altitude"),
                        power=_get(frame, "power"),
                        lat=lat * _SEMICIRCLE_TO_DEG if lat is not None else None,
                        lon=lon * _SEMICIRCLE_TO_DEG if lon is not None else None,
                    )
                )

            elif frame.name == "lap":
                laps.append((_get(frame, "start_time", "timestamp"), {
                    "elapsed_s": _get(frame, "total_elapsed_time"),
                    "timer_s": _get(frame, "total_timer_time"),
                    "distance_m": _get(frame, "total_distance"),
                    "avg_hr": _get(frame, "avg_heart_rate"),
                    "max_hr": _get(frame, "max_heart_rate"),
                    "avg_speed": _get(frame, "enhanced_avg_speed", "avg_speed"),
                    "avg_cadence": _steps_per_min_lap(frame),
                    "intensity": _str(_get(frame, "intensity")),
                    "trigger": _str(_get(frame, "lap_trigger")),
                }))

            elif frame.name == "device_info" and _is_hr_sensor(frame):
                activity.external_hr = True

    activity.start_time = start
    for i, (lap_start, data) in enumerate(laps):
        start_t = int((lap_start - start).total_seconds()) if start and lap_start else 0
        activity.laps.append(Lap(index=i + 1, start_t=max(start_t, 0), **data))
    return activity


def _steps_per_min_lap(frame: fitdecode.FitDataMessage) -> float | None:
    cadence = _get(frame, "avg_running_cadence", "avg_cadence")
    if cadence is None:
        return None
    return 2 * (cadence + (_get(frame, "avg_fractional_cadence") or 0))


def _str(value: Any) -> str | None:
    return None if value is None else str(value)
