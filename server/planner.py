"""Destination words + rider GPS -> one direct bus to take."""
import difflib
import re

import bus_api

PHRASE_MATCH_MIN = 0.75  # measured: near-misses score 0.88-0.92, misheard garbage <= 0.54
SAME_PLACE_M = 1000  # stops with the named stop's name this close are its other sides of the street
DEST_RADIUS_M = 500  # other stops this close are a fallback when no bus reaches the named stop
WALK_MAX_M = 800  # ponytail: farthest boarding stop we suggest to a blind rider
ORIGIN_LIMIT = 8
# Filler words riders say around a place name ("Сансар руу явмаар байна").
STOPWORDS = {"руу", "рүү", "луу", "лүү", "уруу", "явах", "явна", "явмаар", "очих", "очно", "очмоор", "хүрэх",
             "хүрмээр", "байна", "би", "минь", "вэ", "хүртэл", "зогсоол", "буудал", "автобус", "автобусаар"}


class PlanError(Exception):
    """No suggestion possible; the message is Mongolian and safe to speak to the rider."""


def query_words(text):
    words = re.findall(r"[^\W\d_]+", text.lower())
    return [w for w in words if w not in STOPWORDS and len(w) >= 3]


def _similarity(phrase, stop):
    return difflib.SequenceMatcher(None, phrase, bus_api.base_name(stop["name"])).ratio()


def _candidates(words):
    """Stops whose name matches the words. Speech recognition often gets a letter or two wrong, so
    after an exact-stem search this retries with each word swapped for the closest stop-name word
    ('сансаар' -> 'сансар'), then the whole phrase against whole names ('улсын их дэлгуур')."""
    found = bus_api.search_stops(words)
    if found:
        return found
    vocab = {w for s in bus_api._stops() for w in bus_api.base_name(s["name"]).split() if len(w) >= 3}
    fixed = [(difflib.get_close_matches(w, vocab, n=1, cutoff=0.75) or [w])[0] for w in words]
    found = bus_api.search_stops(fixed) if fixed != words else []
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
        raise PlanError("Очих газрын нэрийг дахин хэлнэ үү.")
    named, nearby = find_destination(words)
    if not named:
        raise PlanError(f"\"{text}\" нэртэй зогсоол олдсонгүй. Өөр нэрээр хэлнэ үү.")
    place = spoken_stop(named[0]["name"]).split(",")[0]  # side-less, e.g. "Улсын Их Дэлгүүр"
    origins = bus_api.nearest_stops(lat, lon, WALK_MAX_M, ORIGIN_LIMIT)
    if not origins:
        raise PlanError("Таны ойролцоо 800 метрт автобусны зогсоол алга.")
    if origins[0]["stop_id"] in {s["stop_id"] for s in named + nearby}:
        raise PlanError("Та очих газартаа ойрхон байна.")

    dest_routes = {r for d in named + nearby for r in d["routes"]}
    bus_api.load_route_directions(rid for o in origins for r in set(o["routes"]) & dest_routes
                                  for rid in o["route_ids"][r])

    # Get off at the stop the rider named; a neighbouring stop only if no direct bus goes there.
    for dests, exact in ((named, True), (nearby, False)):
        ride = _best_ride(origins, dests)
        if ride:
            o, route, d, n = ride
            get_off = f"{n} зогсоол яваад {spoken_stop(d['name'])} зогсоол дээр бууна."
            if not exact:
                get_off += f" {place} тэндээс ойрхон."
            return {
                "route": route,
                "board_stop": {"stop_id": o["stop_id"], "name": o["name"], "distance_m": o["distance_m"],
                               "lat": o["lat"], "lon": o["lon"]},
                "destination": {"stop_id": named[0]["stop_id"], "name": named[0]["name"]},
                "alight_stop": {"stop_id": d["stop_id"], "name": d["name"]},
                "stops_to_ride": n,
                "routes_at_stop": o["routes"],
                # One clip per part: the first is pre-made per route, the rest are made while it plays.
                "speech": [take_speech(route),
                           f"{spoken_stop(o['name'])} зогсоол руу {round(o['distance_m'], -1)} метр алхана.",
                           get_off],
                "found_speech": found_speech(route),
            }
    raise PlanError(f"{place} руу таны ойролцоох зогсоолоос шууд автобус алга.")
