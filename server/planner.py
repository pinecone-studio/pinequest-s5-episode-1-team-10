"""What the rider said + GPS -> the bus to board.

A place name ("Сансар руу") becomes one direct bus, or two with a transfer (дамжин суух).
A bus number ("55", "Ч:55", "55-р автобус") becomes that route at the nearest stop it still leaves from.
"""
import difflib
import re
from functools import cache

import bus_api
import numwords

PHRASE_FIRST_MIN = 0.85
PHRASE_FIRST_MARGIN = 0.05  # "19-р сургууль" vs "149-р сургууль" (0.95 vs 0.91) is left to the number match
PHRASE_MATCH_MIN = 0.75
COVERAGE_MIN = 0.6  # measured: near-misses score 0.88-0.92, misheard garbage <= 0.54
SAME_PLACE_M = 1000  # stops with the named stop's name this close are its other sides of the street
DEST_RADIUS_M = 500  # other stops this close are a fallback when no bus reaches the named stop
WALK_MAX_M = 800
AT_STOP_M = 30  # closer than this: "you're at the stop", not "walk 0 m"  # ponytail: farthest boarding stop we suggest to a blind rider
ORIGIN_LIMIT = 8
# Filler words riders say around a place name ("Сансар руу явмаар байна").
STOPWORDS = {"энэ", "тэр", "уу", "үү", "нь", "бол", "ч", "би", "дээр", "байгаа", "одоо", "ойрхон", "хажууд", "буудлын", "зогсоолын", "руу", "рүү", "луу", "лүү", "уруу", "явах", "явна", "явмаар", "очих", "очно", "очмоор", "хүрэх",
             "хүрмээр", "байна", "би", "минь", "вэ", "хүртэл", "зогсоол", "буудал", "автобус", "автобусаар"}


# Trip cost, in "stops of riding": the cheapest trip wins. A direct bus beats a transfer unless the transfer
# saves more than TRANSFER_PENALTY stops (getting off, finding and waiting for the second bus, blind).
WALK_COST_M = 150  # walking this far to the first stop costs as much as riding one stop
TRANSFER_PENALTY = 6
TRANSFER_WALK_M = 200  # the second bus may leave from another stop this close (other side of the street)
TRANSFER_WALK_COST_M = 60
# Which direct bus is suggested: the shortest walk to its stop first, then the fewest stops. Walks are
# compared in WALK_STEP_M steps (metres // 50): GPS is off by tens of metres, so 33 m and 45 m are the
# same walk and the bus with fewer stops wins; 30 m beats 400 m even if the 400 m stop saves stops.
WALK_STEP_M = 50
CLOSE_WALK_M = 250  # the rider is this close to the place they named: walking beats any bus
SHORT_WORD = 6  # words shorter than this ("муис", "марал") are only fixed by a near-perfect spelling match
SHORT_WORD_CUTOFF = 0.92
# Filler around a place name, but some stops are named with these words ("65-ын зогсоол", "Автобус 2").
NAME_WORDS = {"зогсоол", "буудал", "автобус", "автобусаар"}

# Riders also type Mongolian in Latin letters ("sukhbaatar talbai", "xaan"): longest spellings first.
LATIN = [("shch", "щ"), ("kh", "х"), ("ch", "ч"), ("sh", "ш"), ("ts", "ц"), ("ya", "я"), ("yo", "ё"), ("yu", "ю"),
         ("ye", "е"), ("a", "а"), ("b", "б"), ("c", "ц"), ("d", "д"), ("e", "э"), ("f", "ф"), ("g", "г"), ("h", "х"),
         ("i", "и"), ("j", "ж"), ("k", "к"), ("l", "л"), ("m", "м"), ("n", "н"), ("o", "о"), ("p", "п"), ("q", "к"),
         ("r", "р"), ("s", "с"), ("t", "т"), ("u", "у"), ("v", "в"), ("w", "в"), ("x", "х"), ("y", "ы"), ("z", "з"),
         ("ö", "ө"), ("ü", "ү")]
# Spelling that doesn't change which place it is: ү/у, ө/о, й/и... ("Сухбаатарын", "Сүхбаатарийн").
_FOLD = str.maketrans({"ү": "у", "ө": "о", "ё": "е", "э": "е", "й": "и", "ы": "и", "ь": "", "ъ": ""})


