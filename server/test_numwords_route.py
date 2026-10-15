"""Route numbers in words (numwords.route_words): the same as the app's routeSpeech (app/lib/route.ts).
Both are checked against test-fixtures/speech/routes.expected.json, so the voice and the app agree."""
import json
import re
from pathlib import Path

import numwords
import planner

ROOT = Path(__file__).resolve().parent.parent
ROUTES = [r["key"] for r in json.loads((ROOT / "data" / "routes.json").read_text(encoding="utf-8"))]
GOLDEN = json.loads((ROOT / "test-fixtures" / "speech" / "routes.expected.json").read_text(encoding="utf-8"))
# Hamuga busRouteNo forms seen in the stop list: variant tags, lowercase letters, unknown prefixes.
HAMUGA = ["Ч:29Б-Ма", "Ч:29БМа", "Ч:16а-Z", "Ч:24б", "М:1БНА", "М:5-КОП_copy", "Ч:20А_copy", "Ч:71МА", "Х:18z",
          " НҮ:2_copy", "COP:17", "МА:55", "M:7", "Хүй7:1", "Ч-38", "БЭ:2 ", "test:1", "ЯЯ22", "Д:8Z"]


def test_words_attributive_tens():
    assert [numwords.words(n) for n in (29, 57, 16, 81, 10, 40, 20, 22, 1, 99)] == [
        "хорин ес", "тавин долоо", "арван зургаа", "наян нэг", "арав", "дөч", "хорь", "хорин хоёр", "нэг", "ерэн ес"]
    assert numwords.words(0) == "" and numwords.words(100) == ""


def test_same_as_the_golden_file():
    assert len(ROUTES) == 125 and len(GOLDEN) == 125
    assert {r: numwords.route_words(r) for r in ROUTES} == GOLDEN


def test_every_route_spoken_without_digits_and_all_different():
    spoken = [numwords.route_words(r) for r in ROUTES]
    assert all(s and not re.search(r"[0-9:]", s) for s in spoken)
    assert len(set(spoken)) == len(ROUTES)


def test_the_plans_examples():
    assert numwords.route_words("Ч:29Б") == "Ч хорин ес Б"
    assert numwords.route_words("Ч:57") == "Ч тавин долоо"
    assert numwords.route_words("Ч:16А") == "Ч арван зургаа А"
    assert numwords.route_words("Ч:81") == "Ч наян нэг"
    assert numwords.route_words("Ч:10") == "Ч арав"
    assert numwords.route_words("Ч:40") == "Ч дөч"
    assert numwords.route_words("57") == "тавин долоо"
    assert numwords.route_words("Ч:22ӨВ") == "Ч хорин хоёр ӨВ"


def test_hamuga_forms_and_unknown_prefixes():
    assert numwords.route_words("Ч:29Б-Ма") == numwords.route_words("Ч:29БМа") == "Ч хорин ес Б"
    assert numwords.route_words("Ч:16а-Z") == "Ч арван зургаа А"
    assert numwords.route_words("ч:29б") == "Ч хорин ес Б"
    assert numwords.route_words("Ч:71МА") == "Ч далан нэг"  # "МА" is a variant tag, not the letter А
    assert numwords.route_words("COP:1") == "нэг"  # unknown prefix: left out, never spelled
    assert numwords.route_words("Ч:16Ах") == "Ч арван зургаа"  # more than a tag after the letter: not said
    assert numwords.route_words("test1000") == "" and numwords.route_words("Ч:") == ""
    for r in HAMUGA:
        assert not re.search(r"[0-9:]", numwords.route_words(r)), r


def test_route_sentences_have_no_digits():
    for r in ROUTES + HAMUGA + ["test1000"]:
        for text in (planner.take_speech(r), planner.found_speech(r), planner.transfer_speech(r)):
            assert not re.search(r"[0-9:]", text), text
    assert planner.take_speech("Ч:57") == "Ч тавин долоо автобусанд суугаарай."
    assert planner.found_speech("Ч:29Б-Ма") == "Ч хорин ес Б автобус ирлээ. Энэ таны автобус."
    assert planner.take_speech("test1000") == "автобусанд суугаарай."


def test_the_deployed_copy_of_route_speech_matches_the_file():
    # The lite server on Vercel has no shared/ folder (deploy/vercel.sh copies server/*.py only), so it
    # says route letters with numwords._ROUTE_SPEECH_COPY: it must say them the way the file (and the app) does.
    shared = json.loads((ROOT / "shared" / "route_speech.json").read_text(encoding="utf-8"))
    assert numwords._ROUTE_SPEECH_COPY == {"prefix": shared["prefix"], "suffix": shared["suffix"]}
