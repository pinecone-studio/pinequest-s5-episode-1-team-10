"""Assistant test questions (CLAUDE.md: "assistant X/10 correct"), asked from Төв номын сан against live
Hamuga data. Passes when every expected piece is in the answer and the app action is the expected one.

  cd server && set -a && . ../.env && set +a && .venv/bin/python assistant_eval.py
"""
import assistant

AT = (47.914633, 106.915628)  # Төв номын сан /Зүүн/
TRIP = {"route": "Ч:55", "alight": "Дэнжийн 1000-ын эцэс /Баруун/"}
# (question, expected pieces, expected action, trip in progress)
QUESTIONS = [
    ("Энэ зогсоол дээр ямар автобус зогсдог вэ?", ["Энэ зогсоол", "55"], None, None),
    ("Энд ямар автобус ирдэг вэ?", ["зогсдог", "55"], None, None),
    ("55 хаагуур явдаг вэ?", ["55-р автобус", "Дэнжийн 1000", "хооронд"], None, None),
    ("Тавин тав хаашаа явдаг вэ?", ["55-р автобус", "хооронд"], None, None),
    ("29Б хаагуур явдаг вэ", ["29 Б автобус", "хооронд"], None, None),
    ("Сансар руу хэдэн зогсоол вэ?", ["Сансар", "зогсоол явна"], "plan", None),
    ("Дэнжийн 1000 руу яаж очих вэ?", ["55-р автобусанд", "14 зогсоол явна"], "plan", None),
    ("Гандан руу ямар автобус явдаг вэ?", ["Гандан"], "plan", None),
    ("Зайсан руу ямар автобус явдаг вэ?", ["шууд явдаг автобус", "55"], "plan", None),
    ("55 Зайсан руу явдаг уу?", ["Тийм", "55"], None, None),
    ("52 Зайсан руу явдаг уу?", ["Тийм", "52"], None, None),  # Hamuga: 52 does (6 stops from Баянгол зочид буудал)
    ("34 Зайсан руу явдаг уу?", ["Үгүй"], None, None),
    ("Сансар хэр хол вэ?", ["Сансар", "шулуунаар", "километр"], None, None),
    ("Сансар дээр ямар автобус зогсдог вэ?", ["Сансар", "зогсдог:"], None, None),
    ("Сүхбаатарын талбайгаас Зайсан руу яаж очих вэ?", ["Зайсан", "зогсоол явна"], None, None),
    ("Хамгийн ойрын зогсоол хаана байна?", ["Хамгийн ойрын зогсоол:", "Төв номын сан"], None, None),
    ("Би хаана байна?", ["Төв номын сан"], None, None),
    ("Автобус хэзээ ирэх вэ?", ["мэдэхгүй"], None, None),
    ("Миний автобус аль нь вэ?", ["55-р автобус", "Дэнжийн 1000"], "repeat_route", TRIP),
    ("Камер нээ", [], "open_camera", TRIP),
    ("Хаалга хаана байна?", [], "door", TRIP),
    ("Хэдэн зогсоол үлдсэн бэ?", [], "stops_left", TRIP),
    ("Би автобусанд суулаа", [], "boarded", TRIP),
    ("Би төөрчихлөө, тусламж хэрэгтэй", ["тусламжийн мессеж", "Төв номын сан"], "sos", None),
    ("Ээждээ залгаач", ["залгаж"], "call_family", None),
    ("Юу хийж чадах вэ?", ["Очих газраа хэлбэл"], None, None),
    ("Өнөөдөр цаг агаар ямар байна?", ["Мэдэхгүй байна"], None, None),  # not a bus question: must not guess
]


# Does it tell question kinds apart however they're worded? (question, expected kind, with a trip?)
def kind(r):
    a, s = r["action"], " ".join(r["speech"])
    if a: return "emergency" if a == "sos" else a
    if s.startswith(("Энэ зогсоол дээр", "Төв номын сан зогсоол дээр")): return "buses_here"
    if "хооронд явдаг" in s: return "route_info"
    if s.startswith(("Тийм.", "Үгүй.")): return "goes_to"
    if s.startswith("Хамгийн ойрын") or s.startswith("Суух зогсоол:"): return "nearest"
    if s.startswith("Автобус хэзээ"): return "eta"
    if s.startswith("Би автобусны талаар"): return "help"
    if s.startswith("Мэдэхгүй"): return "unknown"
    if "шулуунаар" in s: return "how_far"
    if "олдсонгүй" in s: return "not_found"
    return "other:" + s[:40]