def cyrillic(text):
    """Latin-typed Mongolian to Cyrillic; Cyrillic text is returned as is."""
    out, t = [], text.lower()
    i = 0
    while i < len(t):
        for lat, cyr in LATIN:
            if t.startswith(lat, i):
                out.append(cyr)
                i += len(lat)
                break
        else:
            out.append(t[i])
            i += 1
    return "".join(out)


def fold(text):
    """Lowercase, punctuation to spaces, look-alike letters merged: for comparing whole names."""
    return " ".join(re.sub(r"[-–—,.:;!?\"'«»()/]", " ", text.lower()).translate(_FOLD).split())


@cache
def _names_by_fold():
    by = {}
    for st in bus_api._stops():
        # Through cyrillic() like the query, so Latin-named stops ("Amar hotel") match either spelling.
        by.setdefault(fold(cyrillic(bus_api.base_name(st["name"]))), []).append(st)
    return by


_FILLER = None


def _filler():
    global _FILLER
    if _FILLER is None:
        _FILLER = {fold(w) for w in STOPWORDS - NAME_WORDS}
    return _FILLER


def exact_name(text):
    """Stops whose whole name the rider said, filler around it ignored ("Сүхбаатарын талбай руу
    явмаар байна"). Covers every stop name, including ones the word search can't: names made of
    filler or number words ("65-ын зогсоол", "Далан") and names that differ by one number."""
    words = fold(cyrillic(text)).split()
    by = _names_by_fold()
    while words:
        key = " ".join(words)
        if key in by:
            return by[key]
        if words[-1] in _filler():
            words = words[:-1]
        elif words[0] in _filler():
            words = words[1:]
        else:
            return []
    return []


class PlanError(Exception):
    """No suggestion possible; the message is Mongolian and safe to speak to the rider."""


def query_words(text):
    """Place words and numbers: 'Дэнжийн 1000 руу' -> ['дэнжийн', '1000']. Numbers matter: many stops
    differ only by one ('Дэнжийн 1-р зогсоол' vs 'Дэнжийн 1000-ын эцэс')."""
    words = numwords.to_digits(re.findall(r"[^\W\d_]+|\d+", cyrillic(text)))
    return [w for w in words if w.isdigit() or (w not in STOPWORDS and len(w) >= 2)]


def _similarity(phrase, stop):
    return difflib.SequenceMatcher(None, phrase, bus_api.base_name(stop["name"])).ratio()


def _squash(s):
    return re.sub(r"[\s\-]", "", s)


def _clear_phrase_match(words):
    """Stops of the one name the whole phrase spells, ignoring spaces, when that's clear-cut.
    Speech recognition splits words ('Сөх Баатарын тал бай' for 'Сүхбаатарын талбай': 0.94), which
    breaks a word-by-word search. Measured: right names 0.86-1.0, garbage <= 0.53."""
    phrase = _squash(" ".join(words))
    by_name = {}
    for s in bus_api._stops():
        by_name.setdefault(_squash(bus_api.base_name(s["name"])), []).append(s)
    scored = sorted(((difflib.SequenceMatcher(None, phrase, n).ratio(), n) for n in by_name), reverse=True)
    (best, name), (second, _) = scored[0], scored[1]
    if len(phrase) < SHORT_WORD and best < 1:
        return []  # "муис" is 0.89 like "мубис": a different university, not a mishearing
    return by_name[name] if best >= PHRASE_FIRST_MIN and best - second >= PHRASE_FIRST_MARGIN else []


def _coverage(words, stop):
    """Share of the rider's letters that the stop's name accounts for."""
    name_words = bus_api.base_name(stop["name"]).split()
    matched = sum(len(w) if w.isdigit() and bus_api._stem_match(w, name_words) else bus_api._stem_match(w, name_words)
                  for w in words)
    return matched / sum(len(w) for w in words)


def _conflicts(words, stop):
    """A word the rider said that isn't in the name, while the name has a word they didn't say:
    'Их тойруу' (a road) vs 'Гадна тойруу' -- a different place, not a mishearing."""
    name_words = bus_api.base_name(stop["name"]).split()
    said_not_in_name = [w for w in words if not bus_api._stem_match(w, name_words)]
    name_not_said = [nw for nw in name_words if not any(bus_api._stem_match(w, [nw]) for w in words)]
    return bool(said_not_in_name and name_not_said)


