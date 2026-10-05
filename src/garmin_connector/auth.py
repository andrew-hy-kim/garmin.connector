"""Logging in to Garmin Connect.

The first ``garmin login`` asks for your email and password, saves
the password in the macOS Keychain, and saves Garmin's login tokens to
``~/.garmin-connector/tokens``. Later runs (including the scheduled background
sync) reuse the tokens, and only fall back to the Keychain password if the
tokens have expired.
"""

from __future__ import annotations

import getpass
import json

import keyring
from garminconnect import Garmin

from . import config

KEYCHAIN_SERVICE = "garmin-connector"
_EMAIL_FILE = "account.json"


def _saved_email() -> str | None:
    path = config.home_dir() / _EMAIL_FILE
    if path.exists():
        return json.loads(path.read_text()).get("email")
    return None


def login_interactive() -> Garmin:
    """Prompt for credentials, log in, and remember them for later runs."""
    email = input(f"Garmin email [{_saved_email() or ''}]: ").strip() or _saved_email()
    if not email:
        raise SystemExit("An email address is required.")
    password = getpass.getpass("Garmin password: ")

    client = Garmin(email, password)
    client.login(str(config.token_dir()))

    keyring.set_password(KEYCHAIN_SERVICE, email, password)
    (config.home_dir() / _EMAIL_FILE).write_text(json.dumps({"email": email}))
    return client


def get_client() -> Garmin:
    """Return a logged-in client without prompting (safe for background runs)."""
    email = _saved_email()
    if not email:
        raise SystemExit("Not logged in yet. Run: garmin login")
    password = keyring.get_password(KEYCHAIN_SERVICE, email)
    # Tokens are tried first; the password is only used if they have expired.
    client = Garmin(email, password)
    client.login(str(config.token_dir()))
    return client


def logout() -> None:
    email = _saved_email()
    if email:
        try:
            keyring.delete_password(KEYCHAIN_SERVICE, email)
        except keyring.errors.PasswordDeleteError:
            pass
    for path in config.token_dir().glob("*"):
        path.unlink()
    (config.home_dir() / _EMAIL_FILE).unlink(missing_ok=True)
