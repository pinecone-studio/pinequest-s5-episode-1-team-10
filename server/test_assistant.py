import assistant
from test_planner import HOME, client, fake_hamuga  # noqa: F401 - same fake Hamuga (Home -Ч:75-> Mid -> Сансар)


def ask(text, **context):
    return client.get("/ask", params={"text": text, "lat": HOME[0], "lon": HOME[1], **context}).json()


def test_buses_at_this_stop():
    assert ask("Энэ зогсоол дээр ямар автобус зогсдог вэ?")["speech"] == ["Home зогсоол дээр 2 автобус зогсдог:", "30, 75."]


def test_buses_at_a_named_stop():
    assert ask("Сансар дээр ямар автобус зогсдог вэ?")["speech"] == ["Сансар ШТС зогсоол дээр 2 автобус зогсдог:", "30, 75."]


def test_where_a_bus_goes_from_here():
    a = ask("75 хаагуур явдаг вэ?")["speech"]
    assert a == ["75-р автобус Home - Сансар ШТС хооронд явдаг.", "Home зогсоолоос Сансар ШТС хүртэл 2 зогсоол."]


def test_number_said_as_words():
    assert "75-р автобус" in ask("Далан тав хаашаа явдаг вэ")["answer"]


def test_unknown_bus_number():
    assert ask("99 хаагуур явдаг вэ")["answer"] == "99 дугаартай автобус олдсонгүй."


def test_how_to_get_somewhere_sets_the_trip():
    body = ask("Сансар руу хэдэн зогсоол вэ?")
    assert body["action"] == "plan" and body["plan"]["route"] == "Ч:75"
    assert body["speech"][0] == "75-р автобусанд суугаарай." and "2 зогсоол явна." in body["speech"]


def test_which_buses_go_somewhere_lists_them_and_picks_one():
    body = ask("Сансар руу ямар автобус явдаг вэ?")
    assert body["speech"][:2] == ["Сансар ШТС руу шууд явдаг автобус:", "75 2 зогсоол."] and body["action"] == "plan"


def test_does_a_bus_go_somewhere():
    assert ask("75 Сансар руу явдаг уу?")["speech"][0] == "Тийм. 75 автобус Сансар ШТС руу явдаг."
    assert ask("30 Сансар руу явдаг уу?")["speech"][0].startswith("Үгүй.")  # 30 runs the other way


def test_how_far():
    assert ask("Сансар хэр хол вэ?")["answer"].startswith("Сансар ШТС эндээс шулуунаар")


def test_nearest_stop_and_where_am_i():
    assert ask("Хамгийн ойрын зогсоол хаана байна?")["speech"][:3] == ["Хамгийн ойрын зогсоол:", "Home.", "Хойд тал."]
    assert ask("Би хаана байна?")["speech"][0] == "Хамгийн ойрын зогсоол:"


def test_commands_need_a_trip_and_then_act():
    assert ask("Камер нээ")["speech"] == assistant.NEED_PLAN and ask("Камер нээ")["action"] is None
    trip = {"route": "Ч:75", "alight": "Сансар ШТС /Урд/"}
    assert ask("Камер нээ", **trip)["action"] == "open_camera"
    assert ask("Хаалга хаана байна?", **trip)["action"] == "door"
    assert ask("Хэдэн зогсоол үлдсэн бэ?", **trip)["action"] == "stops_left"
    assert ask("Би автобусанд суулаа", **trip)["action"] == "boarded"
    assert ask("Би буулаа", **trip)["action"] == "got_off"
    assert ask("Зогсоол руу хөтлөөч", **trip)["action"] == "walk"
    mine = ask("Миний автобус аль нь вэ?", **trip)
    assert mine["action"] == "repeat_route" and mine["speech"] == ["Та 75-р автобус хүлээж байна.", "Буух зогсоол: Сансар ШТС."]
    assert ask("Шинээр эхлэх")["action"] == "start_over" and ask("Заавар сонсох")["action"] == "tutorial"


def test_arrival_time_help_thanks_and_emergency():
    assert ask("Автобус хэзээ ирэх вэ?")["speech"] == assistant.NO_ETA
    assert ask("Юу хийж чадах вэ?")["speech"] == assistant.HELP
    assert ask("Баярлалаа")["speech"] == assistant.THANKS
    em = ask("Би төөрсөн, тусламж хэрэгтэй")["speech"]
    assert em[0] == assistant.EMERGENCY_FIRST and "Home зогсоолоос" in em[1]


def test_other_questions_are_not_guessed():
    assert ask("Өнөөдөр цаг агаар ямар байна?")["speech"] == assistant.UNKNOWN
    assert ask("Парис руу яаж очих вэ?")["speech"] == ["Ийм нэртэй зогсоол олдсонгүй. Өөр нэрээр хэлнэ үү."]


def test_voice_question(monkeypatch):
    import stt

    monkeypatch.setattr(stt, "load_audio", lambda body: "audio")
    monkeypatch.setattr(stt, "transcribe", lambda audio: "Энд ямар автобус зогсдог вэ")
    r = client.post("/ask", params={"lat": HOME[0], "lon": HOME[1]}, content=b"RIFF....", headers={"Content-Type": "audio/wav"})
    assert r.json()["heard"] == "Энд ямар автобус зогсдог вэ" and "75" in r.json()["answer"]
