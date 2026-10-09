"""Mongolian number words -> digits, so a spoken stop name matches its written form:
'арван есдүгээр сургууль' -> '19 сургууль', 'дэнжийн мянган' -> 'дэнжийн 1000'."""
import difflib
import re

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
