"""Import workouts from an Apple Health export: your runs from before your Garmin watch.

On iPhone: Health app → your picture → Export All Health Data. That gives export.zip, with
``export.xml`` (every workout and every heart-rate sample) and a GPS file for each outdoor
workout in ``workout-routes/``. ``garmin import-apple export.zip`` reads it once:

- Runs, rides, walks and hikes from before your first Garmin activity become ordinary
  activities, with second-by-second streams rebuilt from the GPS route (position, distance,
  speed, elevation), the heart rate the watch recorded during the workout, step cadence and
  running power where the watch recorded them. They then go through the same analysis as
  Garmin workouts: zones, load, efficiency, best efforts, records, the heatmap, weather.
- Anything overlapping an activity already in the dashboard is skipped, so a workout that
  Garmin Connect also wrote into Apple Health never shows up twice.
- Apple's VO2 max estimates (Cardio Fitness) from that time fill in the VO2 max chart.

Apple workouts get IDs from APPLE_ID_BASE up (base + start time in seconds), far above
Garmin's, so they never collide; syncs leave them alone. Importing again updates them in
place. The export is read in one pass, keeping only what's needed, so even a multi-gigabyte
file takes a minute or two.
"""

from __future__ import annotations

import io
import json
import logging
import math
import re
import sqlite3
import zipfile
from array import array
from bisect import bisect_left, bisect_right
from calendar import timegm
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from xml.etree.ElementTree import iterparse

from . import db

log = logging.getLogger(__name__)

APPLE_ID_BASE = 8_000_000_000_000_000  # + start time (Unix seconds); Garmin's IDs are ~1e10
KINDS = {  # Apple's workout type -> (outdoor type, indoor type), in Garmin's names
    "HKWorkoutActivityTypeRunning": ("running", "treadmill_running"),
    "HKWorkoutActivityTypeCycling": ("cycling", "indoor_cycling"),
    "HKWorkoutActivityTypeWalking": ("walking", "walking"),
    "HKWorkoutActivityTypeHiking": ("hiking", "hiking"),
}
NAMES = {"running": "Run", "treadmill_running": "Treadmill run", "cycling": "Ride", "indoor_cycling": "Indoor ride",
         "walking": "Walk", "hiking": "Hike"}
SERIES = {  # samples kept for building streams
    "HKQuantityTypeIdentifierHeartRate": "hr",
    "HKQuantityTypeIdentifierStepCount": "steps",
    "HKQuantityTypeIdentifierRunningPower": "power",
    "HKQuantityTypeIdentifierCyclingPower": "power",
    "HKQuantityTypeIdentifierDistanceWalkingRunning": "dist",
    "HKQuantityTypeIdentifierDistanceCycling": "dist",
}
HR_GAP_S = 30  # longer than this without a heart-rate sample: no heart rate there


def is_apple(activity_id: int) -> bool:
    return activity_id >= APPLE_ID_BASE


# ---------------------------------------------------------------- dates

def _epoch(s: str) -> float:
    """'2023-05-01 07:03:05 -0700' -> Unix seconds (fast: millions of these)."""
    t = timegm((int(s[0:4]), int(s[5:7]), int(s[8:10]), int(s[11:13]), int(s[14:16]), int(s[17:19])))
    sign = -1 if s[20] == "-" else 1
    return t - sign * (int(s[21:23]) * 3600 + int(s[23:25]) * 60)


def _local(s: str) -> str:
    """'2023-05-01 07:03:05 -0700' -> '2023-05-01 07:03:05' (local time where it happened)."""
    return s[:19]


