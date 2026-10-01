"""Where things live on disk.

Everything goes in one folder (default ``~/.garmin-connector``) so it is easy
to find, back up, or delete. Set ``GARMIN_CONNECTOR_HOME`` to move it.
"""

from __future__ import annotations

import os
from pathlib import Path


def home_dir() -> Path:
    path = Path(os.environ.get("GARMIN_CONNECTOR_HOME", "~/.garmin-connector")).expanduser()
    path.mkdir(parents=True, exist_ok=True)
    # Login tokens live here, so keep it private to your user account.
    path.chmod(0o700)
    return path


def db_path() -> Path:
    return home_dir() / "garmin.db"


def token_dir() -> Path:
    path = home_dir() / "tokens"
    path.mkdir(exist_ok=True)
    path.chmod(0o700)
    return path


def fit_dir() -> Path:
    path = home_dir() / "fit"
    path.mkdir(exist_ok=True)
    return path