def _covering(words, stops):
    """Only stops whose name accounts for most of what was said, with no conflicting word:
    'Төв шуудан' must not become 'Төв номын сан' just because 'төв' matched."""
    return [s for s in stops if _coverage(words, s) >= COVERAGE_MIN and not _conflicts(words, s)]


def _candidates(words):
    """Stops whose name matches the words: a clear whole-phrase match first, then an exact-stem search,
    then each word swapped for the closest stop-name word ('сансаар' -> 'сансар'), then the whole
    phrase against whole names at a lower bar ('улсын их дэлгуур')."""
    found = _clear_phrase_match(words)
    if found:
        return found
    found = _covering(words, bus_api.search_stops(words))
    if found:
        return found
    vocab = {w for s in bus_api._stops() for w in bus_api.base_name(s["name"]).split() if len(w) >= 4}
    # A short word must be spelt almost exactly ("марал" is not "маршал").
    fixed = [(difflib.get_close_matches(w, vocab, n=1, cutoff=0.75 if len(w) >= SHORT_WORD else SHORT_WORD_CUTOFF) or [w])[0]
             if len(w) >= 4 else w for w in words]
    found = _covering(fixed, bus_api.search_stops(fixed)) if fixed != words else []
    if found:
        return found
    by_name = {}
    for s in bus_api._stops():
        by_name.setdefault(bus_api.base_name(s["name"]), []).append(s)
    score, name = max((difflib.SequenceMatcher(None, " ".join(words), n).ratio(), n) for n in by_name)
    if len(" ".join(words)) < SHORT_WORD and score < 1:
        return []
    return by_name[name] if score >= PHRASE_MATCH_MIN else []


def find_destination(words, text=None):
    """(named, nearby) for the one place the rider named; ([], []) if nothing matches well enough.

    named: the stop whose whole name sounds most like the words, with its other sides of the street.
    nearby: other stops within DEST_RADIUS_M, used only when no direct bus reaches a named stop.
    Never a second place across town that shares one word ('улсын' is in both 'Улсын их дэлгүүр'
    and the airport's name).
    """
    exact = exact_name(text) if text else []
    found = exact or (_candidates(words) if words else [])
    if not found:
        return [], []
    phrase = " ".join(words)
    best = found[0] if exact else max(found, key=lambda s: _similarity(phrase, s))
    name = bus_api.base_name(best["name"])

    def dist(s):
        return bus_api._distance_m(best["lat"], best["lon"], s["lat"], s["lon"])

    named = [s for s in bus_api._stops() if bus_api.base_name(s["name"]) == name and dist(s) <= SAME_PLACE_M]
    nearby = [s for s in bus_api._stops() if s not in named and dist(s) <= DEST_RADIUS_M]
    return named, nearby


def _orders(stop, route):
    """Riding orders (stop ids) of every variant/direction of route that passes stop."""
    return [order for rid in stop["route_ids"].get(route, []) for order in bus_api.route_directions(rid)
            if stop["stop_id"] in order]


@cache
def _stops_by_id():
    return {s["stop_id"]: s for s in bus_api._stops()}


@cache
def _neighbours(stop_id):
    """[(stop, metres)] within TRANSFER_WALK_M, the stop itself first."""
    me = _stops_by_id()[stop_id]
    near = [(s, bus_api._distance_m(me["lat"], me["lon"], s["lat"], s["lon"])) for s in bus_api._stops()]
    return sorted([(s, m) for s, m in near if m <= TRANSFER_WALK_M], key=lambda item: item[1])


