"""Mongolian number words -> digits, so a spoken stop name matches its written form:
'арван есдүгээр сургууль' -> '19 сургууль', 'дэнжийн мянган' -> 'дэнжийн 1000'.
And back: route numbers in words for the voice, 'Ч:29Б' -> 'Ч хорин ес Б' (route_words)."""
import difflib
import json
import re
from pathlib import Path

_UNITS = {"нэг": 1, "нэгэн": 1, "хоёр": 2, "гурав": 3, "гурван": 3, "дөрөв": 4, "дөрвөн": 4, "тав": 5, "таван": 5,
          "зургаа": 6, "зургаан": 6, "долоо": 7, "долоон": 7, "найм": 8, "найман": 8, "ес": 9, "есөн": 9}
_TENS = {"арав": 10, "арван": 10, "хорь": 20, "хорин": 20, "гуч": 30, "гучин": 30, "дөч": 40, "дөчин": 40,
         "тавь": 50, "тавин": 50, "жар": 60, "жаран": 60, "дал": 70, "далан": 70, "ная": 80, "наян": 80,
         "ер": 90, "ерэн": 90}
_HUNDRED = {"зуу", "зуун"}
_THOUSAND = {"мянга", "мянган"}
_ALL = {**_UNITS, **_TENS, **{w: 100 for w in _HUNDRED}, **{w: 1000 for w in _THOUSAND}}
# Ordinal / case endings a number word may carry: "есдүгээр", "гуравдугаар", "мянгын".
_SUFFIX = re.compile(r"(дугаар|дүгээр|дахь|дэх|ын|ийн)$")


def _number_word(word):
    """The number word this is, allowing an ending and a small misspelling ('манган'); None if not one."""
    for w in (word, _SUFFIX.sub("", word)):
        if w in _ALL:
            return w
    if len(word) >= 5:  # short words are too easy to confuse with ordinary words
        close = difflib.get_close_matches(_SUFFIX.sub("", word), _ALL, n=1, cutoff=0.8)
        if close:
            return close[0]
    return None


def to_digits(words):
    """Replace each run of number words with its value as digits."""
    out, total, current, in_number = [], 0, 0, False
    for word in words + [None]:
        nw = _number_word(word) if word else None
        if nw:
            value = _ALL[nw]
            if value == 1000:
                total += (current or 1) * 1000
                current = 0
            elif value == 100:
                current = (current or 1) * 100
            else:
                current += value
            in_number = True
            continue
        if in_number:
            out.append(str(total + current))
            total, current, in_number = 0, 0, False
        if word is not None:
            out.append(word)
    return out


# --- digits -> words, for route numbers ---------------------------------------------------------
# Same rule as the app's numberWords(n, false) (app/lib/reader/speechText.ts): tens before a unit in the
# attributive form ('хорин ес'), alone in the plain one ('хорь', 'дөч').
_WORD_UNITS = ["", "нэг", "хоёр", "гурав", "дөрөв", "тав", "зургаа", "долоо", "найм", "ес"]
_WORD_TENS = ["", "арав", "хорь", "гуч", "дөч", "тавь", "жар", "дал", "ная", "ер"]
_WORD_TENS_BOUND = ["", "арван", "хорин", "гучин", "дөчин", "тавин", "жаран", "далан", "наян", "ерэн"]


def words(n):
    """1..99 in words: 57 -> 'тавин долоо', 40 -> 'дөч', 10 -> 'арав'. '' outside 1..99."""
    if not 1 <= n <= 99:
        return ""
    t, u = divmod(n, 10)
    out = []
    if t:
        out.append(_WORD_TENS_BOUND[t] if u else _WORD_TENS[t])
    if u:
        out.append(_WORD_UNITS[u])
    return " ".join(out)


def _route_speech_config():
    """shared/route_speech.json: how each route letter is said (also read by app/lib/route.ts). Next to
    this file on the lite server if the deploy copied it there; plain letters if it is missing."""
    here = Path(__file__).resolve().parent
    for path in (here.parent / "shared" / "route_speech.json", here / "route_speech.json"):
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    return {"prefix": {p: p for p in ("М", "Ч", "Ү", "Х", "Д", "ШҮ")}, "suffix": {s: s for s in ("А", "Б", "ӨВ")}}


_ROUTE_SPEECH = _route_speech_config()
# Hamuga's variant tags, not on the sign: 'Ч:29Б-Ма', 'М:1БНА', 'Ч:16а-Z', 'М:5-КОП_copy', 'Ч:71МА'.
_TAGS = r"(?:-?(?:ма|на|z|коп)|_copy)*"
_ROUTE_NUMBER = re.compile(r"^[^0-9]*?([0-9]+)\s*(?:(өв|[аб])(?=" + _TAGS + r"$))?", re.IGNORECASE)


def route_words(route_no):
    """A route in words for the voice: 'Ч:29Б' -> 'Ч хорин ес Б', '29Б' -> 'хорин ес Б'. Never digits.
    An unknown prefix ('COP:1') is left out, a suffix is said only when nothing but variant tags follows
    it; '' when there is no route number (1..99). Same as the app's routeSpeech (app/lib/route.ts):
    test-fixtures/speech/routes.expected.json checks both."""
    t = route_no.strip()
    head, colon, rest = t.partition(":")
    prefix = _ROUTE_SPEECH["prefix"].get(head.strip().upper(), "") if colon else ""
    m = _ROUTE_NUMBER.match(rest.strip() if colon else t)
    n = int(m.group(1)) if m else 0
    if not m or not 1 <= n <= 99:
        return ""
    suffix = _ROUTE_SPEECH["suffix"].get(m.group(2).upper(), "") if m.group(2) else ""
    return " ".join(w for w in (prefix, words(n), suffix) if w)
