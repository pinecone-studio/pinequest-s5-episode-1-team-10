"""Destination words + rider GPS -> one direct bus to take."""
import difflib
import re

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


class PlanError(Exception):
    """No suggestion possible; the message is Mongolian and safe to speak to the rider."""


def query_words(text):
    """Place words and numbers: 'Дэнжийн 1000 руу' -> ['дэнжийн', '1000']. Numbers matter: many stops
    differ only by one ('Дэнжийн 1-р зогсоол' vs 'Дэнжийн 1000-ын эцэс')."""
    words = numwords.to_digits(re.findall(r"[^\W\d_]+|\d+", text.lower()))
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
    fixed = [(difflib.get_close_matches(w, vocab, n=1, cutoff=0.75) or [w])[0] if len(w) >= 4 else w for w in words]
    found = _covering(fixed, bus_api.search_stops(fixed)) if fixed != words else []
    if found:
        return found
    by_name = {}
    for s in bus_api._stops():
        by_name.setdefault(bus_api.base_name(s["name"]), []).append(s)
    score, name = max((difflib.SequenceMatcher(None, " ".join(words), n).ratio(), n) for n in by_name)
    return by_name[name] if score >= PHRASE_MATCH_MIN else []


def find_destination(words):
    """(named, nearby) for the one place the rider named; ([], []) if nothing matches well enough.

    named: the stop whose whole name sounds most like the words, with its other sides of the street.
    nearby: other stops within DEST_RADIUS_M, used only when no direct bus reaches a named stop.
    Never a second place across town that shares one word ('улсын' is in both 'Улсын их дэлгүүр'
    and the airport's name).
    """
    found = _candidates(words)
    if not found:
        return [], []
    phrase = " ".join(words)
    best = max(found, key=lambda s: _similarity(phrase, s))
    name = bus_api.base_name(best["name"])

    def dist(s):
        return bus_api._distance_m(best["lat"], best["lon"], s["lat"], s["lon"])

    named = [s for s in bus_api._stops() if bus_api.base_name(s["name"]) == name and dist(s) <= SAME_PLACE_M]
    nearby = [s for s in bus_api._stops() if s not in named and dist(s) <= DEST_RADIUS_M]
    return named, nearby


def _best_ride(origins, dests):
    """(origin, route, dest, stops) from the closest boarding stop that has a direct bus to any of
    dests, taking the route with the fewest stops there; None if there is none."""
    for o in origins:
        best = None
        for d in dests:
            for route in sorted(set(o["routes"]) & set(d["routes"])):
                n = bus_api.stops_between(o["route_ids"][route], o["stop_id"], d["stop_id"])
                if n is not None and (best is None or n < best[3]):
                    best = (o, route, d, n)
        if best:
            return best
    return None


def locate(text):
    """The stop the rider says they're at ('Би Төв номын сангийн буудал дээр байна'), or None."""
    words = query_words(text)
    named, _ = find_destination(words) if words else ([], [])
    return named[0] if named else None


# Every spoken sentence is built from pieces that can all be pre-recorded (free hosting can't make
# speech live): fixed phrases, numbers in fixed phrases, and one clip per stop name.
SIDE_PIECES = {"урд": "Урд тал.", "хойд": "Хойд тал.", "зүүн": "Зүүн тал.", "баруун": "Баруун тал."}
MAX_RIDE_STOPS = 60
MSG_SAY_AGAIN = "Очих газрын нэрийг дахин хэлнэ үү."
MSG_NOT_FOUND = "Ийм нэртэй зогсоол олдсонгүй. Өөр нэрээр хэлнэ үү."
MSG_NO_STOP_NEAR = "Таны ойролцоо 800 метрт автобусны зогсоол алга."
MSG_CLOSE = "Та очих газартаа ойрхон байна. Алхаж очоорой."
MSG_NO_DIRECT = "Таны ойролцоох зогсоолоос тийшээ шууд автобус алга."
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
    return (["Суух зогсоол:", "Буух зогсоол:", "Дараагийн зогсоол:", "Очих газар тань тэндээс ойрхон.",
             MSG_SAY_AGAIN, MSG_NOT_FOUND, MSG_NO_STOP_NEAR, MSG_CLOSE, MSG_NO_DIRECT, MSG_NOT_A_STOP, walk_piece(0)]
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


def spoken_route(route_no):
    """'Ч:75' -> '75-р автобус', 'М:1А-Ма' -> '1 А автобус'.

    Riders know buses by number (+ А/Б); Hamuga's variant tags (Ма, НА, Z, _copy, -КОП) aren't on the sign.
    """
    m = re.match(r"\D*(\d+)\s*([АБаб])?", route_no.rsplit(":", 1)[-1])
    if not m:
        return f"{route_no.strip()} автобус"
    return f"{m.group(1)} {m.group(2).upper()} автобус" if m.group(2) else f"{m.group(1)}-р автобус"


def take_speech(route_no):
    """Same text for every rider of this route, so its clip is made once (make_speech.py)."""
    return f"{spoken_route(route_no)}анд суугаарай."


def found_speech(route_no):
    return f"{spoken_route(route_no)} ирлээ. Энэ таны автобус."


def route_phrases():
    """Every take/found sentence for every route, for pre-making TTS clips."""
    routes = {r for s in bus_api._stops() for r in s["routes"]}
    return sorted({f(r) for r in routes for f in (take_speech, found_speech)})


def suggest(text, lat, lon):
    words = query_words(text)
    if not words:
        raise PlanError(MSG_SAY_AGAIN)
    named, nearby = find_destination(words)
    if not named:
        raise PlanError(MSG_NOT_FOUND)
    origins = bus_api.nearest_stops(lat, lon, WALK_MAX_M, ORIGIN_LIMIT)
    if not origins:
        raise PlanError(MSG_NO_STOP_NEAR)
    if origins[0]["stop_id"] in {s["stop_id"] for s in named + nearby}:
        raise PlanError(MSG_CLOSE)

    dest_routes = {r for d in named + nearby for r in d["routes"]}
    bus_api.load_route_directions(rid for o in origins for r in set(o["routes"]) & dest_routes
                                  for rid in o["route_ids"][r])

    # Get off at the stop the rider named; a neighbouring stop only if no direct bus goes there.
    for dests, exact in ((named, True), (nearby, False)):
        ride = _best_ride(origins, dests)
        if ride:
            o, route, d, n = ride
            get_off = [ride_piece(n), "Буух зогсоол:"] + stop_pieces(d["name"])
            if not exact:
                get_off += ["Очих газар тань тэндээс ойрхон."]
            return {
                "route": route,
                "board_stop": {"stop_id": o["stop_id"], "name": o["name"], "distance_m": o["distance_m"],
                               "lat": o["lat"], "lon": o["lon"]},
                "destination": {"stop_id": named[0]["stop_id"], "name": named[0]["name"]},
                "alight_stop": {"stop_id": d["stop_id"], "name": d["name"]},
                "stops_to_ride": n,
                "routes_at_stop": o["routes"],
                # Pieces, all pre-recordable: "29 Б автобусанд суугаарай." "Суух зогсоол:" "Вокзал." "Хойд тал."
                # "Зогсоол руу 460 метр алхана." "6 зогсоол явна." "Буух зогсоол:" "Сүхбаатарын талбай." ...
                "speech": [take_speech(route), "Суух зогсоол:"] + stop_pieces(o["name"]) + [walk_piece(o["distance_m"])] + get_off,
                "found_speech": found_speech(route),
            }
    raise PlanError(MSG_NO_DIRECT)
