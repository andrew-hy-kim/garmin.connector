"""Copies of your database in ``~/.garmin-connector/backups``.

A sync makes one when the newest copy is a week old, and the commands that rewrite
the database (``garmin analyze``, ``garmin weather --redo``, ``garmin import-apple``)
make one first. The last few are kept; at most one per day. Restoring is copying one
back over ``garmin.db`` (with the dashboard stopped).

The .fit files aren't copied: Garmin keeps the originals, and a sync downloads any
that are missing.
"""

from __future__ import annotations

import logging
import sqlite3
from datetime import date, timedelta
from pathlib import Path

from . import config

log = logging.getLogger(__name__)

KEEP = 4
EVERY_DAYS = 7


def folder() -> Path:
    path = config.home_dir() / "backups"
    path.mkdir(exist_ok=True)
    return path


def existing() -> list[Path]:
    """Backups, oldest first (named garmin-YYYY-MM-DD.db)."""
    return sorted(folder().glob("garmin-????-??-??.db"))


def backup(conn: sqlite3.Connection) -> Path:
    """Copy the database (consistently, even while the dashboard is using it) and drop the oldest copies."""
    path = folder() / f"garmin-{date.today().isoformat()}.db"
    part = path.with_suffix(".part")
    with sqlite3.connect(part) as dest:
        conn.backup(dest)
    dest.close()
    part.replace(path)  # a copy cut short never takes the place of a good one
    for old in existing()[:-KEEP]:
        old.unlink()
    log.info("Backed up the database to %s", path)
    return path


def backup_if_due(conn: sqlite3.Connection) -> Path | None:
    """A backup when the newest is a week old (or there is none). Never stops what called it."""
    try:
        newest = existing()[-1:]
        if newest and date.fromisoformat(newest[0].stem[len("garmin-"):]) > date.today() - timedelta(days=EVERY_DAYS):
            return None
        return backup(conn)
    except Exception as err:
        log.warning("Couldn't back up the database: %s", err)
        return None


def backup_quietly(conn: sqlite3.Connection) -> Path | None:
    try:
        return backup(conn)
    except Exception as err:
        log.warning("Couldn't back up the database: %s", err)
        return None
