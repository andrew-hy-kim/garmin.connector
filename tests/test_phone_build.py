from __future__ import annotations

import filecmp
import json
from pathlib import Path

from garmin_connector import phone_build

REPO = Path(__file__).resolve().parent.parent


def test_phone_pages_are_rewritten():
    html = phone_build.phone_page((phone_build.STATIC / "index.html").read_text())
    assert "/static/" not in html
    assert 'href="index.html"' in html and 'href="plan.html"' in html and 'href="/"' not in html
    assert html.index('src="phone.js"') < html.index('src="common.js"')  # data layer loads first
    assert 'rel="manifest"' in html and 'apple-touch-icon' in html


def test_build_output(tmp_path):
    out = phone_build.build(tmp_path / "docs")
    names = {p.name for p in out.iterdir()}
    for name in ["index.html", "activity.html", "plan.html", "phone.js", "common.js", "sw.js",
                 "manifest.webmanifest", "icon-180.png", ".nojekyll"]:
        assert name in names
    manifest = json.loads((out / "manifest.webmanifest").read_text())
    assert manifest["display"] == "standalone" and manifest["start_url"] == "./index.html"
    sw = (out / "sw.js").read_text()
    assert "__VERSION__" not in sw and '"activity.html"' in sw and '"phone.js"' in sw


def test_docs_folder_is_up_to_date(tmp_path):
    """docs/ is what GitHub Pages serves; rebuild with `python -m garmin_connector.phone_build` after changing static/."""
    fresh = phone_build.build(tmp_path / "docs")
    committed = REPO / "docs"
    cmp = filecmp.dircmp(fresh, committed)
    assert not cmp.left_only and not cmp.right_only, (cmp.left_only, cmp.right_only)
    _, mismatch, errors = filecmp.cmpfiles(fresh, committed, [p.name for p in fresh.iterdir()], shallow=False)
    assert not mismatch and not errors, mismatch
