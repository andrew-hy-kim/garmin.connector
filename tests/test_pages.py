from __future__ import annotations

import re

from garmin_connector.web import STATIC

PAGES = ["index.html", "activities.html", "map.html", "activity.html"]


def test_every_page_has_the_same_tabs():
    """Each page carries its own copy of the tab bar; they must match (no Today tab left behind)."""
    tabs = {p: re.search(r'<nav class="tabs".*?</nav>', (STATIC / p).read_text(), re.S).group(0) for p in PAGES}
    assert len(set(tabs.values())) == 1, "tab bars differ between pages"
    nav = tabs["index.html"]
    assert re.findall(r'data-page="(\w+)"', nav) == ["progress", "activities", "map"]
    assert '<a href="/" data-page="progress">' in nav
