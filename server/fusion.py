"""Decide yes/no/unsure from OCR texts and the routes serving the stop. Pure, no I/O."""
import re

# ponytail: tune on real sign photos.
CONF_MIN = 0.8

# Latin look-alikes -> Cyrillic; Hamuga and OCR mix them freely.
_LOOKALIKE = str.maketrans("aAMHeocxpKTB", "аАМНеосхрКТВ")
_TOKEN = re.compile(r"\d{1,3}[^\W\d_]{0,2}")
# "Ч:58" is read as "4:58" by the English model: drop whatever sits before a colon.
_PREFIX = re.compile(r"\S*:")


def _normalize(s):
    return s.replace(" ", "").replace("-", "").translate(_LOOKALIKE).lower()


def route_number(route_no):
    """'Ч:81' -> '81', 'М:3Ма' -> '3ма'."""
    return _normalize(route_no.rsplit(":", 1)[-1])


def candidates(texts):
    """Route-number tokens from OCR as {number: best confidence}."""
    found = {}
    for text, conf in texts:
        if conf < CONF_MIN:
            continue
        for tok in _PREFIX.sub(" ", text).split():
            tok = _normalize(tok)
            if _TOKEN.fullmatch(tok):
                found[tok] = max(conf, found.get(tok, 0.0))
    return found


def decide(texts, wanted_route, routes_here):
    found = candidates(texts)
    if not found:
        return "unsure", 0.0
    wanted = route_number(wanted_route)
    if wanted not in found:
        # LED "Ч:55" with a faint colon reads as "455": a leading "4" may be the prefix letter Ч.
        if "4" + wanted in found:
            return "unsure", 0.0
        # Only part of the number was read ("8" or "1" for 81): the rest may be there.
        if any(f != wanted and (wanted.startswith(f) or wanted.endswith(f)) for f in found):
            return "unsure", 0.0
        return "no", max(found.values())
    if routes_here is None or wanted_route not in routes_here:
        return "unsure", 0.0
    # A bare "7" could be "7а" too: a sibling extending the number makes the sign ambiguous.
    for r in routes_here:
        n = route_number(r)
        rest = n[len(wanted):]
        if r != wanted_route and n.startswith(wanted) and (not rest or rest.isalpha()):
            return "unsure", 0.0
    return "yes", found[wanted]
