"""`garmin dashboard`: opening one that's already running, and --stop."""

from __future__ import annotations

import subprocess

from garmin_connector import cli


def test_stop_leaves_unrelated_processes_alone(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("GARMIN_CONNECTOR_HOME", str(tmp_path))
    other = subprocess.Popen(["sleep", "30"])
    try:
        (tmp_path / "dashboard.pid").write_text(str(other.pid))  # stale: that ID now belongs to something else
        cli.dashboard(8799, browser=False, stop=True)
        assert "No dashboard" in capsys.readouterr().out
        assert other.poll() is None  # still running
        assert not (tmp_path / "dashboard.pid").exists()
    finally:
        other.kill()


def test_already_running_just_opens_it(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("GARMIN_CONNECTOR_HOME", str(tmp_path))
    monkeypatch.setattr(cli, "_running", lambda url: True)
    opened = []
    monkeypatch.setattr(cli.webbrowser, "open", opened.append)
    cli.dashboard(8799)
    assert opened == ["http://127.0.0.1:8799"] and "already running" in capsys.readouterr().out
    assert not (tmp_path / "dashboard.pid").exists()  # didn't start a second one
