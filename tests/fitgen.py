"""Build synthetic .fit files for tests (and the demo database).

Uses fit-tool, a dev-only dependency, to write files in the same format a
Garmin watch does.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from pathlib import Path

from fit_tool.fit_file_builder import FitFileBuilder
from fit_tool.profile.messages.device_info_message import DeviceInfoMessage
from fit_tool.profile.messages.file_id_message import FileIdMessage
from fit_tool.profile.messages.lap_message import LapMessage
from fit_tool.profile.messages.record_message import RecordMessage
from fit_tool.profile.profile_type import FileType, Intensity, LapTrigger, Manufacturer


def steady_run(minutes: int = 50, pace_mps: float = 3.0, start_hr: int = 135, drift_bpm: float = 10.0,
               hill_m: float = 20.0):
    """Per-second samples for a steady run: rolling hills, HR drifting up over time."""
    samples, distance = [], 0.0
    for t in range(minutes * 60):
        distance += pace_mps
        samples.append({
            "t": t,
            "speed": pace_mps,
            "distance": distance,
            "hr": round(min(start_hr + 25, start_hr * (1 - math.exp(-t / 120)) + 25 * math.exp(-t / 120))
                        + drift_bpm * t / (minutes * 60)),
            "cadence": 84,  # per leg; 168 steps/min
            "altitude": 50 + hill_m * math.sin(distance / 400),
        })
    return samples, [(0, minutes * 60, "active")]


def intervals(reps: int = 6, rep_s: int = 180, rest_s: int = 90, warm_s: int = 600):
    """Warm-up, reps hard / rest easy, cool-down. Returns samples and (start, length, intensity) laps."""
    plan = [(warm_s, 2.8, 140, "warmup")]
    for _ in range(reps):
        plan += [(rep_s, 4.6, 178, "active"), (rest_s, 1.8, 150, "rest")]
    plan.append((warm_s, 2.6, 138, "cooldown"))

    samples, laps, t, distance = [], [], 0, 0.0
    for length, speed, hr, intensity in plan:
        laps.append((t, length, intensity))
        for _ in range(length):
            distance += speed
            samples.append({"t": t, "speed": speed, "distance": distance, "hr": hr, "cadence": 88 if speed > 4 else 82,
                            "altitude": 50.0})
            t += 1
    return samples, laps


def write_fit(path: Path, samples, laps, start: datetime | None = None, external_hr: bool = False,
              wrist_spikes: bool = False) -> Path:
    start = start or datetime(2026, 9, 1, 14, 0, tzinfo=timezone.utc)
    start_ms = round(start.timestamp() * 1000)
    builder = FitFileBuilder(auto_define=True, min_string_size=50)

    file_id = FileIdMessage()
    file_id.type = FileType.ACTIVITY
    file_id.manufacturer = Manufacturer.GARMIN.value
    file_id.product = 1
    file_id.time_created = start_ms
    file_id.serial_number = 0x12345678
    builder.add(file_id)

    if external_hr:
        hrm = DeviceInfoMessage()
        hrm.timestamp = start_ms
        hrm.device_index = 1
        hrm.antplus_device_type = 120  # heart-rate monitor
        builder.add(hrm)

    for s in samples:
        rec = RecordMessage()
        rec.timestamp = start_ms + s["t"] * 1000
        rec.position_lat = s.get("lat", 47.6 + s["distance"] / 111_000)
        rec.position_long = s.get("lon", -122.3)
        rec.distance = s["distance"]
        rec.enhanced_speed = s["speed"]
        hr = s["hr"]
        if wrist_spikes and s["t"] % 97 == 0:
            hr = 205  # a one-second optical glitch
        rec.heart_rate = hr
        rec.cadence = s["cadence"]
        rec.enhanced_altitude = s["altitude"]
        builder.add(rec)

    for lap_start, length, intensity in laps:
        chunk = [s for s in samples if lap_start <= s["t"] < lap_start + length]
        lap = LapMessage()
        lap.start_time = start_ms + lap_start * 1000
        lap.timestamp = start_ms + (lap_start + length) * 1000
        lap.total_elapsed_time = length
        lap.total_timer_time = length
        lap.total_distance = chunk[-1]["distance"] - chunk[0]["distance"] + chunk[0]["speed"]
        lap.avg_heart_rate = round(sum(s["hr"] for s in chunk) / len(chunk))
        lap.max_heart_rate = max(s["hr"] for s in chunk)
        lap.enhanced_avg_speed = sum(s["speed"] for s in chunk) / len(chunk)
        lap.intensity = Intensity[intensity.upper()]
        lap.lap_trigger = LapTrigger.SESSION_END if lap_start + length == len(samples) else LapTrigger.TIME
        builder.add(lap)

    builder.build().to_file(str(path))
    return path
