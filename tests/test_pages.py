from __future__ import annotations

import re

from garmin_connector.web import STATIC

PAGES = ["index.html", "activities.html", "map.html", "activity.html", "recap.html"]


def test_every_page_has_the_same_tabs():
    """Each page carries its own copy of the tab bar; they must match (no Today tab left behind)."""
    tabs = {p: re.search(r'<nav class="tabs".*?</nav>', (STATIC / p).read_text(), re.S).group(0) for p in PAGES}
    assert len(set(tabs.values())) == 1, "tab bars differ between pages"
    nav = tabs["index.html"]
    assert re.findall(r'data-page="(\w+)"', nav) == ["progress", "activities", "map", "recap", "plan"]
    assert '<a href="/" data-page="progress">' in nav


def test_pages_sharing_start_js_load_every_script_it_needs():
    """Progress and Activities share start.js, which calls render functions from the other files;
    a page that leaves one out fails with "… is not defined" (renderRecovery on Activities, once)."""
    scripts = {p: re.findall(r'<script src="/static/([\w.-]+)"', (STATIC / p).read_text()) for p in PAGES}
    defined = {f: set(re.findall(r"^(?:async )?function (\w+)", (STATIC / f).read_text(), re.M))
               for f in {s for ss in scripts.values() for s in ss} if not f.endswith(".min.js")}
    called = set(re.findall(r"\b(render\w+)\(", (STATIC / "start.js").read_text()))
    for page, ss in scripts.items():
        if "start.js" not in ss:
            continue
        have = set().union(*(defined.get(s, set()) for s in ss))
        missing = sorted(called - have)
        assert not missing, f"{page} doesn't load the file defining {missing}"
