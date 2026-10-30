import pytest


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    """Keep tests away from the real ~/.garmin-connector."""
    monkeypatch.setenv("GARMIN_CONNECTOR_HOME", str(tmp_path / "home"))


@pytest.fixture(autouse=True)
def no_weather_network(monkeypatch, request):
    """Syncs in tests never call Open-Meteo; test_weather.py drives weather with a fake service."""
    if request.module.__name__.endswith("test_weather"):
        return
    from garmin_connector import weather
    monkeypatch.setattr(weather, "update_quietly", lambda conn, **kw: {"weather": 0, "indoor": 0, "missing": 0})
