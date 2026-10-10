"""Automatic updates for the phone app: an encrypted copy of its data file, on GitHub.

The phone app runs on GitHub Pages and can't read iCloud Drive by itself. So after each
export, the data file is encrypted with a passphrase you choose and uploaded to the
``phone-data`` branch of the same repository, replacing the last copy (each upload is a
fresh commit with no history, so old copies don't pile up). When you open the phone app
it checks a small stamp file there and, when it changed, downloads and decrypts the data.

The repository is public, so the data is only ever uploaded encrypted: AES-256-GCM with a
key derived from your passphrase (PBKDF2-SHA256, 600,000 rounds). Without the passphrase
the file is unreadable. The GitHub token (allowed to change only this repository) and the
passphrase are kept in the macOS Keychain.

File layout: ``GDE1`` | salt (16 bytes) | rounds (uint32, big-endian) | IV (12 bytes) |
ciphertext with the GCM tag. The plaintext is the gzip data file itself.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import re
import sqlite3
import struct
import subprocess
from pathlib import Path

import keyring
import requests
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from . import db

log = logging.getLogger(__name__)

BRANCH = "phone-data"
DATA_FILE, STAMP_FILE = "data.bin", "stamp.txt"
MAGIC = b"GDE1"
ROUNDS = 600_000
KEYCHAIN_SERVICE = "garmin-connector"
TOKEN_USER, PASSPHRASE_USER = "github-token", "phone-passphrase"
API = "https://api.github.com"
TIMEOUT_S = 60


# ---------------------------------------------------------------- encryption

def derive_key(passphrase: str, salt: bytes, rounds: int = ROUNDS) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=rounds)
    return kdf.derive(passphrase.encode())


def encrypt(data: bytes, passphrase: str, salt: bytes, rounds: int = ROUNDS) -> bytes:
    iv = os.urandom(12)
    sealed = AESGCM(derive_key(passphrase, salt, rounds)).encrypt(iv, data, None)
    return MAGIC + salt + struct.pack(">I", rounds) + iv + sealed


def decrypt(blob: bytes, passphrase: str) -> bytes:
    if blob[:4] != MAGIC:
        raise ValueError("Not an encrypted data file")
    salt, (rounds,), iv = blob[4:20], struct.unpack(">I", blob[20:24]), blob[24:36]
    return AESGCM(derive_key(passphrase, salt, rounds)).decrypt(iv, blob[36:], None)


def stamp(data: bytes) -> str:
    """Changes whenever the data does; the phone compares it before downloading anything."""
    return hashlib.sha256(data).hexdigest()[:32]


# ---------------------------------------------------------------- settings

def _secret(user: str) -> str | None:
    try:
        return keyring.get_password(KEYCHAIN_SERVICE, user)
    except keyring.errors.KeyringError:
        return None


def settings(conn: sqlite3.Connection) -> dict | None:
    """Everything needed to publish, or None when automatic updates aren't set up."""
    repo, salt = db.get_text_setting(conn, "phone_repo"), db.get_text_setting(conn, "phone_salt")
    token, passphrase = _secret(TOKEN_USER), _secret(PASSPHRASE_USER)
    if not (repo and salt and token and passphrase):
        return None
    return {"repo": repo, "salt": bytes.fromhex(salt), "token": token, "passphrase": passphrase}


def save_settings(conn: sqlite3.Connection, repo: str, token: str, passphrase: str) -> None:
    keyring.set_password(KEYCHAIN_SERVICE, TOKEN_USER, token)
    keyring.set_password(KEYCHAIN_SERVICE, PASSPHRASE_USER, passphrase)
    db.set_text_setting(conn, "phone_repo", repo)
    db.set_text_setting(conn, "phone_salt", os.urandom(16).hex())  # new passphrase, new salt
    db.set_text_setting(conn, "phone_stamp", None)
    db.set_text_setting(conn, "phone_content", None)


def clear_settings(conn: sqlite3.Connection) -> None:
    for user in (TOKEN_USER, PASSPHRASE_USER):
        try:
            keyring.delete_password(KEYCHAIN_SERVICE, user)
        except keyring.errors.KeyringError:
            pass
    for key in ("phone_repo", "phone_salt", "phone_stamp", "phone_content"):
        db.set_text_setting(conn, key, None)


