import assistant
from test_planner import HOME, client, fake_hamuga  # noqa: F401 - same fake Hamuga (Home -Ч:75-> Mid -> Сансар)


def ask(text):
    return client.get("/ask", params={"text": text, "lat": HOME[0], "lon": HOME[1]}).json()


def test_buses_at_this_stop():
    assert ask("Энэ зогсоол дээр ямар автобус зогсдог вэ?")["answer"] == "Home зогсоол дээр 2 автобус зогсдог: 30, 75."


def test_where_a_bus_goes_from_here():
    a = ask("75 хаагуур явдаг вэ?")["speech"]
    assert a == ["75-р автобус Home - Сансар ШТС хооронд явдаг.", "Home зогсоолоос Сансар ШТС хүртэл 2 зогсоол."]


def test_number_said_as_words():
    assert "75-р автобус" in ask("Далан тав хаашаа явдаг вэ")["answer"]


def test_unknown_bus_number():
    assert ask("99 хаагуур явдаг вэ")["answer"] == "99 дугаартай автобус олдсонгүй."


def test_how_to_get_somewhere_is_the_plan():
    body = ask("Сансар руу хэдэн зогсоол вэ?")
    assert body["speech"][0] == "75-р автобусанд суугаарай." and "2 зогсоол явна." in body["speech"]


def test_nearest_stop():
    assert ask("Хамгийн ойрын зогсоол хаана байна?")["speech"][:3] == ["Хамгийн ойрын зогсоол:", "Home.", "Хойд тал."]


def test_arrival_time_is_not_guessed():
    assert ask("Автобус хэзээ ирэх вэ?")["speech"] == assistant.NO_ETA


def test_other_questions_are_not_guessed():
    assert ask("Өнөөдөр цаг агаар ямар байна?")["speech"] == assistant.UNKNOWN


def test_voice_question(monkeypatch):
    import stt

    monkeypatch.setattr(stt, "load_audio", lambda body: "audio")
    monkeypatch.setattr(stt, "transcribe", lambda audio: "Энд ямар автобус зогсдог вэ")
    r = client.post("/ask", params={"lat": HOME[0], "lon": HOME[1]}, content=b"RIFF....", headers={"Content-Type": "audio/wav"})
    assert r.json()["heard"] == "Энд ямар автобус зогсдог вэ" and "75" in r.json()["answer"]
