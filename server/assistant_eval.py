"""The 10 assistant test questions (CLAUDE.md: "assistant X/10 correct"), asked from Төв номын сан
against live Hamuga data. A question passes when every expected piece is in the answer.

  cd server && set -a && . ../.env && set +a && .venv/bin/python assistant_eval.py
"""
import assistant

AT = (47.914633, 106.915628)  # Төв номын сан /Зүүн/
QUESTIONS = [
    ("Энэ зогсоол дээр ямар автобус зогсдог вэ?", ["Төв номын сан", "55"]),
    ("55 хаагуур явдаг вэ?", ["55-р автобус", "Дэнжийн 1000", "хооронд"]),
    ("Тавин тав хаашаа явдаг вэ?", ["55-р автобус", "хооронд"]),
    ("Сансар руу хэдэн зогсоол вэ?", ["Сансар", "зогсоол явна"]),
    ("Дэнжийн 1000 руу яаж очих вэ?", ["55-р автобусанд", "14 зогсоол явна"]),
    ("Гандан руу ямар автобус явдаг вэ?", ["Гандан", "дамжин суугаарай"]),
    ("Хамгийн ойрын зогсоол хаана байна?", ["Хамгийн ойрын зогсоол:", "Төв номын сан"]),
    ("Автобус хэзээ ирэх вэ?", ["мэдэхгүй"]),
    ("29Б хаагуур явдаг вэ", ["29 Б автобус", "хооронд"]),
    ("Өнөөдөр цаг агаар ямар байна?", ["Мэдэхгүй байна"]),  # not a bus question: must not guess
]

if __name__ == "__main__":
    ok = 0
    for q, expected in QUESTIONS:
        a = " ".join(assistant.answer(q, *AT))
        passed = all(e.lower() in a.lower() for e in expected)
        ok += passed
        print(("PASS " if passed else "FAIL ") + q + "\n     -> " + a)
    print(f"\nassistant {ok}/{len(QUESTIONS)} correct")