def repo_from_git(folder: Path | None = None) -> str | None:
    """'owner/name' of the GitHub repository this copy of the app was cloned from."""
    folder = folder or Path(__file__).resolve().parents[2]
    try:
        url = subprocess.run(["git", "-C", str(folder), "remote", "get-url", "origin"],
                             capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?$", url)
    return f"{m.group(1)}/{m.group(2)}" if m else None


def phone_url(repo: str) -> str:
    owner, name = repo.split("/")
    return f"https://{owner}.github.io/" + ("" if name.lower() == f"{owner.lower()}.github.io" else f"{name}/")


# ---------------------------------------------------------------- GitHub

class GitHubError(RuntimeError):
    pass


def _call(session: requests.Session, method: str, path: str, **kwargs) -> requests.Response:
    res = session.request(method, API + path, timeout=TIMEOUT_S, **kwargs)
    if res.status_code == 401:
        raise GitHubError("GitHub rejected the token. Set it up again with: garmin phone-updates on")
    if res.status_code == 403 or res.status_code == 404 and "/git/refs/" not in path:
        raise GitHubError(f"The token can't write to this repository ({res.status_code}). It needs "
                          "Contents: read and write on it.")
    return res


def _session(token: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                      "X-GitHub-Api-Version": "2022-11-28"})
    return s


def check_access(repo: str, token: str) -> None:
    res = _call(_session(token), "GET", f"/repos/{repo}")
    if not res.ok:
        raise GitHubError(f"Couldn't reach {repo} on GitHub ({res.status_code}).")
    if not (res.json().get("permissions") or {}).get("push"):
        raise GitHubError("The token can read the repository but not change it. Give it Contents: read and write.")


def upload(repo: str, token: str, files: dict[str, bytes], session: requests.Session | None = None) -> str:
    """Replace the phone-data branch with a single commit holding ``files``. Returns the commit."""
    s = session or _session(token)
    tree = []
    for name, content in files.items():
        res = _call(s, "POST", f"/repos/{repo}/git/blobs",
                    json={"content": base64.b64encode(content).decode(), "encoding": "base64"})
        res.raise_for_status()
        tree.append({"path": name, "mode": "100644", "type": "blob", "sha": res.json()["sha"]})
    res = _call(s, "POST", f"/repos/{repo}/git/trees", json={"tree": tree})
    res.raise_for_status()
    res = _call(s, "POST", f"/repos/{repo}/git/commits",
                json={"message": "Phone app data (encrypted)", "tree": res.json()["sha"], "parents": []})
    res.raise_for_status()
    commit = res.json()["sha"]
    # a commit with no parent, forced onto the branch: nothing older stays reachable
    res = _call(s, "PATCH", f"/repos/{repo}/git/refs/heads/{BRANCH}", json={"sha": commit, "force": True})
    if res.status_code in (404, 422):  # first upload: the branch doesn't exist yet
        res = _call(s, "POST", f"/repos/{repo}/git/refs", json={"ref": f"refs/heads/{BRANCH}", "sha": commit})
    res.raise_for_status()
    return commit


# ---------------------------------------------------------------- after each export

def publish(conn: sqlite3.Connection, path: Path, force: bool = False) -> bool:
    """Encrypt and upload the data file, if automatic updates are on and it changed."""
    cfg = settings(conn)
    if not cfg:
        return False
    data = Path(path).read_bytes()
    # The file changes at every export (it says when it was written); its content, which the
    # export records without that time, only when there's something new to show.
    content = db.get_text_setting(conn, "export_content")
    if not force and content and db.get_text_setting(conn, "phone_content") == content:
        return False
    new = stamp(data)  # the phone checks what it downloads against this
    if not force and db.get_text_setting(conn, "phone_stamp") == new:
        return False
    blob = encrypt(data, cfg["passphrase"], cfg["salt"])
    upload(cfg["repo"], cfg["token"], {DATA_FILE: blob, STAMP_FILE: new.encode()})
    db.set_text_setting(conn, "phone_stamp", new)
    db.set_text_setting(conn, "phone_content", content)
    log.info("Phone app data uploaded (encrypted, %.1f MB)", len(blob) / 1e6)
    return True


def publish_quietly(conn: sqlite3.Connection, path: Path) -> bool:
    try:
        return publish(conn, path)
    except Exception as err:  # no connection, token expired…: the phone just updates next time
        log.warning("Couldn't upload the phone app's data: %s", err)
        return False
