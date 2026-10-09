import pytest
from fastapi.testclient import TestClient

import bus_api
import planner
import tts
from main import app

client = TestClient(app)

# Rider stands at "Home". Route Ч:75 runs Home -> Mid -> Сансар ШТС /Урд/; Ч:30 runs the other way.
GROUP_INFO = [
    {"busStopId": "1", "busStopName": "Home /Хойд/", "routeList": [
        {"busRouteId": "75", "busRouteNo": "Ч:75"}, {"busRouteId": "30", "busRouteNo": "Ч:30"}]},
    {"busStopId": "2", "busStopName": "Mid", "routeList": [{"busRouteId": "75", "busRouteNo": "Ч:75"}]},
    {"busStopId": "3", "busStopName": "Сансар ШТС /Урд/", "routeList": [
        {"busRouteId": "75", "busRouteNo": "Ч:75"}, {"busRouteId": "30", "busRouteNo": "Ч:30"}]},
    {"busStopId": "4", "busStopName": "Улсын Их Дэлгүүр /Урд/", "routeList": [{"busRouteId": "9", "busRouteNo": "Х:9"}]},
    {"busStopId": "5", "busStopName": "test stop", "routeList": [{"busRouteId": "75", "busRouteNo": "Ч:75"}]},
]
STATIONS = [
    {"busStopId": "1", "gpxY": "47.9000", "gpxX": "106.9000"},
    {"busStopId": "2", "gpxY": "47.9100", "gpxX": "106.9100"},
    {"busStopId": "3", "gpxY": "47.9200", "gpxX": "106.9400"},
    {"busStopId": "4", "gpxY": "47.9150", "gpxX": "106.9150"},
    {"busStopId": "5", "gpxY": "47.9000", "gpxX": "106.9001"},
]
DIRECTIONS = {
    "75": {"rotStopList": [{"busStopId": "1", "busStopSeq": "0"}, {"busStopId": "2", "busStopSeq": "1"},
                           {"busStopId": "3", "busStopSeq": "2"}],
           "reverseRotStopList": [{"busStopId": "3", "busStopSeq": "0"}, {"busStopId": "1", "busStopSeq": "1"}]},
    "30": {"rotStopList": [{"busStopId": "3", "busStopSeq": "0"}, {"busStopId": "1", "busStopSeq": "1"}],
           "reverseRotStopList": []},
}
HOME = (47.9003, 106.9000)  # ~33 m from stop 1


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
    monkeypatch.setattr(tts, "prefetch_in_background", lambda texts, live=False: None)
    bus_api._stops.cache_clear(); bus_api._stations.cache_clear()
    bus_api.route_directions.cache_clear()
    yield
    bus_api._stops.cache_clear(); bus_api._stations.cache_clear()
    bus_api.route_directions.cache_clear()


def plan(text, lat=HOME[0], lon=HOME[1]):
    return client.post("/plan", json={"text": text, "lat": lat, "lon": lon})


def test_plan_suggests_direct_route_in_riding_direction():
    r = plan("Сансар руу явмаар байна")
    assert r.status_code == 200
    body = r.json()
    assert body["route"] == "Ч:75"  # Ч:30 also serves both stops but runs the wrong way
    assert body["board_stop"]["stop_id"] == "1"
    assert body["alight_stop"]["stop_id"] == "3"
    assert body["stops_to_ride"] == 2
    assert body["routes_at_stop"] == ["Ч:30", "Ч:75"]
    assert body["speech"][0] == "75-р автобусанд суугаарай."
    assert body["speech"][2] == "2 зогсоол яваад Сансар ШТС, урд тал зогсоол дээр бууна."
    assert body["found_speech"] == "75-р автобус ирлээ. Энэ таны автобус."


def test_plan_matches_suffixed_words():
    assert plan("Сансарт очно").json()["alight_stop"]["stop_id"] == "3"


def test_plan_no_direct_bus_is_404_with_spoken_reason():
    r = plan("Улсын их дэлгүүр")
    assert r.status_code == 404
    assert "шууд автобус алга" in r.json()["detail"]


def test_plan_unknown_place_is_404():
    assert plan("Парис").status_code == 404


def test_plan_only_filler_words_is_404():
    assert plan("руу явна").json()["detail"] == "Очих газрын нэрийг дахин хэлнэ үү."


def test_plan_far_from_any_stop_is_404():
    assert "800 метрт" in plan("Сансар", lat=48.5, lon=106.9).json()["detail"]


def test_test_stops_are_ignored():
    assert "5" not in {s["stop_id"] for s in bus_api._stops()}


