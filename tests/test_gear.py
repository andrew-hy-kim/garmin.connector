from __future__ import annotations

from datetime import date, timedelta

from garmin_connector import db, gear


class Client:
    def get_device_last_used(self):
        return {"userProfileNumber": 1234}

    def get_gear(self, number):
        assert number == 1234
        return [
            {"uuid": "a", "displayName": "Pegasus 40", "gearTypeName": "Shoes", "gearStatusName": "active",
             "dateBegin": "2026-03-01T00:00:00.0", "maximumMeters": 700000},
            {"uuid": "b", "customMakeModel": "Old Ghost", "gearTypeName": "Shoes", "gearStatusName": "retired"},
            {"uuid": "c", "gearMakeName": "Nike", "gearModelName": "Vaporfly", "gearTypeName": "Shoes", "gearStatusName": "active"},
        ]

    def get_gear_stats(self, uuid):
        return {"a": {"totalDistance": 650000, "totalActivities": 80}, "b": {"totalDistance": 900000, "totalActivities": 120}}.get(uuid)

    def get_gear_activities(self, uuid, limit=1000):
        return {"a": [{"activityId": 1}, {"activityId": 2}], "c": [{"activityId": 3}]}.get(uuid, [])


def test_gear_from_garmin(tmp_path):
    c = db.connect(tmp_path / "g.db")
    today = date.today()
    db.upsert_activities(c, [{"activityId": i, "activityName": f"Run {i}", "activityType": {"typeKey": "running"},
                              "startTimeLocal": f"{(today - timedelta(days=d)).isoformat()} 07:00:00", "distance": 10000.0}
                             for i, d in ((1, 3), (2, 40), (3, 1))])
    assert gear.fetch(Client(), c) == 3
    g = {x["uuid"]: x for x in gear.summary(c, today)}
    assert g["a"]["name"] == "Pegasus 40" and g["a"]["limit_m"] == 700000 and g["a"]["share"] > 0.9
    assert g["a"]["month_m"] == 10000 and g["a"]["last_used"] == (today - timedelta(days=3)).isoformat()
    assert g["b"]["retired"] and g["b"]["name"] == "Old Ghost"
    assert g["c"]["name"] == "Nike Vaporfly" and g["c"]["limit_m"] == gear.DEFAULT_LIMIT_M
    assert g["c"]["total_m"] == 10000  # no stats from Garmin: summed from its runs
    order = [x["uuid"] for x in gear.summary(c, today)]
    assert order == ["c", "a", "b"]  # most recently used first, retired last
    assert [x["name"] for x in gear.for_activity(c, 3)] == ["Nike Vaporfly"]


def test_no_gear_access(tmp_path):
    c = db.connect(tmp_path / "g.db")

    class Bare:
        pass
    assert gear.fetch(Bare(), c) == 0 and gear.summary(c) == []