def _best_direct(origins, dests):
    """(cost, origin, route, dest, stops) of the one-bus trip to suggest, or None.

    The trip: shortest walk to the boarding stop (WALK_STEP_M steps), then fewest stops, then the
    lower cost. `cost` is the cheapest one-bus trip's, not this one's: a transfer is chosen only when it
    beats every direct bus, as before."""
    best = None
    cheapest = None
    for o in origins:
        for d in dests:
            for route in sorted(set(o["routes"]) & set(d["routes"])):
                n = bus_api.stops_between(o["route_ids"][route], o["stop_id"], d["stop_id"])
                if n is not None:
                    cost = n + o["distance_m"] / WALK_COST_M
                    rank = (o["distance_m"] // WALK_STEP_M, n, cost)
                    if best is None or rank < best[0]:
                        best = (rank, o, route, d, n)
                    if cheapest is None or cost < cheapest:
                        cheapest = cost
    return None if best is None else (cheapest,) + best[1:]


def _best_transfer(origins, dests):
    """The cheapest two-bus trip: bus 1 from an origin to a transfer stop, bus 2 from that stop (or one
    within TRANSFER_WALK_M) to a dest. (cost, o, r1, n1, t1, t2, r2, n2, d, walk_m) or None.
    Searches every stop every origin route reaches against every stop every dest route comes from."""
    reach = {}  # stop_id -> (cost, origin, route, stops) riding the first bus there
    for o in origins:
        for r1 in o["routes"]:
            for order in _orders(o, r1):
                i = order.index(o["stop_id"])
                for j in range(i + 1, len(order)):
                    cost = (j - i) + o["distance_m"] / WALK_COST_M
                    if order[j] not in reach or cost < reach[order[j]][0]:
                        reach[order[j]] = (cost, o, r1, j - i)
    best = None
    by_id = _stops_by_id()
    for d in dests:
        for r2 in d["routes"]:
            for order in _orders(d, r2):
                k = order.index(d["stop_id"])
                for j in range(k):
                    t2 = by_id.get(order[j])
                    if not t2:
                        continue
                    for t1, walk in _neighbours(t2["stop_id"]):
                        if t1["stop_id"] not in reach:
                            continue
                        c1, o, r1, n1 = reach[t1["stop_id"]]
                        if (spoken_key(r1) or r1.strip()) == (spoken_key(r2) or r2.strip()):
                            continue  # same number on the sign (Ч:29Б / Ч:29Б-Z variants): not a real transfer
                        cost = c1 + (k - j) + TRANSFER_PENALTY + walk / TRANSFER_WALK_COST_M
                        if best is None or cost < best[0]:
                            best = (cost, o, r1, n1, t1, t2, r2, k - j, d, round(walk))
    return best


def locate(text):
    """The stop the rider says they're at ('Би Төв номын сангийн буудал дээр байна'), or None."""
    words = query_words(text)
    named, _ = find_destination(words, text)
    return named[0] if named else None


# Every spoken sentence is built from pieces that can all be pre-recorded (free hosting can't make
# speech live): fixed phrases, numbers in fixed phrases, and one clip per stop name.
SIDE_PIECES = {"урд": "Урд тал.", "хойд": "Хойд тал.", "зүүн": "Зүүн тал.", "баруун": "Баруун тал."}
MAX_RIDE_STOPS = 60
MSG_SAY_AGAIN = "Очих газрын нэрийг дахин хэлнэ үү."
MSG_NOT_FOUND = "Ийм нэртэй зогсоол олдсонгүй. Өөр нэрээр хэлнэ үү."
MSG_NO_STOP_NEAR = "Таны ойролцоо 800 метрт автобусны зогсоол алга."
MSG_CLOSE = "Та очих газартаа ойрхон байна. Алхаж очоорой."
MSG_NO_DIRECT = "Таны ойролцоох зогсоолоос тийшээ хүрэх автобус олдсонгүй."
MSG_NO_BUS_NEAR = "Таны ойролцоо 800 метрт энэ дугаартай автобус зогсдоггүй."  # = phrases.json "no_bus_near"
TRANSFER_STOP = "Дамжин суух зогсоол:"
MSG_NOT_A_STOP = "Ийм нэртэй зогсоол олдсонгүй. Ойролцоох зогсоолын нэрийг хэлнэ үү."


def stop_name(name):
    """'Сансар ШТС /Урд/' -> 'Сансар ШТС' (side markers and brackets removed)."""
    return " ".join(re.sub(r"/[^/]*/|\([^)]*\)", " ", name).split())


def stop_pieces(name):
    """['Сансар ШТС.', 'Урд тал.'] -- one clip per stop name, one per side of the street."""
    base, s = stop_name(name), side(name)
    return ([base + "."] if base else []) + ([SIDE_PIECES[s]] if s else [])


def walk_piece(metres):
    return "Та зогсоол дээр байна." if metres < AT_STOP_M else f"Зогсоол руу {min(WALK_MAX_M, round(metres, -1))} метр алхана."


def ride_piece(stops):
    return f"{min(stops, MAX_RIDE_STOPS)} зогсоол явна."


def next_stop_speech(name):
    """Said on the bus when a stop is coming up: ['Дараагийн зогсоол:', 'МУБИС.', 'Зүүн тал.']."""
    return ["Дараагийн зогсоол:"] + stop_pieces(name)


def piece_phrases():
    """Every fixed piece, for pre-recording."""
    return (["Суух зогсоол:", "Буух зогсоол:", "Дараагийн зогсоол:", "Очих газар тань тэндээс ойрхон.", TRANSFER_STOP,
             MSG_SAY_AGAIN, MSG_NOT_FOUND, MSG_NO_STOP_NEAR, MSG_CLOSE, MSG_NO_DIRECT, MSG_NO_BUS_NEAR, MSG_NOT_A_STOP,
             walk_piece(0)]
            + list(SIDE_PIECES.values())
            + [walk_piece(m) for m in range(AT_STOP_M, WALK_MAX_M + 1, 10) if m >= AT_STOP_M]
            + [ride_piece(n) for n in range(1, MAX_RIDE_STOPS + 1)])


def name_phrases():
    """One clip per stop name, busiest stops first (pre-recording takes ~8 s each)."""
    order, seen = [], set()
    for s in sorted(bus_api._stops(), key=lambda s: -len(s["routes"])):
        base = stop_name(s["name"])
        if base and base not in seen:
            seen.add(base)
            order.append(base + ".")
    return order


def side(name):
    """'Сансар ШТС /Урд/' -> 'урд'; None if the name has no side marker."""
    m = re.search(r"/\s*(Урд|Хойд|Зүүн|Баруун)\s*/", name, re.IGNORECASE)
    return m.group(1).lower() if m else None


def spoken_stop(name):
    """Stop name as TTS should read it: 'Сансар ШТС /Урд/' -> 'Сансар ШТС, урд тал'."""
    s = side(name)
    base = " ".join(re.sub(r"/[^/]*/|\([^)]*\)", " ", name).split())
    return f"{base}, {s} тал" if s else base


def spoken_key(route_no):
    """('75', '') or ('1', 'А'): the number and optional А/Б on the sign.

    Riders know buses by number (+ А/Б). Hamuga's variant tags (Ма, НА, Z, _copy, -КОП) aren't on the sign,
    so 'Ч:55', 'Ч:55_copy' and 'Ч:55-Ма' are all ('55', ''), while 'Ч:55Б' is ('55', 'Б').
    """
    m = re.match(r"\D*(\d+)\s*([АБаб])?", route_no.rsplit(":", 1)[-1])
    if not m:
        return None
    return m.group(1), (m.group(2).upper() if m.group(2) else "")


def spoken_route(route_no):
    """'Ч:75' -> 'Ч далан тав автобус', 'М:1А-Ма' -> 'М нэг А автобус': the route in words (numwords.route_words,
    letters as shared/route_speech.json says them), never digits or the raw code. Just 'автобус' if it has
    no route number. Only for speech: which routes are the same bus is spoken_key."""
    words = numwords.route_words(route_no)
    return f"{words} автобус" if words else "автобус"


def transfer_speech(route_no):
    """'Ч хорин ес автобусанд дамжин суугаарай.' -- per route, pre-recordable like take_speech."""
    return f"{spoken_route(route_no)}анд дамжин суугаарай."


def take_speech(route_no):
    """Same text for every rider of this route, so its clip is made once (make_speech.py)."""
    return f"{spoken_route(route_no)}анд суугаарай."


def found_speech(route_no):
    return f"{spoken_route(route_no)} ирлээ. Энэ таны автобус."


def route_phrases(transfers=False):
    """Every take/found sentence for every route, for pre-making TTS clips. The server warms these at
    startup; transfer sentences (one more per route, ~1 h of TTS) only for make_speech.py, since the
    server makes a trip's own transfer clip right after planning, while the route is read out."""
    routes = {r for s in bus_api._stops() for r in s["routes"]}
    kinds = (take_speech, found_speech) + ((transfer_speech,) if transfers else ())
    return sorted({f(r) for r in routes for f in kinds})


def _stop_out(st, **extra):
    return {"stop_id": st["stop_id"], "name": st["name"], **extra}


def _plan(o, route, n, d, named, exact, transfer=None):
    """PlanResponse dict. With a transfer, route/alight_stop/stops_to_ride are the FIRST bus, and
    "transfer" holds the second: get off at transfer.alight_stop... (see contract.Transfer)."""
    near_note = [] if exact else ["Очих газар тань тэндээс ойрхон."]
    if transfer:
        t1, t2, r2, n2, walk = transfer
        leg1_off = t1
    else:
        leg1_off = d
    # Pieces, all pre-recordable: "Ч хорин ес Б автобусанд суугаарай." "Суух зогсоол:" "Вокзал." "Хойд тал."
    # "Зогсоол руу 460 метр алхана." "6 зогсоол явна." then either "Буух зогсоол:" ... or
    # "Дамжин суух зогсоол:" "МУИС." ["Зогсоол руу 120 метр алхана."] "Ч гурав автобусанд дамжин суугаарай." "4 зогсоол явна." "Буух зогсоол:" ...
    speech = [take_speech(route), "Суух зогсоол:"] + stop_pieces(o["name"]) + [walk_piece(o["distance_m"]), ride_piece(n)]
    plan = {
        "route": route,
        "board_stop": _stop_out(o, distance_m=o["distance_m"], lat=o["lat"], lon=o["lon"]),
        "destination": _stop_out(named[0]),
        "alight_stop": _stop_out(leg1_off),
        "stops_to_ride": n,
        "routes_at_stop": o["routes"],
        "found_speech": found_speech(route),
        "transfer": None,
    }
    if transfer:
        second = ([walk_piece(walk)] if walk >= AT_STOP_M else []) + [transfer_speech(r2), ride_piece(n2)]
        speech += [TRANSFER_STOP] + stop_pieces(t1["name"]) + second
        plan["transfer"] = {
            "route": r2,
            "board_stop": _stop_out(t2, distance_m=walk, lat=t2["lat"], lon=t2["lon"]),
            "alight_stop": _stop_out(d),
            "stops_to_ride": n2,
            "found_speech": found_speech(r2),
            # Said at the transfer stop: ["Зогсоол руу 40 метр алхана."] "Ч хорин ес автобусанд дамжин суугаарай." "4 зогсоол явна." "Буух зогсоол:" ...
            "speech": second + ["Буух зогсоол:"] + stop_pieces(d["name"]) + near_note,
        }
    plan["speech"] = speech + ["Буух зогсоол:"] + stop_pieces(d["name"]) + near_note
    return plan


# Words around a bus number that aren't part of the number ("55-р автобусанд суумаар байна").
_BUS_EXTRA = {"р", "дугаар", "дүгээр", "дугаартай", "дугаарын", "суух", "сууя", "суумаар", "сууна", "суугаарай",
              "авья", "авна", "авмаар", "номер"}


def bus_request(text):
    """(number, letter, prefix) when the rider named a bus, else None.

    '55' / '55-р автобус' / 'тавин тавдугаар автобус' -> ('55', '', '').
    'Ч:55' -> ('55', '', 'ч'). '55Б' / '55 б' -> ('55', 'Б', '').
    A place that merely contains a number ('Дэнжийн 1000', '19-р сургууль') is not a bus number.
    letter is '' or 'А'/'Б'. prefix is '' or the part before the colon ('ч', 'х', 'нү').
    """
    words = numwords.to_digits(re.findall(r"[^\W\d_]+|\d+", cyrillic(text).lower()))
    # "ч" is a filler particle in place names, but it is also the city-bus prefix ("Ч:55").
    kept = [w for w in words if w not in (STOPWORDS - {"ч"}) and w not in _BUS_EXTRA and not w.startswith("автобус")]
    # "ч" after the number is the particle ("55-р автобус ч"), not the Ч: prefix, which comes first.
    if len(kept) > 1 and kept[-1] == "ч":
        kept = kept[:-1]
    if not kept:
        return None

    def is_num(item):
        return item.isdigit() and 1 <= len(item) <= 3 and int(item) != 0

    def is_letter(item):
        return item in ("а", "б")

    def is_prefix(item):
        return item.isalpha() and 1 <= len(item) <= 2

    prefix, num, letter = "", None, ""
    if len(kept) == 1 and is_num(kept[0]):
        num = kept[0]
    elif len(kept) == 2 and is_num(kept[0]) and is_letter(kept[1]):
        num, letter = kept[0], kept[1].upper()
    elif len(kept) == 2 and is_prefix(kept[0]) and is_num(kept[1]):
        prefix, num = kept[0], kept[1]
    elif len(kept) == 3 and is_prefix(kept[0]) and is_num(kept[1]) and is_letter(kept[2]):
        prefix, num, letter = kept[0], kept[1], kept[2].upper()
    else:
        return None
    return str(int(num)), letter, prefix


def _route_prefix(route_no):
    return fold(route_no.split(":")[0].strip())


def _matches_bus(route_no, num, letter, prefix):
    if spoken_key(route_no) != (num, letter):
        return False
    return not prefix or _route_prefix(route_no) == fold(prefix)


def _route_rank(route_no):
    """Prefer the number printed on the sign: 'Ч:55' over 'Ч:55_copy' / 'Ч:55-Ма', and a city bus (Ч)."""
    from fusion import route_number

    num = route_number(route_no)
    clean = 0 if re.fullmatch(r"\d{1,3}[аб]?", num) else 1
    copy = 1 if "_copy" in route_no.lower() or "коп" in route_no.lower() else 0
    city = 0 if _route_prefix(route_no) == "ч" else 1
    return (clean, copy, city, len(route_no), route_no)


def _within(lat, lon, max_m):
    """Every stop within max_m, closest first. Not capped at ORIGIN_LIMIT: the wanted bus may be
    the 9th-closest stop and still inside the walk we offer a blind rider."""
    found = []
    for stop in bus_api._stops():
        metres = bus_api._distance_m(lat, lon, stop["lat"], stop["lon"])
        if metres <= max_m:
            found.append({**stop, "distance_m": round(metres)})
    found.sort(key=lambda item: item["distance_m"])
    return found


def _stop_record(stop_id):
    """A stop dict for speech and the plan, from the route list or (name only) the station list."""
    st = _stops_by_id().get(stop_id)
    if st:
        return st
    station = bus_api._stations().get(stop_id)
    if not station or not station.get("name"):
        return None
    return {"stop_id": stop_id, "name": station["name"], "lat": station["lat"], "lon": station["lon"]}


def _ride_to_end(stop, route):
    """(alight_stop, stops_to_ride) for the direction that still has the most stops after `stop`.

    A stop the route only terminates at is not a place to board. None if every direction ends here
    or the stops ahead have no name.
    """
    best = None
    for rid in stop["route_ids"].get(route, []):
        for order in bus_api.route_directions(rid):
            if stop["stop_id"] not in order:
                continue
            i = order.index(stop["stop_id"])
            for j in range(len(order) - 1, i, -1):
                alight = _stop_record(order[j])
                if not alight:
                    continue
                n = j - i
                if n >= 1 and (best is None or n > best[1]):
                    best = (alight, n)
                break
    return best


def _suggest_bus(num, letter, prefix, lat, lon):
    """PlanResponse for 'I want bus N': board at the nearest stop (≤800 m) that bus still leaves
    from. No destination was named, so the get-off stop is the last stop of that riding direction
    and the speech is an ordinary plan — the walk, camera and door steps don't change."""
    near = _within(lat, lon, WALK_MAX_M)
    if not near:
        raise PlanError(MSG_NO_STOP_NEAR)
    for stop in near:
        routes = [item for item in stop["routes"] if _matches_bus(item, num, letter, prefix)]
        if not routes:
            continue
        bus_api.load_route_directions(rid for item in routes for rid in stop["route_ids"].get(item, []))
        for route in sorted(routes, key=_route_rank):
            trip = _ride_to_end(stop, route)
            if not trip:
                continue
            alight, n = trip
            return _plan(stop, route, n, alight, [alight], True)
    raise PlanError(MSG_NO_BUS_NEAR)


ALT_MIN = 0.6  # another stop name this close to what was heard is offered when the match isn't exact
ALT_MAX = 2
GUESS_MIN = 0.8  # nothing matched: the closest-sounding stop at least this close is ASKED about, never used
# Measured with Speechmatics on our clips: "Зайсан" -> "Айсан" / "Байсан" (0.91), which the strict
# search rejects (a short word must match almost exactly) and the rider heard "not found".


def _closest_guess(words):
    """Stops of the one name that sounds most like the words (whole phrase or a single word), or []."""
    phrase = _squash(" ".join(words))
    if not phrase:
        return []
    by_name = {}
    for s in bus_api._stops():
        by_name.setdefault(bus_api.base_name(s["name"]), []).append(s)
    def score(name):
        whole = difflib.SequenceMatcher(None, phrase, _squash(name)).ratio()
        word = max((difflib.SequenceMatcher(None, w, nw).ratio() for w in words if len(w) >= 4 for nw in name.split()), default=0)
        return max(whole, word if len(name.split()) == 1 else 0)  # one word only stands for a one-word name
    best = max(by_name, key=score)
    return by_name[best] if score(best) >= GUESS_MIN else []


def _alternatives(words, named):
    """Other stop names that sound like what was heard, best first (not the chosen one)."""
    phrase = _squash(" ".join(words))
    chosen = {bus_api.base_name(s["name"]) for s in named}
    scored = {}
    for s in bus_api._stops():
        base = bus_api.base_name(s["name"])
        if base in chosen or base in scored:
            continue
        scored[base] = (difflib.SequenceMatcher(None, phrase, _squash(base)).ratio(), stop_name(s["name"]))
    best = sorted(scored.values(), reverse=True)[:ALT_MAX]
    return [name for score, name in best if score >= ALT_MIN]


def suggest(text, lat, lon):
    """PlanResponse dict. "sure" is False when the destination wasn't heard as a whole stop name (a
    sound-alike was chosen): the app asks "is it X?" before giving the trip, with "alternatives"."""
    bus = bus_request(text)
    if bus:
        return _suggest_bus(*bus, lat, lon)
    words = query_words(text)
    named, nearby = find_destination(words, text)
    guessed = False
    if not named and words:
        named = _closest_guess(words)
        guessed = bool(named)
        if guessed:
            name = bus_api.base_name(named[0]["name"])
            near = named[0]
            named = [s for s in bus_api._stops() if bus_api.base_name(s["name"]) == name
                     and bus_api._distance_m(near["lat"], near["lon"], s["lat"], s["lon"]) <= SAME_PLACE_M]
            nearby = []
    # Sure = the whole stop name was heard, even split up by speech recognition ("Сүх баатарын тал бай").
    said = {_squash(fold(" ".join(words))), _squash(fold(cyrillic(text)))}
    sure = not guessed and (bool(exact_name(text)) or any(_squash(fold(bus_api.base_name(s["name"]))) in said for s in named))
    plan = _suggest_to(words, named, nearby, lat, lon)
    plan["sure"] = sure
    plan["alternatives"] = [] if sure else _alternatives(words, named)
    return plan


def _suggest_to(words, named, nearby, lat, lon):
    if not named and not words:
        raise PlanError(MSG_SAY_AGAIN)
    if not named:
        raise PlanError(MSG_NOT_FOUND)
    origins = bus_api.nearest_stops(lat, lon, WALK_MAX_M, ORIGIN_LIMIT)
    if not origins:
        raise PlanError(MSG_NO_STOP_NEAR)
    # Truly there (a few hundred metres): walk. Farther, even if "nearby", a bus is offered.
    if min(bus_api._distance_m(lat, lon, s["lat"], s["lon"]) for s in named) <= CLOSE_WALK_M:
        raise PlanError(MSG_CLOSE)

    # Every route through the origins and the destination: the transfer search needs their stop orders
    # (one Hamuga call per route variant the first time, then kept on disk).
    bus_api.load_route_directions(rid for st in origins + named + nearby for rids in st["route_ids"].values() for rid in rids)
    # A direct bus may leave from any stop within the walk, not only the ORIGIN_LIMIT closest (those feed
    # the transfer search, which tries every stop of every route). Only routes that also stop at the
    # destination are loaded for them.
    walkable = _within(lat, lon, WALK_MAX_M)
    to_dest = {r for st in named + nearby for r in st["routes"]}
    bus_api.load_route_directions(rid for st in walkable for r in st["routes"] if r in to_dest for rid in st["route_ids"][r])

    # Get off at the stop the rider named (direct or with one transfer); a neighbouring stop only if
    # nothing reaches the named one. A transfer only when it is cheaper than every direct bus (it costs
    # TRANSFER_PENALTY stops); of the direct buses, the shortest walk, then the fewest stops.
    for dests, exact in ((named, True), (nearby, False)):
        trips = [t for t in (_best_direct(walkable, dests), _best_transfer(origins, dests)) if t]
        if not trips:
            continue
        trip = min(trips, key=lambda t: t[0])
        if len(trip) == 5:
            _, o, route, d, n = trip
            return _plan(o, route, n, d, named, exact)
        _, o, r1, n1, t1, t2, r2, n2, d, walk = trip
        return _plan(o, r1, n1, d, named, exact, transfer=(t1, t2, r2, n2, walk))
    raise PlanError(MSG_NO_DIRECT)
