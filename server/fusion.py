"""Decide yes/no/unsure from OCR texts and the routes serving the stop. Pure, no I/O."""
import re

# ponytail: tune on real sign photos.
CONF_MIN = 0.8

# Latin look-alikes -> Cyrillic; Hamuga and OCR mix them freely.
_LOOKALIKE = str.maketrans("aAMHeocxpKTB", "аАМНеосхрКТВ")
_TOKEN = re.compile(r"\d{1,3}[^\W\d_]{0,2}")
# "Ч:58" is read as "4:58" by the English model: drop whatever sits before a colon.
_PREFIX = re.compile(r"\S*:")
_GLUED = re.compile(r"(\d{1,3})(?:[^\W\d_]{3,}|[^\W\d_]+\d)")


def _normalize(s):
    return s.replace(" ", "").replace("-", "").translate(_LOOKALIKE).lower()


def route_number(route_no):
    """'Ч:81' -> '81', 'М:3Ма' -> '3ма'."""
    return _normalize(route_no.rsplit(":", 1)[-1])


def _tokens(texts):
    """Number-like tokens from OCR as {token: best confidence}."""
    found = {}
    for text, conf in texts:
        if conf < CONF_MIN:
            continue
        for tok in _PREFIX.sub(" ", text).split():
            tok = _normalize(tok)
            glued = _GLUED.match(tok)  # "455H1000-E": number run into the destination text
            for t in (tok, glued.group(1) if glued else None):
                if t and _TOKEN.fullmatch(t):
                    found[t] = max(conf, found.get(t, 0.0))
    return found


def candidates(texts, routes_here=None, city_numbers=None):
    """Route numbers read on the sign as {number: best confidence}.

    With routes_here, only numbers of routes serving this stop count: fleet numbers ("13-278"),
    phone numbers and misreads can't make a verdict. On dot-matrix LED signs the letter Ч is drawn
    like a 4, so "Ч55" reads "455": "4"+N counts as N when a Ч route N stops here and no route in
    the city (city_numbers) is numbered "4"+N.
    """
    found = _tokens(texts)
    if routes_here is None:
        return found
    here = {route_number(r) for r in routes_here}
    che_here = {route_number(r) for r in routes_here if r.strip().startswith("Ч")}
    out = {}
    for tok, conf in found.items():
        if tok in here:
            num = tok
        elif city_numbers is not None and tok.startswith("4") and tok[1:] in che_here and tok not in city_numbers:
            num = tok[1:]
        else:
            continue
        out[num] = max(conf, out.get(num, 0.0))
    return out


def decide(texts, wanted_route, routes_here, city_numbers=None):
    found = candidates(texts, routes_here, city_numbers)
    if not found:
        return "unsure", 0.0
    wanted = route_number(wanted_route)
    if wanted not in found:
        # Without bus data, LED "Ч:55" read as "455" can't be told from a route 455: stay unsure.
        if "4" + wanted in found:
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
