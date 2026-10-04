from __future__ import annotations

import base64
import subprocess

import pytest
from cryptography.exceptions import InvalidTag

from garmin_connector import db, publish


def test_encryption_round_trip():
    salt = bytes(range(16))
    blob = publish.encrypt(b"\x1f\x8bhello", "correct horse battery", salt, rounds=1000)
    assert blob[:4] == b"GDE1" and blob[4:20] == salt and int.from_bytes(blob[20:24], "big") == 1000
    assert publish.decrypt(blob, "correct horse battery") == b"\x1f\x8bhello"
    with pytest.raises(InvalidTag):
        publish.decrypt(blob, "wrong passphrase!!")
    # a fresh IV every time, so the same data never encrypts the same way twice
    assert publish.encrypt(b"x", "p" * 12, salt, rounds=1000) != publish.encrypt(b"x", "p" * 12, salt, rounds=1000)


class FakeResponse:
    def __init__(self, status, body=None):
        self.status_code, self._body = status, body or {}
        self.ok = status < 400

    def json(self):
        return self._body

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError(self.status_code)


class FakeSession:
    def __init__(self, branch_exists):
        self.calls, self.branch_exists = [], branch_exists

    def request(self, method, url, timeout=None, json=None):
        path = url.replace(publish.API, "")
        self.calls.append((method, path, json))
        if path.endswith("/git/blobs"):
            return FakeResponse(201, {"sha": f"blob{len(self.calls)}"})
        if path.endswith("/git/trees"):
            return FakeResponse(201, {"sha": "tree1"})
        if path.endswith("/git/commits"):
            return FakeResponse(201, {"sha": "commit1"})
        if method == "PATCH":
            return FakeResponse(200 if self.branch_exists else 422)
        return FakeResponse(201)


def test_upload_replaces_the_branch_with_one_commit():
    s = FakeSession(branch_exists=False)
    assert publish.upload("me/app", "tok", {"data.bin": b"\x00\x01", "stamp.txt": b"abc"}, session=s) == "commit1"
    methods = [(m, p.split("/git/")[1]) for m, p, _ in s.calls]
    assert methods == [("POST", "blobs"), ("POST", "blobs"), ("POST", "trees"), ("POST", "commits"),
                       ("PATCH", "refs/heads/phone-data"), ("POST", "refs")]
    blob = s.calls[0][2]
    assert blob["encoding"] == "base64" and base64.b64decode(blob["content"]) == b"\x00\x01"
    commit = s.calls[3][2]
    assert commit["parents"] == [] and commit["tree"] == "tree1"  # no history kept
    assert s.calls[4][2] == {"sha": "commit1", "force": True}
    # later uploads just move the branch
    s = FakeSession(branch_exists=True)
    publish.upload("me/app", "tok", {"data.bin": b"x"}, session=s)
    assert s.calls[-1][0] == "PATCH"


def test_publish_only_when_set_up_and_changed(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "p.db")
    data = tmp_path / "garmin-dashboard.data"
    data.write_bytes(b"\x1f\x8b first")
    assert publish.publish(conn, data) is False  # not set up: nothing happens
    secrets = {publish.TOKEN_USER: "tok", publish.PASSPHRASE_USER: "a long passphrase"}
    monkeypatch.setattr(publish, "_secret", secrets.get)
    db.set_text_setting(conn, "phone_repo", "me/app")
    db.set_text_setting(conn, "phone_salt", "00" * 16)
    monkeypatch.setattr(publish, "ROUNDS", 1000)
    sent = []
    monkeypatch.setattr(publish, "upload", lambda repo, token, files: sent.append((repo, files)))
    assert publish.publish(conn, data) is True
    repo, files = sent[0]
    assert repo == "me/app" and files["stamp.txt"].decode() == publish.stamp(b"\x1f\x8b first")
    assert publish.decrypt(files["data.bin"], "a long passphrase") == b"\x1f\x8b first"
    assert publish.publish(conn, data) is False and len(sent) == 1  # unchanged: no upload
    data.write_bytes(b"\x1f\x8b second")
    assert publish.publish(conn, data) is True and len(sent) == 2
    # a failed upload never breaks the export
    monkeypatch.setattr(publish, "upload", lambda *a: (_ for _ in ()).throw(publish.GitHubError("offline")))
    data.write_bytes(b"\x1f\x8b third")
    assert publish.publish_quietly(conn, data) is False


def test_repo_and_phone_url(tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "remote", "add", "origin",
                    "https://github.com/andrew-hy-kim/garmin.connector.git"], check=True)
    assert publish.repo_from_git(tmp_path) == "andrew-hy-kim/garmin.connector"
    assert publish.phone_url("andrew-hy-kim/garmin.connector") == "https://andrew-hy-kim.github.io/garmin.connector/"
    assert publish.phone_url("me/me.github.io") == "https://me.github.io/"
