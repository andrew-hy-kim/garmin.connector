"""Build Apple Health exports for tests: export.xml plus workout-routes/*.gpx, zipped like the Health app does."""

from __future__ import annotations

import math
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

TZ = timezone(timedelta(hours=-7))


def _d(t: datetime) -> str:
    return t.astimezone(TZ).strftime("%Y-%m-%d %H:%M:%S %z")


def run(start: datetime, minutes: int = 30, speed: float = 3.0, hr: int = 145, indoor: bool = False,
        kind: str = "HKWorkoutActivityTypeRunning", new_format: bool = True, lat0: float = 47.62, lon0: float = -122.32,
        phone: bool = False):
    """One workout: its XML, its records, and its GPX (outdoors). Runs north at ``speed`` m/s.
    With ``phone``, an iPhone in a pocket also counts the steps and distance, in its own chunks."""
    end = start + timedelta(minutes=minutes)
    secs = minutes * 60
    dist_km = speed * secs / 1000
    stats = (f'<WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="{_d(start)}" '
             f'endDate="{_d(end)}" sum="{dist_km:.3f}" unit="km"/>'
             f'<WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="{_d(start)}" '
             f'endDate="{_d(end)}" sum="{minutes * 11}" unit="kcal"/>') if new_format else ""
    totals = "" if new_format else f' totalDistance="{dist_km:.3f}" totalDistanceUnit="km" totalEnergyBurned="{minutes * 11}" totalEnergyBurnedUnit="kcal"'
    name = f"route_{start:%Y-%m-%d_%H%M}.gpx"
    route = "" if indoor else (f'<WorkoutRoute sourceName="Apple Watch" startDate="{_d(start)}" endDate="{_d(end)}">'
                               f'<FileReference path="/workout-routes/{name}"/></WorkoutRoute>')
    xml = (f'<Workout workoutActivityType="{kind}" duration="{minutes}" durationUnit="min"{totals} '
           f'sourceName="Andrew’s Apple Watch" startDate="{_d(start)}" endDate="{_d(end)}">'
           f'<MetadataEntry key="HKIndoorWorkout" value="{1 if indoor else 0}"/>'
           f'<MetadataEntry key="HKElevationAscended" value="2500 cm"/>{stats}{route}</Workout>')
    records = []
    for s in range(0, secs + 1, 5):  # heart rate every 5 s, rising gently
        t = start + timedelta(seconds=s)
        records.append(f'<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" '
                       f'startDate="{_d(t)}" endDate="{_d(t)}" value="{hr + 10 * s / secs:.0f}"/>')
    devices = [("Andrew’s Apple Watch", 60)] + ([("Andrew’s iPhone", 90)] if phone else [])
    for device, chunk in devices:  # steps at 170 spm and distance, in chunks of each device's own length
        for s in range(0, secs, chunk) if kind == "HKWorkoutActivityTypeRunning" else ():
            a, b = start + timedelta(seconds=s), start + timedelta(seconds=min(secs, s + chunk))
            n = (b - a).total_seconds()
            records.append(f'<Record type="HKQuantityTypeIdentifierStepCount" sourceName="{device}" unit="count" '
                           f'startDate="{_d(a)}" endDate="{_d(b)}" value="{170 * n / 60:.0f}"/>')
            records.append(f'<Record type="HKQuantityTypeIdentifierDistanceWalkingRunning" sourceName="{device}" '
                           f'unit="km" startDate="{_d(a)}" endDate="{_d(b)}" value="{speed * n / 1000:.4f}"/>')
    gpx = None
    if not indoor:
        pts = []
        for s in range(0, secs + 1):
            lat = lat0 + speed * s / 111_320
            t = (start + timedelta(seconds=s)).astimezone(timezone.utc)
            pts.append(f'<trkpt lon="{lon0:.6f}" lat="{lat:.6f}"><ele>{50 + 5 * math.sin(s / 300):.1f}</ele>'
                       f'<time>{t:%Y-%m-%dT%H:%M:%SZ}</time><extensions><speed>{speed:.2f}</speed></extensions></trkpt>')
        gpx = (name, '<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Apple Health Export" '
                     'xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Route</name><trkseg>'
               + "".join(pts) + "</trkseg></trk></gpx>")
    return xml, records, gpx


def export_zip(path: Path, workouts: list, vo2: list[tuple[datetime, float]] = ()) -> Path:
    records, xmls, gpxs = [], [], []
    for xml, recs, gpx in workouts:
        xmls.append(xml)
        records.extend(recs)
        if gpx:
            gpxs.append(gpx)
    for t, v in vo2:
        records.append(f'<Record type="HKQuantityTypeIdentifierVO2Max" unit="mL/min·kg" startDate="{_d(t)}" '
                       f'endDate="{_d(t)}" value="{v}"/>')
    # all-day heart rate outside workouts too, like a real export
    records.append('<Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" '
                   'startDate="2022-01-01 03:00:00 -0700" endDate="2022-01-01 03:00:00 -0700" value="52"/>')
    body = ('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE HealthData [<!ELEMENT HealthData ANY>]>\n'
            '<HealthData locale="en_US"><ExportDate value="2024-01-01 10:00:00 -0700"/><Me/>'
            + "".join(records) + "".join(xmls) + "</HealthData>")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("apple_health_export/export.xml", body)
        z.writestr("apple_health_export/export_cda.xml", "<ClinicalDocument/>")
        for name, data in gpxs:
            z.writestr(f"apple_health_export/workout-routes/{name}", data)
    return path
