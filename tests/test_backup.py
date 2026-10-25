"""Backups of the database, and the sync status the dashboard warns from."""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta

import pytest

from garmin_connector import auth, backup, db, sync
from garmin_connector.web import create_app
from test_sync import FakeGarmin, days_ago, make_activity


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "test.db")
    yield c
    c.close()


def test_backup_is_a_working_copy(conn):
    db.upsert_activities(conn, [make_activity(1, days_ago(1))])
    path = backup.backup(conn)
    assert path.name == f"garmin-{date.today().isoformat()}.db"
    with sqlite3.connect(path) as copy:
        assert copy.execute("SELECT count(*) FROM activities").fetchone()[0] == 1


def test_keeps_only_the_latest(conn):
    for n in range(6):
        (backup.folder() / f"garmin-2026-01-0{n + 1}.db").write_bytes(b"")
    backup.backup(conn)
    names = [p.name for p in backup.existing()]
    assert len(names) == backup.KEEP
    assert names[-1] == f"garmin-{date.today().isoformat()}.db" and "garmin-2026-01-01.db" not in names


def test_weekly(conn):
    recent = date.today() - timedelta(days=backup.EVERY_DAYS - 1)
    (backup.folder() / f"garmin-{recent.isoformat()}.db").write_bytes(b"")
    assert backup.backup_if_due(conn) is None
    old = backup.folder() / f"garmin-{recent.isoformat()}.db"
    old.rename(backup.folder() / f"garmin-{(date.today() - timedelta(days=backup.EVERY_DAYS)).isoformat()}.db")
    assert backup.backup_if_due(conn) is not None


def test_run_backs_up_and_remembers_success(conn, monkeypatch):
    monkeypatch.setattr(sync, "REQUEST_PAUSE_S", 0)
    monkeypatch.setattr(auth, "get_client", lambda: FakeGarmin([make_activity(1, days_ago(1))]))
    sync.run(conn, download_fit=False)
    assert backup.existing()
    status = sync.get_status(conn)
    assert status["ok_at"] and "error" not in status


def test_failure_is_remembered_until_a_good_sync(conn, monkeypatch):
    monkeypatch.setattr(sync, "REQUEST_PAUSE_S", 0)

    def expired():
        raise RuntimeError("401 Client Error: Unauthorized")
    monkeypatch.setattr(auth, "get_client", expired)
    with pytest.raises(RuntimeError):
        sync.run(conn)
    status = sync.get_status(conn)
    assert "garmin login" in status["error"] and status["error_at"]

    monkeypatch.setattr(auth, "get_client", lambda: FakeGarmin([]))
    sync.run(conn, download_fit=False)
    assert "error" not in sync.get_status(conn)


def test_dashboard_reports_status(tmp_path, monkeypatch):
    path = tmp_path / "web.db"
    with db.connect(path) as c:
        db.set_text_setting(c, "sync_status", '{"ok_at": "2026-10-01T09:00:00", "error_at": "2026-10-03T09:00:00", "error": "x"}')
    client = create_app(path).test_client()
    assert client.get("/api/sync").get_json()["error"] == "x"

    def not_logged_in():
        raise SystemExit("Not logged in yet. Run: garmin login")
    monkeypatch.setattr(auth, "get_client", not_logged_in)
    r = client.post("/api/sync")
    assert r.status_code == 400 and "garmin login" in r.get_json()["error"]
