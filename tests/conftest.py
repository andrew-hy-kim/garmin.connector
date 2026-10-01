import pytest


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    """Keep tests away from the real ~/.garmin-connector."""
    monkeypatch.setenv("GARMIN_CONNECTOR_HOME", str(tmp_path / "home"))