def test_spoken_route_and_stop():
    assert planner.spoken_route("М:3Ма") == "3-р автобус"
    assert planner.spoken_route("М:1А-Ма") == "1 А автобус"
    assert planner.spoken_route("Ч:30_copy") == "30-р автобус"
    assert planner.spoken_stop("Сансар /Тунель/ /Хойд/") == "Сансар, хойд тал"


def test_tts_caches_by_text(monkeypatch, tmp_path):
    calls = []

    class FakeModel:
        def infer(self, gen_text, **kw):
            calls.append(gen_text)
            return [0.0] * 2400, 24000, None

    monkeypatch.setattr(tts, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(tts, "_model", lambda: (FakeModel(), "ref.wav", "ref"))
    first = client.get("/tts", params={"text": "75-р автобус"})
    again = client.get("/tts", params={"text": "75-р автобус"})
    assert first.status_code == again.status_code == 200
    assert first.headers["content-type"] == "audio/wav"
    assert calls == ["далан тавдугаар автобус"]  # digits spelled out, synthesized once


def test_tts_rejects_empty_text():
    assert client.get("/tts", params={"text": "///"}).status_code == 422


def test_short_stem_does_not_match_other_words():
    words = bus_api.base_name("25-р эмийн сан /Хойд/").split()
    assert bus_api._stem_match("сансар", words) == 0
    assert bus_api._stem_match("сансарт", ["сансар", "штс"]) == 6
    assert bus_api._stem_match("төв", ["төв", "шуудан"]) == 3


def wav(seconds=1.0, rate=16000, amp=0.2):
    import io

    import numpy as np
    import soundfile as sf

    buf = io.BytesIO()
    t = np.linspace(0, seconds, int(rate * seconds), dtype=np.float32)
    sf.write(buf, amp * np.sin(2 * np.pi * 220 * t), rate, format="WAV")
    return buf.getvalue()


def voice(monkeypatch, heard, body=None):
    import stt

    monkeypatch.setattr(stt, "transcribe", lambda audio: heard)
    return client.post("/plan/voice", params={"lat": HOME[0], "lon": HOME[1]}, content=body or wav(),
                       headers={"Content-Type": "audio/wav"})


def test_voice_plan_returns_bus_and_what_was_heard(monkeypatch):
    body = voice(monkeypatch, "Сансар руу").json()
    assert body["heard"] == "Сансар руу"
    assert body["plan"]["route"] == "Ч:75"
    assert body["message"] is None


def test_voice_plan_fixes_misheard_stop_name(monkeypatch):
    assert voice(monkeypatch, "Сансаар").json()["plan"]["alight_stop"]["stop_id"] == "3"


def test_voice_plan_silence_asks_again(monkeypatch):
    body = voice(monkeypatch, "").json()
    assert body["plan"] is None and "Сонсогдсонгүй" in body["message"]


def test_voice_plan_unknown_place_is_spoken_reason(monkeypatch):
    body = voice(monkeypatch, "Парис").json()
    assert body["plan"] is None and "олдсонгүй" in body["message"]


def test_voice_plan_rejects_non_audio(monkeypatch):
    assert voice(monkeypatch, "Сансар", body=b"not a wav").status_code == 422


def test_load_audio_resamples_to_16k():
    import stt

    assert len(stt.load_audio(wav(seconds=1.0, rate=48000))) == 16000


def test_garbled_phrase_matches_whole_stop_name_but_garbage_does_not():
    assert [s["stop_id"] for s in planner.find_destination(["улсын", "их", "дэлгуур"])[0]] == ["4"]
    assert planner.find_destination(["тэр", "хүн", "хүн"]) == ([], [])


def test_shared_word_never_picks_a_far_away_place():
    far = {"busStopId": "6", "busStopName": "Чингис хаан олон улсын нисэх буудал", "routeList": [
        {"busRouteId": "75", "busRouteNo": "Ч:75"}]}
    GROUP_INFO.append(far)
    STATIONS.append({"busStopId": "6", "gpxY": "47.65", "gpxX": "106.82"})
    try:
        bus_api._stops.cache_clear(); bus_api._stations.cache_clear()
        named, nearby = planner.find_destination(["улсын", "их", "тэрэлгүүрэлэ"])  # misheard "Улсын их дэлгүүр"
        assert [s["stop_id"] for s in named] == ["4"]
        assert "6" not in [s["stop_id"] for s in nearby]
    finally:
        GROUP_INFO.remove(far)
        STATIONS.pop()


def test_gpu_queue_serves_speech_before_waiting_clips():
    import threading
    import time

    import gpu

    order = []
    gate = threading.Event()

    def job(priority, name, hold=None):
        with gpu.use(priority):
            order.append(name)
            if hold:
                hold.wait()

    first = threading.Thread(target=job, args=(gpu.BACKGROUND, "running clip", gate))
    first.start()
    time.sleep(0.05)
    waiting = [threading.Thread(target=job, args=(gpu.BACKGROUND, "next clip")),
               threading.Thread(target=job, args=(gpu.SPEECH_IN, "speech"))]
    for t in waiting:
        t.start()
        time.sleep(0.05)
    gate.set()
    for t in [first] + waiting:
        t.join(timeout=2)
    assert order == ["running clip", "speech", "next clip"]


def test_gets_off_at_the_named_stop_not_a_closer_neighbour(monkeypatch):
    # "Neighbour" is 250 m before Сансар on route 75: fewer stops, but not where the rider asked to go.
    GROUP_INFO.append({"busStopId": "7", "busStopName": "Neighbour", "routeList": [{"busRouteId": "75", "busRouteNo": "Ч:75"}]})
    STATIONS.append({"busStopId": "7", "gpxY": "47.9200", "gpxX": "106.9367"})
    order = DIRECTIONS["75"]["rotStopList"]
    monkeypatch.setitem(DIRECTIONS["75"], "rotStopList", order[:2] + [{"busStopId": "7", "busStopSeq": "2"},
                                                                      {"busStopId": "3", "busStopSeq": "3"}])
    try:
        bus_api._stops.cache_clear(); bus_api._stations.cache_clear()
        body = plan("Сансар").json()
        assert body["alight_stop"]["stop_id"] == "3" and body["destination"]["stop_id"] == "3"
        assert body["stops_to_ride"] == 3
        assert "ойрхон" not in body["speech"][2]
    finally:
        GROUP_INFO.pop()
        STATIONS.pop()


def test_neighbour_only_when_no_bus_reaches_the_named_stop(monkeypatch):
    # Named stop "Far side" has no route from Home; a stop 250 m away does.
    GROUP_INFO.append({"busStopId": "8", "busStopName": "Хүрээлэн", "routeList": [{"busRouteId": "9", "busRouteNo": "Х:9"}]})
    STATIONS.append({"busStopId": "8", "gpxY": "47.9200", "gpxX": "106.9433"})
    try:
        bus_api._stops.cache_clear(); bus_api._stations.cache_clear()
        body = plan("Хүрээлэн").json()
        assert body["destination"]["stop_id"] == "8"
        assert body["alight_stop"]["stop_id"] == "3"
        assert body["speech"][2].endswith("Хүрээлэн тэндээс ойрхон.")
    finally:
        GROUP_INFO.pop()
        STATIONS.pop()


def test_numbers_pick_the_right_one_of_similar_stops():
    names = bus_api.base_name("Дэнжийн 1000-ын эцэс /Зүүн/").split()
    assert bus_api._stem_match("1000", names) == bus_api.NUMBER_SCORE
    assert bus_api._stem_match("1", names) == 0
    assert planner.query_words("Дэнжийн 1000 руу явна") == ["дэнжийн", "1000"]


def test_unverified_number_suffix_is_still_speakable():
    # oron-tts refuses "1000-ын" (no verified numeral form); the stop name must still be spoken.
    spoken = tts.speakable("Дэнжийн 1000-ын эцэс зогсоол дээр бууна.")
    assert "мянга" in spoken and "1000" not in spoken
    assert tts.speakable("75-р автобус") == "далан тавдугаар автобус"  # verified forms unchanged


def test_split_words_still_find_the_stop(monkeypatch):
    # Whisper heard "Сөх Баатарын тал бай" for "Сүхбаатарын талбай" (2026-10-09).
    GROUP_INFO.append({"busStopId": "9", "busStopName": "Сүхбаатарын талбай", "routeList": [{"busRouteId": "9", "busRouteNo": "Х:9"}]})
    GROUP_INFO.append({"busStopId": "10", "busStopName": "Баатархайрханы 1", "routeList": [{"busRouteId": "9", "busRouteNo": "Х:9"}]})
    STATIONS.extend([{"busStopId": "9", "gpxY": "47.95", "gpxX": "106.95"}, {"busStopId": "10", "gpxY": "47.96", "gpxX": "106.96"}])
    try:
        bus_api._stops.cache_clear(); bus_api._stations.cache_clear()
        named, _ = planner.find_destination(planner.query_words("Сөх Баатарын тал бай!"))
        assert [s["stop_id"] for s in named] == ["9"]
    finally:
        del GROUP_INFO[-2:], STATIONS[-2:]


def test_locate_by_voice(monkeypatch):
    import stt

    monkeypatch.setattr(stt, "transcribe", lambda audio: "Би Сансар ШТС дээр байна")
    body = client.post("/locate/voice", content=wav(), headers={"Content-Type": "audio/wav"}).json()
    assert body["stop"]["stop_id"] == "3" and body["stop"]["lat"] == 47.92
    monkeypatch.setattr(stt, "transcribe", lambda audio: "Тэр хүн хүн")
    assert client.post("/locate/voice", content=wav(), headers={"Content-Type": "audio/wav"}).json()["stop"] is None


def test_one_matching_word_is_not_enough():
    # "Төв шуудан" must not become "Төв номын сан"; garbage must not become "Цэлмэг хүнс дэлгүүр".
    GROUP_INFO.append({"busStopId": "11", "busStopName": "Төв номын сан /Зүүн/", "routeList": [{"busRouteId": "9", "busRouteNo": "Х:9"}]})
    GROUP_INFO.append({"busStopId": "12", "busStopName": "Цэлмэг хүнс дэлгүүр", "routeList": [{"busRouteId": "9", "busRouteNo": "Х:9"}]})
    STATIONS.extend([{"busStopId": "11", "gpxY": "47.95", "gpxX": "106.95"}, {"busStopId": "12", "gpxY": "47.96", "gpxX": "106.96"}])
    try:
        bus_api._stops.cache_clear(); bus_api._stations.cache_clear()
        assert planner.find_destination(planner.query_words("Төв шуудан")) == ([], [])
        assert planner.find_destination(planner.query_words("Тэр хүн хүн")) == ([], [])
        assert planner.find_destination(planner.query_words("Төв номын сан"))[0][0]["stop_id"] == "11"
    finally:
        del GROUP_INFO[-2:], STATIONS[-2:]


def test_conflicting_word_is_a_different_place():
    GROUP_INFO.append({"busStopId": "13", "busStopName": "Гадна тойруу /Урд/", "routeList": [{"busRouteId": "9", "busRouteNo": "Х:9"}]})
    STATIONS.append({"busStopId": "13", "gpxY": "47.95", "gpxX": "106.95"})
    try:
        bus_api._stops.cache_clear(); bus_api._stations.cache_clear()
        assert planner.find_destination(planner.query_words("Их тойруу")) == ([], [])
        assert planner.find_destination(planner.query_words("Гадна тойруу"))[0][0]["stop_id"] == "13"
        assert planner.find_destination(planner.query_words("тойруу"))[0][0]["stop_id"] == "13"
    finally:
        GROUP_INFO.pop(), STATIONS.pop()


def test_locate_by_text():
    body = client.get("/locate", params={"text": "Сансар ШТС дээр байна"}).json()
    assert body["stop"]["stop_id"] == "3"


def test_standing_at_the_stop_is_not_walk_zero_metres():
    body = plan("Сансар", lat=47.9000, lon=106.9000).json()
    assert body["speech"][1] == "Home, хойд тал зогсоол дээр байна."


def test_spoken_numbers_become_digits():
    import numwords

    assert numwords.to_digits(["арван", "есдүгээр", "сургууль"]) == ["19", "сургууль"]
    assert numwords.to_digits(["дэнжийн", "мянган"]) == ["дэнжийн", "1000"]
    assert numwords.to_digits(["дэнжийн", "манган"]) == ["дэнжийн", "1000"]  # Whisper misspelling
    assert numwords.to_digits(["хоёр", "зуун", "тавин", "таван"]) == ["255"]
    assert numwords.to_digits(["гуравдугаар", "хороолол"]) == ["3", "хороолол"]
    assert numwords.to_digits(["сансар", "тавь"]) == ["сансар", "50"]
    assert numwords.to_digits(["сансар"]) == ["сансар"]  # ordinary words untouched
    assert planner.query_words("Дэнжийн мянган руу явмаар байна") == ["дэнжийн", "1000"]


def test_ride_lists_stops_in_riding_order_with_speech():
    r = client.get("/ride", params={"route": "Ч:75", "board": "1", "alight": "3"})
    assert r.status_code == 200
    stops = r.json()["stops"]
    assert [s["stop_id"] for s in stops] == ["1", "2", "3"]
    assert stops[2]["lat"] == 47.92 and stops[2]["speech"] == "Дараагийн зогсоол: Сансар ШТС, урд тал."


def test_ride_wrong_direction_is_404():
    # Ч:30 only runs Сансар -> Home
    assert client.get("/ride", params={"route": "Ч:30", "board": "1", "alight": "3"}).status_code == 404
    assert client.get("/ride", params={"route": "Ч:30", "board": "3", "alight": "1"}).status_code == 200