WORDINGS = [  # same questions, other wordings (tuned on)
 ("Энд ямар ямар автобус байдаг вэ", "buses_here", 0), ("Энэ буудлаар ямар автобус өнгөрдөг вэ", "buses_here", 0),
 ("Энэ зогсоолоор хэдэн автобус явдаг", "buses_here", 0), ("Энд ирдэг автобуснууд аль нь вэ", "buses_here", 0),
 ("55 дугаар автобус хаана хүртэл явдаг вэ", "route_info", 0), ("55-ын эцэс хаана вэ", "route_info", 0),
 ("55 ямар чиглэлтэй вэ", "route_info", 0), ("Тавин тавдугаар автобусны маршрут юу вэ", "route_info", 0),
 ("Би Сансар явмаар байна", "plan", 0), ("Сансар луу яаж явах вэ", "plan", 0), ("Намайг Сансарт хүргээч", "plan", 0),
 ("Сансарт очихын тулд аль автобусанд суух вэ", "plan", 0), ("Сансар хүрэх автобус", "plan", 0),
 ("55 Зайсанд очдог уу", "goes_to", 0), ("55 Зайсан хүрдэг үү", "goes_to", 0), ("Зайсан руу 55 явах уу", "goes_to", 0),
 ("Ойрхон буудал хаана байна", "nearest", 0), ("Хамгийн дөхөм зогсоол", "nearest", 0), ("Автобусны буудал хаана байна", "nearest", 0),
 ("55 хэзээ ирэх вэ", "eta", 0), ("Дараагийн автобус хэдэн минутын дараа ирэх вэ", "eta", 0), ("Удахгүй ирэх үү", "eta", 0),
 ("Камераа асаа", "open_camera", 1), ("Хаалгыг олоход туслаач", "door", 1), ("Хэдэн буудал үлдэв", "stops_left", 1),
 ("Би буусан", "got_off", 1), ("Дахиад эхлүүлье", "start_over", 1), ("Би суучихлаа", "boarded", 1),
 ("Миний суух автобус ямар билээ", "repeat_route", 1), ("Сансар хэр хол байдаг вэ", "how_far", 0),
 ("Би замаа алдчихлаа", "emergency", 0), ("Надад тусламж хэрэгтэй байна", "emergency", 0), ("Туслаарай", "emergency", 0),
 ("Чи хэн бэ", "unknown", 0), ("Хэдэн цаг болж байна", "unknown", 0), ("Хоол хаана идэх вэ", "unknown", 0),
 ("Маргааш бороо орох уу", "unknown", 0), ("Энэ апп юу хийдэг вэ", "help", 0), ("Сайн уу", "unknown", 0), ("Такси дуудаад өгөөч", "unknown", 0),
]

WORDINGS += [  # written later as a held-out check, then tuned on
 ("Энэ буудал дээр ямар автобусууд зогсдог вэ", "buses_here", 0), ("Эндээс ямар автобус явдаг вэ", "buses_here", 0),
 ("Энд хэдэн автобус зогсдог вэ", "buses_here", 0),
 ("Наян нэгдүгээр автобус хаагуур явдаг", "route_info", 0), ("3 хаашаа явдаг вэ", "route_info", 0), ("7 дугаарын чиглэл юу вэ", "route_info", 0),
 ("Зайсан явах гэсэн юм", "plan", 0), ("Нарантуул руу очмоор байна", "plan", 0), ("Офицеруудын ордон хүрэх автобус байна уу", "plan", 0),
 ("Улсын их дэлгүүр рүү яаж очдог вэ", "plan", 0), ("Баянзүрх товчоо хүртэл хэдэн буудал вэ", "plan", 0),
 ("52 Нарантуул руу явдаг уу", "goes_to", 0), ("Энэ 55 Дэнжийн 1000 хүрэх үү", "goes_to", 0),
 ("Хамгийн ойрхон зогсоол аль нь вэ", "nearest", 0), ("Би одоо хаана байгаа вэ", "nearest", 0),
 ("Автобус удах уу", "eta", 0), ("55 хэдэн минутын дараа ирэх вэ", "eta", 0),
 ("Камер асаагаад өгөөч", "open_camera", 1), ("Хаалга аль талд байна", "door", 1), ("Хэдэн зогсоолын дараа буух вэ", "stops_left", 1),
 ("Би автобусанд орлоо", "boarded", 1), ("Одоо бууж байна", "got_off", 1), ("Би өөр газар явъя", "start_over", 1),
 ("Зогсоол руу дагуулаад өгөөч", "nearest", 1),  # no compass: say which stop and how far
 ("Аюултай байна туслаарай", "emergency", 0),
 ("Чамайг хэн бүтээсэн бэ", "unknown", 0), ("Өнөөдөр хэдэн сарын хэдэн бэ", "unknown", 0), ("Дуу тоглуулаач", "unknown", 0), ("Сайн байна уу", "unknown", 0),
]


if __name__ == "__main__":
    ok = 0
    for q, expected, action, trip in QUESTIONS:
        r = assistant.reply(q, *AT, trip)
        a = " ".join(r["speech"])
        passed = all(e.lower() in a.lower() for e in expected) and r["action"] == action
        ok += passed
        print(("PASS " if passed else "FAIL ") + q + f"\n     -> [{r['action']}] " + a[:160])
    print(f"\nassistant {ok}/{len(QUESTIONS)} correct")
    ok = 0
    for q, want, trip in WORDINGS:
        got = kind(assistant.reply(q, *AT, TRIP if trip else None))
        ok += got == want
        if got != want:
            print(f"WORDING MISS {q!r}: wanted {want}, got {got}")
    print(f"wordings {ok}/{len(WORDINGS)} understood")
