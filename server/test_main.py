import httpx
import pytest
from fastapi.testclient import TestClient

import bus_api
from main import app

client = TestClient(app)

GROUP_INFO = [
    {"busStopId": "000000529", "busStopName": "Хангарьд цогцолбор /Урд/", "routeList": [
        {"busRouteId": "1", "busRouteNo": "Ч:81"},
        {"busRouteId": "2", "busRouteNo": "Ч:81"},
        {"busRouteId": "3", "busRouteNo": ""},
        {"busRouteId": "4", "busRouteNo": "М:4"},
    ]},
    {"busStopId": "000000378", "busStopName": "Far stop", "routeList": [{"busRouteId": "5", "busRouteNo": "А:1"}]},
    {"busStopId": "000000001", "busStopName": "No routes", "routeList": None},
    {"busStopId": "000000002", "busStopName": "No coords", "routeList": [{"busRouteId": "6", "busRouteNo": "А:2"}]},
]
STATIONS = [
    {"busStopId": "000000529", "gpxY": "47.871832", "gpxX": "106.833664"},
    {"busStopId": "000000378", "gpxY": "47.91666", "gpxX": "106.96464"},
    {"busStopId": "000000001", "gpxY": "47.9", "gpxX": "106.9"},
]


@pytest.fixture(autouse=True)
def fake_hamuga(monkeypatch):
    def fake_get(path, params=None):
        return GROUP_INFO if path == "/api/bus/v1/group/info" else STATIONS

    monkeypatch.setattr(bus_api, "_get", fake_get)
    bus_api._stops.cache_clear()
    yield
    bus_api._stops.cache_clear()


def test_nearest_stop_dedupes_routes():
    r = client.get("/stops/nearest", params={"lat": 47.8718, "lon": 106.8337})
    assert r.status_code == 200
    body = r.json()
    assert body["stop_id"] == "000000529"
    assert body["routes"] == sorted(["Ч:81", "М:4"])
    assert body["distance_m"] < 20


def test_stops_without_routes_or_coords_are_excluded():
    assert {s["stop_id"] for s in bus_api._stops()} == {"000000529", "000000378"}


def test_nearest_rejects_bad_lat():
    assert client.get("/stops/nearest", params={"lat": 91, "lon": 106.8}).status_code == 422


def test_nearest_hamuga_failure_is_503(monkeypatch):
    def boom(path, params=None):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(bus_api, "_get", boom)
    r = client.get("/stops/nearest", params={"lat": 47.87, "lon": 106.83})
    assert r.status_code == 503
    assert r.json()["detail"] == "Bus data unavailable"


def test_verify_stub_is_unsure_with_null_eta():
    r = client.post("/verify", json={"sign_crop": "aGk=", "stop_id": "000000529", "wanted_route": "Ч:81"})
    assert r.status_code == 200
    assert r.json() == {"verdict": "unsure", "confidence": 0.0, "eta_seconds": None}


def test_verify_rejects_missing_fields():
    r = client.post("/verify", json={"stop_id": "000000529"})
    assert r.status_code == 422
