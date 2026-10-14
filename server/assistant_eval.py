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
    ("Би төөрчихлөө, тусламж хэрэгтэй", ["тусламж хүсээрэй", "Төв номын сан"], None, None),
    ("Юу хийж чадах вэ?", ["Очих газраа хэлбэл"], None, None),
    ("Өнөөдөр цаг агаар ямар байна?", ["Мэдэхгүй байна"], None, None),  # not a bus question: must not guess
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
