import hashlib
import json

import pytest
from fastapi.testclient import TestClient

import bus_api
import lite
import tts
from test_planner import DIRECTIONS, GROUP_INFO, STATIONS

client = TestClient(lite.app)


@pytest.fixture(autouse=True)
def fake_hamuga(monkeypatch, tmp_path):
    def fake_get(path, params=None):
        if path == "/api/bus/v1/group/info":
            return GROUP_INFO
        if path == "/api/bus/v1/rot_stop_by_route":
            return {"busRouteInfo": {}, **DIRECTIONS[params["route_id"]]}
        return STATIONS

    monkeypatch.setattr(bus_api, "_get", fake_get)
    monkeypatch.setattr(bus_api, "ROUTE_CACHE", tmp_path / "routes")
    bus_api._stops.cache_clear(); bus_api._stations.cache_clear(); bus_api.route_directions.cache_clear()
    yield
    bus_api._stops.cache_clear(); bus_api._stations.cache_clear(); bus_api.route_directions.cache_clear()


def test_health_says_what_runs_in_the_browser():
    assert client.get("/api/health").json() == {"ok": True, "stt": False, "ocr": False}


def test_plan_and_ride_work_without_gpu_models():
    body = client.post("/api/plan", json={"text": "Сансар", "lat": 47.9003, "lon": 106.9}).json()
    assert body["route"] == "Ч:75"
    stops = client.get("/api/ride", params={"route": "Ч:75", "board": "1", "alight": "3"}).json()["stops"]
    assert [s["stop_id"] for s in stops] == ["1", "2", "3"]


def test_tts_redirects_to_premade_clip_or_404(monkeypatch):
    key = hashlib.sha1(tts.speakable("Сонсож байна.").encode()).hexdigest()[:20]
    monkeypatch.setattr(lite, "CLIPS", {key})
    r = client.get("/api/tts", params={"text": "Сонсож байна."}, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == f"/tts/{key}.mp3"
    assert client.get("/api/tts", params={"text": "Шинэ өгүүлбэр"}).status_code == 404


def test_no_sign_reading_means_unsure_and_no_voice_endpoints():
    r = client.post("/api/verify", json={"sign_crop": "aGk=", "stop_id": "1", "wanted_route": "Ч:75"})
    assert r.json()["verdict"] == "unsure"
    assert client.post("/api/plan/voice", params={"lat": 47.9, "lon": 106.9}, content=b"x").status_code == 503