def _gmt(s: str) -> str:
    return datetime.fromtimestamp(_epoch(s), tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------- reading the export

class Export:
    """export.zip, the unzipped folder, or export.xml itself."""

    def __init__(self, path: Path | str):
        self.path = Path(path).expanduser()
        self.zip = zipfile.ZipFile(self.path) if self.path.suffix.lower() == ".zip" else None
        if self.zip:
            names = self.zip.namelist()
            xml = [n for n in names if n.endswith("/export.xml") or n == "export.xml"]
            if not xml:
                raise ValueError("This zip has no export.xml. Export it from the Health app: your picture → Export All Health Data.")
            self.xml_name = xml[0]
            self.root = self.xml_name[: -len("export.xml")]
        else:
            self.xml_path = self.path / "export.xml" if self.path.is_dir() else self.path
            if not self.xml_path.exists():
                raise ValueError(f"No export.xml at {self.xml_path}")
            self.root = self.xml_path.parent

    def xml(self):
        return self.zip.open(self.xml_name) if self.zip else open(self.xml_path, "rb")

    def routes(self) -> list[str]:
        """Every GPS route file in the export, as references file() takes."""
        if self.zip:
            prefix = self.root + "workout-routes/"
            return ["/" + n[len(self.root):] for n in self.zip.namelist()
                    if n.startswith(prefix) and n.lower().endswith(".gpx")]
        folder = Path(self.root) / "workout-routes"
        return sorted(f"/workout-routes/{p.name}" for p in folder.glob("*.gpx")) if folder.is_dir() else []

    def first_time(self, ref: str) -> float | None:
        """When a route starts (its first point's time), reading only the start of the file."""
        try:
            if self.zip:
                with self.zip.open(self.root + ref.lstrip("/")) as f:
                    head = f.read(8192)
            else:
                with open(Path(self.root) / ref.lstrip("/"), "rb") as f:
                    head = f.read(8192)
        except (KeyError, OSError):
            return None
        m = _GPX_TIME.search(head)
        try:
            return _iso_epoch(m.group(1).decode()) if m else None
        except ValueError:
            return None

    def file(self, ref: str) -> bytes | None:
        """A file the XML refers to, like '/workout-routes/route_2023-05-01_7.35am.gpx'."""
        ref = ref.lstrip("/")
        try:
            if self.zip:
                return self.zip.read(self.root + ref)
            return (Path(self.root) / ref).read_bytes()
        except (KeyError, OSError):
            return None


def _meta(el) -> dict[str, str]:
    return {m.get("key"): m.get("value") for m in el.findall("MetadataEntry")}


def _quantity(value: str | None, to: str) -> float | None:
    """'4500 cm' -> 45.0 (to 'm'); plain numbers pass through."""
    if not value:
        return None
    parts = value.split()
    try:
        v = float(parts[0])
    except ValueError:
        return None
    unit = parts[1] if len(parts) > 1 else to
    factor = {("cm", "m"): 0.01, ("m", "m"): 1, ("km", "m"): 1000, ("mi", "m"): 1609.344, ("ft", "m"): 0.3048}
    return v * factor.get((unit, to), 1)


def _distance_m(value: str | None, unit: str | None) -> float | None:
    if value is None:
        return None
    return float(value) * {"km": 1000, "mi": 1609.344, "m": 1, "yd": 0.9144}.get(unit or "km", 1000)


SPANS = ("steps", "dist")  # samples that cover a stretch of time rather than a moment


def read(export: Export, before: float | None = None) -> tuple[list[dict[str, Any]], dict[str, tuple], list[dict]]:
    """Workouts, the sample series (sorted by time), and VO2 max readings, from one pass over
    export.xml. Only things that start before ``before`` (Unix seconds) are kept.

    Moment samples (heart rate, power) are (times, values); span samples (steps, distance) are
    (starts, ends, values, sources), the source being a number per device, as in each workout's
    "source_id": an iPhone in your pocket counts steps and distance too, on top of the watch's."""
    workouts: list[dict[str, Any]] = []
    series: dict[str, tuple] = {k: (array("d"), array("d")) for k in ("hr", "power")}
    series.update({k: (array("d"), array("d"), array("d"), array("d")) for k in SPANS})
    vo2: list[dict] = []
    sources: dict[str | None, int] = {}
    limit = before or float("inf")
    with export.xml() as f:
        root = None
        for event, el in iterparse(f, events=("start", "end")):
            if event == "start":
                if root is None:
                    root = el
                continue
            tag = el.tag
            if tag == "Record":
                kind = el.get("type")
                key = SERIES.get(kind)
                if key or kind == "HKQuantityTypeIdentifierVO2Max":
                    start = el.get("startDate")
                    t = _epoch(start) if start else None
                    try:
                        value = float(el.get("value"))
                    except (TypeError, ValueError):
                        value = None
                    if t is not None and t < limit and value is not None:
                        if key in SPANS:
                            if key == "dist":
                                value = _distance_m(el.get("value"), el.get("unit")) or 0.0
                            end = el.get("endDate")
                            col = series[key]
                            col[0].append(t)
                            col[1].append(_epoch(end) if end else t)
                            col[2].append(value)
                            col[3].append(sources.setdefault(el.get("sourceName"), len(sources)))
                        elif key:
                            series[key][0].append(t)
                            series[key][1].append(value)
                        else:
                            vo2.append({"date": start[:10], "value": value})
            elif tag == "Workout":
                kind = KINDS.get(el.get("workoutActivityType"))
                start, end = el.get("startDate"), el.get("endDate")
                if kind and start and end and _epoch(start) < limit:
                    w = _workout(el, kind)
                    w["source_id"] = sources.setdefault(w["source"], len(sources))
                    workouts.append(w)
            else:
                continue
            el.clear()
            if root is not None:
                root.clear()  # drop finished elements, or millions of empty ones pile up
    for key, cols in series.items():
        order = sorted(range(len(cols[0])), key=cols[0].__getitem__)
        series[key] = tuple(array("d", (c[i] for i in order)) for c in cols)
    return workouts, series, vo2


def _workout(el, kind: tuple[str, str]) -> dict[str, Any]:
    # the workout's own metadata, then any its WorkoutActivity segments carry (iOS 16 on)
    meta = {k: v for act in el.findall("WorkoutActivity") for k, v in _meta(act).items()} | _meta(el)
    indoor = meta.get("HKIndoorWorkout") == "1"
    w = {"start": el.get("startDate"), "end": el.get("endDate"), "type": kind[1] if indoor else kind[0],
         "indoor": indoor, "source": el.get("sourceName"),
         "duration_s": float(el.get("duration") or 0) * {"min": 60, "s": 1, "hr": 3600}.get(el.get("durationUnit") or "min", 60),
         "distance_m": _distance_m(el.get("totalDistance"), el.get("totalDistanceUnit")),
         "calories": float(el.get("totalEnergyBurned")) if el.get("totalEnergyBurned") else None,
         "elevation_gain_m": _quantity(meta.get("HKElevationAscended"), "m"),
         "route": None, "pauses": []}
    # Newer exports put the totals in WorkoutStatistics: under the workout, or (iOS 16 on) only
    # inside each of its WorkoutActivity segments, which then add up
    stats = el.findall("WorkoutStatistics")
    nested = [s for act in el.findall("WorkoutActivity") for s in act.findall("WorkoutStatistics")]
    for group in (stats, nested):
        dist = [_distance_m(s.get("sum"), s.get("unit")) for s in group if "Distance" in (s.get("type") or "") and s.get("sum")]
        kcal = [float(s.get("sum")) for s in group
                if s.get("type") == "HKQuantityTypeIdentifierActiveEnergyBurned" and s.get("sum")]
        if w["distance_m"] is None and dist:
            w["distance_m"] = dist[0] if group is stats else sum(dist)
        if w["calories"] is None and kcal:
            w["calories"] = kcal[0] if group is stats else sum(kcal)
    for ev in el.findall("WorkoutEvent"):  # pauses, to know when the watch wasn't recording
        if ev.get("type") in ("HKWorkoutEventTypePause", "HKWorkoutEventTypeMotionPaused"):
            w["pauses"].append(["pause", _epoch(ev.get("date"))])
        elif ev.get("type") in ("HKWorkoutEventTypeResume", "HKWorkoutEventTypeMotionResumed"):
            w["pauses"].append(["resume", _epoch(ev.get("date"))])
    route = el.find("WorkoutRoute")
    if route is not None:
        ref = route.find("FileReference")
        w["route"] = ref.get("path") if ref is not None else None
    return w


# ---------------------------------------------------------------- GPS routes

_GPX_TIME = re.compile(rb"<trkpt[^>]*>.*?<time>\s*([^<\s]+)", re.S)
_ISO_TZ = re.compile(r"([+-])(\d\d):?(\d\d)$")


def _iso_epoch(s: str) -> float:
    """A GPX timestamp -> Unix seconds: '2021-03-04T15:30:12Z', with fractions of a second, or
    with an offset like '2021-03-04T08:30:12-07:00' (some routes are written in local time)."""
    s = s.strip()
    t = timegm(datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").timetuple())
    m = _ISO_TZ.search(s[19:])
    if m:
        t -= (1 if m.group(1) == "+" else -1) * (int(m.group(2)) * 3600 + int(m.group(3)) * 60)
    return t


class RouteIndex:
    """The export's route files by start time, for workouts whose route the XML doesn't name,
    or names wrongly. Some exports list the routes apart from their workouts, or not at all,
    though the files are there. Built the first time it's needed."""

    EARLY_S = 600  # the GPS can start logging a while before the workout does

    def __init__(self, export: Export, named: set[str]):
        self.export, self.named, self.starts, self.used = export, named, None, set()

    def find(self, t0: float, t1: float) -> str | None:
        if self.starts is None:
            self.starts = sorted((t, ref) for ref in self.export.routes()
                                 if ref not in self.named and (t := self.export.first_time(ref)) is not None)
            self.times = [t for t, _ in self.starts]
        i = bisect_left(self.times, t0 - self.EARLY_S)
        while i < len(self.times) and self.times[i] < t1:
            ref = self.starts[i][1]
            if ref not in self.used:
                self.used.add(ref)
                return ref
            i += 1
        return None


def _route_points(export: Export, ref: str | None, t0: float, t1: float) -> tuple[list, str | None]:
    """The route's points if they cover the workout, else ([], why not)."""
    if not ref:
        return [], "none"
    data = export.file(ref)
    if data is None:
        return [], "missing"
    try:
        points = gpx_points(data)
    except Exception as err:  # one bad route file shouldn't stop the import
        log.warning("Couldn't read the route %s: %s", ref, err)
        return [], "unreadable"
    if not any(t0 - 60 <= p[0] <= t1 + 60 for p in points):
        return [], "times"
    return points, None


def gpx_points(data: bytes) -> list[tuple[float, float, float, float | None, float | None]]:
    """(time, lat, lon, elevation, speed) for each point of a workout route."""
    out = []
    for _, el in iterparse(io.BytesIO(data), events=("end",)):
        if el.tag.endswith("trkpt"):
            t = ele = speed = None
            for child in el:
                name = child.tag.rsplit("}", 1)[-1]
                if name == "time" and child.text:
                    t = _iso_epoch(child.text)
                elif name == "ele" and child.text:
                    ele = float(child.text)
                elif name == "extensions":
                    for x in child:
                        if x.tag.rsplit("}", 1)[-1] == "speed" and x.text:
                            speed = float(x.text)
            if t is not None:
                out.append((t, float(el.get("lat")), float(el.get("lon")), ele, speed))
            el.clear()
    out.sort()
    return out


def _meters(a: tuple[float, float], b: tuple[float, float]) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(min(1.0, h)))


# ---------------------------------------------------------------- streams

def _window(series: tuple, t0: float, t1: float) -> tuple[list[float], list[float]]:
    ts, vs = series
    i, j = bisect_left(ts, t0), bisect_right(ts, t1)
    return list(ts[i:j]), list(vs[i:j])


def _interp(ts: list[float], vs: list[float], t: float, gap: float) -> float | None:
    if not ts:
        return None
    i = bisect_left(ts, t)
    if i < len(ts) and ts[i] == t:
        return vs[i]
    if i == 0 or i == len(ts):
        k = 0 if i == 0 else len(ts) - 1
        return vs[k] if abs(ts[k] - t) <= gap / 2 else None
    a, b = ts[i - 1], ts[i]
    if b - a > gap:
        return None
    return vs[i - 1] + (vs[i] - vs[i - 1]) * (t - a) / (b - a)


def _spans(series: tuple, t0: float, t1: float, source: int | None) -> list[tuple[float, float, float]]:
    """(start, end, value) of the span samples starting in [t0, t1], from the workout's own device
    when it recorded any there (else from every device: an older export without watch samples)."""
    starts, ends, vals, srcs = series
    ks = range(bisect_left(starts, t0), bisect_right(starts, t1))
    own = [k for k in ks if srcs[k] == source]
    return [(starts[k], ends[k], vals[k]) for k in (own or ks)]


def streams_for(w: dict[str, Any], series: dict[str, tuple], points: list) -> dict[str, list]:
    """Second-by-second streams in the dashboard's format, from the route and the samples."""
    t0, t1 = _epoch(w["start"]), _epoch(w["end"])
    n = int(t1 - t0) + 1
    out: dict[str, list] = {k: [None] * n for k in ("hr", "speed", "distance", "cadence", "altitude", "power", "lat", "lon")}
    out["t"] = list(range(n))
    # heart rate and power: sampled every few seconds during a workout
    hts, hvs = _window(series.get("hr", (array("d"), array("d"))), t0 - HR_GAP_S, t1 + HR_GAP_S)
    pts_, pvs = _window(series.get("power", (array("d"), array("d"))), t0 - 10, t1 + 10)
    for i in range(n):
        h = _interp(hts, hvs, t0 + i, HR_GAP_S)
        out["hr"][i] = round(h) if h is not None else None
        p = _interp(pts_, pvs, t0 + i, 10)
        out["power"][i] = round(p) if p is not None else None
    if points:
        # position, elevation and distance from the route, one value per second
        pts = [p for p in points if t0 - 1 <= p[0] <= t1 + 1]
        cum, total = [], 0.0
        for k, p in enumerate(pts):
            if k:
                step = _meters(pts[k - 1][1:3], p[1:3])
                # a jump after a pause or GPS gap isn't distance run
                if p[0] - pts[k - 1][0] <= 30 or step < 15 * (p[0] - pts[k - 1][0]):
                    total += step
            cum.append(total)
        ts = [p[0] for p in pts]
        for i in range(n):
            t = t0 + i
            j = bisect_left(ts, t)
            near = [k for k in (j - 1, j) if 0 <= k < len(ts)]
            if near:
                k = min(near, key=lambda k: abs(ts[k] - t))
                if abs(ts[k] - t) <= 2:  # the nearest route point, if the watch had a fix then
                    out["lat"][i], out["lon"][i], out["altitude"][i] = pts[k][1], pts[k][2], pts[k][3]
            d = _interp(ts, cum, t, 30)
            out["distance"][i] = d
        # speed: distance over a short window (the GPX speed values are noisy)
        for i in range(n):
            a, b = max(0, i - 5), min(n - 1, i + 5)
            da, db_ = out["distance"][a], out["distance"][b]
            out["speed"][i] = (db_ - da) / (b - a) if da is not None and db_ is not None and b > a else None
    else:
        # indoors: distance from the watch's own distance samples, each counted at its end
        spans = _spans(series["dist"], t0 - 60, t1, w.get("source_id")) if "dist" in series else []
        if spans:
            pts = sorted((e, v) for _, e, v in spans)
            ts, cum, total = [t0], [0.0], 0.0
            for e, v in pts:
                total += v
                ts.append(e)
                cum.append(total)
            for i in range(n):
                out["distance"][i] = _interp(ts, cum, t0 + i, 120)
            for i in range(n):
                a, b = max(0, i - 10), min(n - 1, i + 10)
                da, db_ = out["distance"][a], out["distance"][b]
                out["speed"][i] = (db_ - da) / (b - a) if da is not None and db_ is not None and b > a else None
    # cadence from step counts (steps per minute, both feet), runs and walks only
    if w["type"] not in ("cycling", "indoor_cycling"):
        for a, b, v in (_spans(series["steps"], t0 - 60, t1, w.get("source_id")) if "steps" in series else []):
            if b - a >= 5:
                spm = v / (b - a) * 60
                if 60 <= spm <= 260:
                    for i in range(max(0, int(a - t0)), min(n, int(b - t0) + 1)):
                        out["cadence"][i] = round(spm)
    return out


# ---------------------------------------------------------------- the import

def _activity(w: dict[str, Any], streams: dict[str, list], aid: int, start_point) -> dict[str, Any]:
    hr = [h for h in streams["hr"] if h]
    dist = w["distance_m"] or next((d for d in reversed(streams["distance"]) if d is not None), None)
    duration = w["duration_s"] or (_epoch(w["end"]) - _epoch(w["start"]))
    # moving time: all but the seconds you were seen standing still (a gap in the data isn't a stop)
    stopped = sum(1 for s in streams["speed"] if s is not None and s <= 0.5)
    moving = (len(streams["speed"]) - stopped) if any(s is not None for s in streams["speed"]) else None
    a = {
        "activityId": aid, "activityName": NAMES.get(w["type"], "Workout"),
        "startTimeLocal": _local(w["start"]), "startTimeGMT": _gmt(w["start"]),
        "activityType": {"typeKey": w["type"]}, "distance": dist, "duration": duration,
        "movingDuration": min(moving, duration) if moving else None,
        "elevationGain": w["elevation_gain_m"], "averageHR": sum(hr) / len(hr) if hr else None,
        "maxHR": max(hr) if hr else None, "averageSpeed": dist / duration if dist and duration else None,
        "calories": w["calories"], "source": "apple", "sourceName": w["source"],
    }
    if start_point:
        a["startLatitude"], a["startLongitude"] = start_point
    return a


def climb_m(altitude: list[float | None], threshold: float = 3.0) -> float | None:
    """Total ascent from a GPS elevation track: rises count once they top ``threshold`` metres,
    so GPS jitter up and down on the flat doesn't add up to a hill."""
    total, low, have = 0.0, None, False
    for a in altitude:
        if a is None:
            continue
        have = True
        if low is None or a < low:
            low = a
        elif a - low >= threshold:
            total += a - low
            low = a
    return round(total, 1) if have else None


def same_run(a: tuple[float, float], b: tuple[float, float]) -> bool:
    """Two workouts overlapping for more than half of the shorter one: one run recorded twice."""
    overlap = min(a[1], b[1]) - max(a[0], b[0])
    return overlap > 0.5 * max(1.0, min(a[1] - a[0], b[1] - b[0]))


def dedupe(workouts: list[dict[str, Any]], series: dict[str, tuple]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """One workout per run. Two apps can record the same run and both write it to Apple Health
    (the Workout app on the watch and a running app on the phone, say); the best-recorded copy
    stays: with a GPS route, then with heart rate, then from a watch, then the longest."""
    hr_times = series.get("hr", (array("d"),))[0]

    def score(w: dict[str, Any]) -> tuple:
        t0, t1 = _epoch(w["start"]), _epoch(w["end"])
        hr = bisect_right(hr_times, t1) - bisect_left(hr_times, t0)
        return (bool(w["route"]), hr > 0, "watch" in (w["source"] or "").lower(), w["distance_m"] or 0)

    kept: list[tuple[tuple[float, float], dict[str, Any]]] = []
    dropped = []
    for w in sorted(workouts, key=score, reverse=True):
        span = (_epoch(w["start"]), _epoch(w["end"]))
        if any(same_run(span, s) for s, _ in kept):
            dropped.append(w)
        else:
            kept.append((span, w))
    return sorted((w for _, w in kept), key=lambda w: _epoch(w["start"])), dropped


def import_export(conn: sqlite3.Connection, path: Path | str, before: str | None = None) -> dict[str, int]:
    """Import an Apple Health export. Returns counts: imported, with_route (outdoor workouts
    with a GPS route), no_route (outdoor workouts whose route was missing), skipped
    (overlapping), vo2max."""
    export = Export(path)
    garmin_first = conn.execute(
        "SELECT min(start_time_gmt) FROM activities WHERE activity_id < ?", (APPLE_ID_BASE,)).fetchone()[0]
    limit = None
    if before:
        limit = timegm(datetime.fromisoformat(before).timetuple())
    elif garmin_first:
        limit = timegm(datetime.fromisoformat(garmin_first.replace(" ", "T")[:19]).timetuple())
    log.info("Reading %s%s…", export.path.name, f" (workouts before {datetime.fromtimestamp(limit, tz=timezone.utc):%b %-d, %Y})" if limit else "")
    workouts, series, vo2 = read(export, limit)
    index = RouteIndex(export, {w["route"] for w in workouts if w["route"]})
    workouts, dropped = dedupe(workouts, series)
    # a copy an earlier import brought in before duplicates were caught
    db.delete_activities(conn, [APPLE_ID_BASE + int(_epoch(w["start"])) for w in dropped])
    duplicates = len(dropped)
    # what's already there, as (start, end) in Unix seconds, so nothing is imported twice
    taken = []
    for start, dur, aid in conn.execute("SELECT start_time_gmt, duration_s, activity_id FROM activities WHERE start_time_gmt IS NOT NULL"):
        if is_apple(aid):
            continue
        s = timegm(datetime.fromisoformat(start.replace(" ", "T")[:19]).timetuple())
        taken.append((s, s + (dur or 0)))
    counts: dict[str, Any] = {"imported": 0, "with_route": 0, "no_route": 0, "skipped": 0, "vo2max": 0,
                              "duplicates": duplicates, "matched": 0, "why_no_route": {}, "no_route_days": []}
    for w in workouts:
        t0, t1 = _epoch(w["start"]), _epoch(w["end"])
        if any(a < t1 and t0 < b for a, b in taken):
            counts["skipped"] += 1
            continue
        points: list = []
        if not w["indoor"]:
            points, why = _route_points(export, w["route"], t0, t1)
            if not points and (ref := index.find(t0, t1)):  # the right file under another name
                points, _ = _route_points(export, ref, t0, t1)
                counts["matched"] += bool(points)
            if points:
                counts["with_route"] += 1
            else:
                counts["no_route"] += 1
                counts["why_no_route"][why] = counts["why_no_route"].get(why, 0) + 1
                counts["no_route_days"].append(f"{_local(w['start'])[:16]} {w['type']}")
        streams = streams_for(w, series, points)
        if w["elevation_gain_m"] is None and not w["indoor"]:  # older workouts: work it out from the route
            w["elevation_gain_m"] = climb_m(streams["altitude"])
        aid = APPLE_ID_BASE + int(t0)
        start_point = next(((la, lo) for la, lo in zip(streams["lat"], streams["lon"]) if la is not None), None)
        db.upsert_activities(conn, [_activity(w, streams, aid, start_point)])
        db.save_streams(conn, aid, streams, external_hr=False)
        # what was worked out from the old streams goes: analyzed afresh, weather looked up again
        # (now perhaps with a route), and the map track and phone copy rebuilt
        for table in ("activity_metrics", "weather", "heatmap_tracks", "export_streams"):
            conn.execute(f"DELETE FROM {table} WHERE activity_id = ?", (aid,))
        counts["imported"] += 1
        if counts["imported"] % 50 == 0:
            conn.commit()
            log.info("Imported %d workouts", counts["imported"])
    # Apple's VO2 max (Cardio Fitness): one reading per day, for days Garmin doesn't cover
    by_day: dict[str, float] = {}
    for r in vo2:
        by_day[r["date"]] = r["value"]
    rows = [{"date": d, "sport": "running", "value": round(v, 1), "raw_json": json.dumps({"source": "apple"})}
            for d, v in sorted(by_day.items())]
    existing = {r[0] for r in conn.execute("SELECT date FROM vo2max WHERE sport = 'running'")}
    rows = [r for r in rows if r["date"] not in existing]
    if rows:
        db.upsert_vo2max(conn, rows)
    counts["vo2max"] = len(rows)
    conn.commit()
    return counts
