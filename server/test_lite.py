import hashlib
import json

import httpx
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
    bus_api._stops.cache_clear(); bus_api._stations.cache_clear(); bus_api.route_directions.cache_clear(); bus_api._snapshot.cache_clear()
    yield
    bus_api._stops.cache_clear(); bus_api._stations.cache_clear(); bus_api.route_directions.cache_clear(); bus_api._snapshot.cache_clear()


def test_health_says_what_runs_in_the_browser(monkeypatch):
    monkeypatch.delenv("SPEECHMATICS_API_KEY", raising=False)
    assert client.get("/api/health").json() == {"ok": True, "stt": False, "ocr": False, "speech": False}
    monkeypatch.setenv("SPEECHMATICS_API_KEY", "secret")
    assert client.get("/api/health").json()["speech"] is True


def test_speech_token_hands_out_a_temporary_key_never_the_account_key(monkeypatch):
    import speechmatics
    sent = {}

    def fake_post(url, json, headers, timeout):
        sent.update(url=url, json=json, auth=headers["Authorization"])
        return httpx.Response(201, json={"apikey_id": None, "key_value": "temp-jwt"}, request=httpx.Request("POST", url))

    monkeypatch.setenv("SPEECHMATICS_API_KEY", "account-secret")
    monkeypatch.setattr(speechmatics.httpx, "post", fake_post)
    r = client.post("/api/stt/token")
    assert r.status_code == 200
    assert r.json() == {"jwt": "temp-jwt", "url": speechmatics.URL, "ttl": 60}
    assert "account-secret" not in r.text and r.headers["cache-control"] == "no-store"
    assert sent == {"url": speechmatics.KEY_URL, "json": {"ttl": 60}, "auth": "Bearer account-secret"}

    monkeypatch.setattr(speechmatics.httpx, "post", lambda *a, **k: httpx.Response(401, request=httpx.Request("POST", speechmatics.KEY_URL)))
    assert client.post("/api/stt/token").status_code == 503  # refused: the app falls back, never crashes
    monkeypatch.delenv("SPEECHMATICS_API_KEY")
    assert client.post("/api/stt/token").status_code == 503  # not configured


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


def test_ask_names_the_premade_clip_of_each_sentence(monkeypatch):
    # Same name /api/tts would redirect to; null for a sentence without a clip (the app asks /api/tts).
    params = {"text": "75 хаагуур явдаг вэ?", "lat": 47.9003, "lon": 106.9}
    speech = client.get("/api/ask", params=params).json()["speech"]
    first = hashlib.sha1(tts.speakable(speech[0]).encode()).hexdigest()[:20]
    monkeypatch.setattr(lite, "CLIPS", {first})
    body = client.get("/api/ask", params=params).json()
    assert body["clips"] == [first] + [None] * (len(speech) - 1)
    r = client.get("/api/tts", params={"text": speech[0]}, follow_redirects=False)
    assert r.headers["location"] == f"/tts/{first}.mp3"


def test_no_sign_reading_means_unsure_and_no_voice_endpoints():
    r = client.post("/api/verify", json={"sign_crop": "aGk=", "stop_id": "1", "wanted_route": "Ч:75"})
    assert r.json()["verdict"] == "unsure"
    assert client.post("/api/plan/voice", params={"lat": 47.9, "lon": 106.9}, content=b"x").status_code == 503


def test_stop_lists_come_from_the_deploy_snapshot(monkeypatch, tmp_path):
    bus_api.save_snapshot(tmp_path / "stops_snapshot.json")
    bus_api._stops.cache_clear(); bus_api._stations.cache_clear(); bus_api.route_directions.cache_clear()

    def no_calls(path, params=None):
        if path == "/api/bus/v1/rot_stop_by_route":
            return {"busRouteInfo": {}, **DIRECTIONS[params["route_id"]]}
        raise AssertionError("station / stop lists must come from the snapshot")

    monkeypatch.setattr(bus_api, "_get", no_calls)
    monkeypatch.setattr(bus_api, "SNAPSHOT", tmp_path / "stops_snapshot.json")
    bus_api._snapshot.cache_clear()
    assert client.post("/api/plan", json={"text": "Сансар", "lat": 47.9003, "lon": 106.9}).json()["route"] == "Ч:75"
