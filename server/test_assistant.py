import assistant
from test_planner import HOME, client, fake_hamuga  # noqa: F401 - same fake Hamuga (Home -Ч:75-> Mid -> Сансар)


def ask(text, **context):
    return client.get("/ask", params={"text": text, "lat": HOME[0], "lon": HOME[1], **context}).json()


def test_buses_at_this_stop():
    assert ask("Энэ зогсоол дээр ямар автобус зогсдог вэ?")["speech"] == ["Home зогсоол дээр 2 автобус зогсдог:", "гуч, далан тав."]


def test_buses_at_a_named_stop():
    assert ask("Сансар дээр ямар автобус зогсдог вэ?")["speech"] == ["Сансар ШТС зогсоол дээр 2 автобус зогсдог:", "гуч, далан тав."]


def test_where_a_bus_goes_from_here():
    a = ask("75 хаагуур явдаг вэ?")["speech"]
    assert a == ["Ч далан тав автобус Home - Сансар ШТС хооронд явдаг.", "Home зогсоолоос Сансар ШТС хүртэл 2 зогсоол."]


def test_number_said_as_words():
    assert "Ч далан тав автобус" in ask("Далан тав хаашаа явдаг вэ")["answer"]


def test_unknown_bus_number():
    assert ask("99 хаагуур явдаг вэ")["answer"] == "ерэн ес дугаартай автобус олдсонгүй."


def test_how_to_get_somewhere_sets_the_trip():
    body = ask("Сансар руу хэдэн зогсоол вэ?")
    assert body["action"] == "plan" and body["plan"]["route"] == "Ч:75"
    assert body["speech"][0] == "Ч далан тав автобусанд суугаарай." and "2 зогсоол явна." in body["speech"]


def test_which_buses_go_somewhere_lists_them_and_picks_one():
    body = ask("Сансар руу ямар автобус явдаг вэ?")
    assert body["speech"][:2] == ["Сансар ШТС руу шууд явдаг автобус:", "далан тав 2 зогсоол."] and body["action"] == "plan"


def test_does_a_bus_go_somewhere():
    assert ask("75 Сансар руу явдаг уу?")["speech"][0] == "Тийм. далан тав автобус Сансар ШТС руу явдаг."
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
    mine = ask("Миний автобус аль нь вэ?", **trip)
    assert mine["action"] == "repeat_route" and mine["speech"] == ["Та Ч далан тав автобус хүлээж байна.", "Буух зогсоол: Сансар ШТС."]
    assert ask("Шинээр эхлэх")["action"] == "start_over" and ask("Заавар сонсох")["action"] == "tutorial"


def test_arrival_time_help_thanks_and_emergency():
    assert ask("Автобус хэзээ ирэх вэ?")["speech"] == assistant.NO_ETA
    assert ask("Юу хийж чадах вэ?")["speech"] == assistant.HELP
    assert ask("Баярлалаа")["speech"] == assistant.THANKS
    em = ask("Би төөрсөн, тусламж хэрэгтэй")
    assert em["action"] == "sos" and em["speech"][0] == assistant.SOS_FIRST and "Home зогсоолоос" in em["speech"][1]
    assert ask("Ээждээ залгаач")["action"] == "call_family"
    assert ask("Гэр бүлдээ залга")["action"] == "call_family"


def test_other_questions_are_not_guessed():
    assert ask("Өнөөдөр цаг агаар ямар байна?")["speech"] == assistant.UNKNOWN
    assert ask("Парис руу яаж очих вэ?")["speech"] == ["Ийм нэртэй зогсоол олдсонгүй. Өөр нэрээр хэлнэ үү."]


def test_voice_question(monkeypatch):
    import stt

    monkeypatch.setattr(stt, "load_audio", lambda body: "audio")
    monkeypatch.setattr(stt, "transcribe", lambda audio: "Энд ямар автобус зогсдог вэ")
    r = client.post("/ask", params={"lat": HOME[0], "lon": HOME[1]}, content=b"RIFF....", headers={"Content-Type": "audio/wav"})
    assert r.json()["heard"] == "Энд ямар автобус зогсдог вэ" and "далан тав" in r.json()["answer"]


def test_bus_from_a_stop_beyond_the_8_closest_agrees_with_the_plan(monkeypatch):
    # The one bus to Зайсан leaves from the 10th-closest stop (500 m, within the walk): the trip plan boards
    # it, so "does 23 go there?" is yes, and "which buses go there?" lists it.
    from test_planner import add_stops

    fillers = [(str(30 + i), "Filler", 47.9013, 106.8996 + 0.0001 * i, ["Х:9"]) for i in range(8)]
    add_stops(monkeypatch, fillers + [("18", "Tenth", 47.9048, 106.9000, ["Ч:23"])], {"Ч:23": ["18", "13", "15"]})
    assert ask("23 Зайсан руу явдаг уу?")["speech"] == ["Тийм. хорин гурав автобус Зайсан руу явдаг.", "Tenth зогсоолоос 2 зогсоол."]
    which = ask("Зайсан руу ямар автобус явдаг вэ?")
    assert which["speech"][:2] == ["Зайсан руу шууд явдаг автобус:", "хорин гурав 2 зогсоол."] and which["plan"]["route"] == "Ч:23"
