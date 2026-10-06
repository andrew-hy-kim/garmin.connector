from __future__ import annotations

from datetime import date, timedelta

from fitgen import steady_run
from garmin_connector import db, heatmap
from test_sessions import _add


def test_simplify_keeps_turns_and_drops_straight_points():
    straight = [(47.6 + i * 1e-4, -122.3) for i in range(100)]
    assert heatmap.simplify(straight) == [straight[0], straight[-1]]
    corner = straight + [(47.6 + 99e-4, -122.3 + i * 1e-4) for i in range(1, 100)]
    out = heatmap.simplify(corner)
    assert len(out) == 3 and out[1] == straight[-1]


def test_tracks_are_cached(tmp_path):
    c = db.connect(tmp_path / "h.db")
    _add(c, tmp_path, 1, (date.today() - timedelta(days=1)).isoformat(), *steady_run(minutes=20))
    first = heatmap.tracks(c)
    if not first:  # the synthetic run may have no GPS; nothing to draw then
        assert c.execute("SELECT count(*) FROM heatmap_tracks").fetchone()[0] == 1
        return
    assert first[0]["id"] == 1 and len(first[0]["track"]) >= 2
    assert heatmap.tracks(c) == first
