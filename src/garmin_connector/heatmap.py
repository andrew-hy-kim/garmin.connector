"""Every GPS track, simplified, for the heatmap of where you run.

Tracks are thinned with the Douglas-Peucker method (points closer than a few meters
to the line between their neighbours are dropped), which keeps every turn while
cutting a typical run from thousands of points to a couple of hundred. Each
simplified track is cached, so only new runs are processed.
"""

from __future__ import annotations

import json
import math
import sqlite3
from typing import Any

from . import db

TOLERANCE_M = 6.0
CACHE_KEY = f"dp{TOLERANCE_M:g}"
_M_PER_DEG = 111_320.0


def simplify(points: list[tuple[float, float]], tolerance_m: float = TOLERANCE_M) -> list[tuple[float, float]]:
    """Douglas-Peucker on lat/lon, measured in meters (flat-earth, fine at running scale)."""
    if len(points) < 3:
        return points
    k = math.cos(math.radians(points[0][0]))
    xy = [(lon * _M_PER_DEG * k, lat * _M_PER_DEG) for lat, lon in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = xy[a], xy[b]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy)
        worst, idx = 0.0, -1
        for i in range(a + 1, b):
            x, y = xy[i]
            d = abs(dy * (x - x1) - dx * (y - y1)) / norm if norm else math.hypot(x - x1, y - y1)
            if d > worst:
                worst, idx = d, i
        if worst > tolerance_m:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k_ in zip(points, keep) if k_]


def track(conn: sqlite3.Connection, activity_id: int) -> list[list[float]] | None:
    row = conn.execute("SELECT key, data FROM heatmap_tracks WHERE activity_id = ?", (activity_id,)).fetchone()
    if row and row[0] == CACHE_KEY:
        return json.loads(row[1]) or None
    loaded = db.load_streams(conn, activity_id)
    pts: list[list[float]] = []
    if loaded:
        s = loaded[0]
        raw = [(la, lo) for la, lo in zip(s.get("lat") or [], s.get("lon") or []) if la is not None and lo is not None]
        pts = [[round(la, 5), round(lo, 5)] for la, lo in simplify(raw)]
    conn.execute("INSERT OR REPLACE INTO heatmap_tracks (activity_id, key, data) VALUES (?, ?, ?)",
                 (activity_id, CACHE_KEY, json.dumps(pts, separators=(",", ":"))))
    conn.commit()
    return pts or None


def tracks(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """[{"id": activity_id, "track": [[lat, lon], ...]}] for every activity with GPS."""
    ids = [r[0] for r in conn.execute("SELECT activity_id FROM streams ORDER BY activity_id")]
    out = []
    for activity_id in ids:
        t = track(conn, activity_id)
        if t and len(t) >= 2:
            out.append({"id": activity_id, "track": t})
    return out
