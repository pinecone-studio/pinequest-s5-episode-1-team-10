import httpx
import pytest
from fastapi.testclient import TestClient

import bus_api
import geocode
import ocr
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


def verify(monkeypatch, texts, wanted="Ч:81", stop="000000529", sign="aGk="):
    if isinstance(texts, Exception):
        def read(_):
            raise texts
    else:
        def read(_):
            return texts

    monkeypatch.setattr(ocr, "read_texts", read)
    return client.post("/verify", json={"sign_crop": sign, "stop_id": stop, "wanted_route": wanted})


def test_verify_yes(monkeypatch):
    r = verify(monkeypatch, [("81", 0.95)])
    assert r.status_code == 200
    assert r.json() == {"verdict": "yes", "confidence": 0.95, "eta_seconds": None}


def test_verify_other_number_is_no(monkeypatch):
    assert verify(monkeypatch, [("12", 0.9)]).json()["verdict"] == "no"


def test_verify_route_not_at_stop_is_unsure(monkeypatch):
    assert verify(monkeypatch, [("81", 0.95)], wanted="Ч:81", stop="000000378").json()["verdict"] == "unsure"


def test_verify_bus_data_down_is_never_yes(monkeypatch):
    def boom(path, params=None):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(bus_api, "_get", boom)
    r = verify(monkeypatch, [("81", 0.95)])
    assert r.status_code == 200
    assert r.json()["verdict"] == "unsure"


def test_verify_invalid_base64_is_422(monkeypatch):
    assert verify(monkeypatch, [], sign="not base64!!").status_code == 422


def test_verify_ocr_failure_is_unsure(monkeypatch):
    r = verify(monkeypatch, RuntimeError("boom"))
    assert r.status_code == 200
    assert r.json() == {"verdict": "unsure", "confidence": 0.0, "eta_seconds": None}


def test_verify_rejects_missing_fields():
    r = client.post("/verify", json={"stop_id": "000000529"})
    assert r.status_code == 422


UIDD = {"name": "Улсын их дэлгүүр", "lat": 47.917, "lon": 106.906}


def leg(mode, route=None, frm="1:000000283", to="1:000000543"):
    if mode == "WALK":
        return {"mode": "WALK"}
    return {"mode": "BUS", "routeShortName": route, "from": {"stopId": frm, "name": "From " + frm}, "to": {"stopId": to, "name": "To " + to}}


def itinerary(duration, walk, *buses):
    return {"duration": duration, "walkDistance": walk, "legs": [leg("WALK"), *buses, leg("WALK")]}


def suggest(monkeypatch, plan, place=UIDD):
    monkeypatch.setattr(geocode, "geocode", lambda q: place)
    monkeypatch.setattr(bus_api, "_plan", lambda *a: plan)
    return client.get("/routes/suggest", params={"lat": 47.9188, "lon": 106.9176, "to": "Улсын их дэлгүүр"})


def test_suggest_keeps_one_bus_trips_fastest_first(monkeypatch):
    plan = {"plan": {"itineraries": [
        itinerary(1800, 700.0, leg("BUS", "Ч:34")),
        itinerary(1500, 650.4, leg("BUS", "Ч:34")),
        itinerary(1300, 300.0, leg("BUS", "М:1Б"), leg("BUS", "Ч:61")),  # transfer: dropped
        itinerary(1200, 120.0, leg("BUS", "Ч:53", "1:000000203", "1:000000516")),
    ]}}
    r = suggest(monkeypatch, plan)
    assert r.status_code == 200
    body = r.json()
    assert body["destination"] == UIDD
    assert [(t["route"], t["duration_s"]) for t in body["suggestions"]] == [("Ч:53", 1200), ("Ч:34", 1500)]
    assert body["suggestions"][0] == {
        "route": "Ч:53", "board_stop_id": "000000203", "board_stop_name": "From 1:000000203",
        "alight_stop_id": "000000516", "alight_stop_name": "To 1:000000516", "walk_m": 120, "duration_s": 1200,
    }


def test_suggest_caps_at_three(monkeypatch):
    plan = {"plan": {"itineraries": [itinerary(1000 + i, 0.0, leg("BUS", f"Ч:{i}")) for i in range(5)]}}
    assert [t["route"] for t in suggest(monkeypatch, plan).json()["suggestions"]] == ["Ч:0", "Ч:1", "Ч:2"]


def test_suggest_no_path_is_empty_list(monkeypatch):
    r = suggest(monkeypatch, {"error": {"id": 404, "msg": "PATH_NOT_FOUND"}})
    assert r.status_code == 200
    assert r.json()["suggestions"] == []


def test_suggest_unknown_place_is_404(monkeypatch):
    r = suggest(monkeypatch, {}, place=None)
    assert r.status_code == 404
    assert r.json()["detail"] == "Destination not found"


def test_suggest_geocoder_down_is_503(monkeypatch):
    def boom(q):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(geocode, "geocode", boom)
    r = client.get("/routes/suggest", params={"lat": 47.9, "lon": 106.9, "to": "x"})
    assert r.status_code == 503
    assert r.json()["detail"] == "Place search unavailable"


def test_suggest_planner_down_is_503(monkeypatch):
    def boom(*a):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(geocode, "geocode", lambda q: UIDD)
    monkeypatch.setattr(bus_api, "_plan", boom)
    r = client.get("/routes/suggest", params={"lat": 47.9, "lon": 106.9, "to": "x"})
    assert r.status_code == 503
    assert r.json()["detail"] == "Bus data unavailable"


def test_suggest_requires_destination():
    assert client.get("/routes/suggest", params={"lat": 47.9, "lon": 106.9}).status_code == 422
