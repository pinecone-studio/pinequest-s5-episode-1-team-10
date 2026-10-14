"""Voice assistant for bus questions: free, offline, instant, and never guessing.

No language model: the question's kind is read from Mongolian keywords, the place or bus number in it
from our own stop matcher, and the answer is built only from Hamuga data (bus_api, planner). Anything
it doesn't understand gets "Мэдэхгүй байна" plus an example, never a made-up answer.

Kinds: buses at this stop / where bus N goes / how to get to X (stops, transfers) / nearest stop /
when the bus comes (no live data yet: said honestly).
"""
import re

import bus_api
import numwords
import planner

UNKNOWN = ["Мэдэхгүй байна.", "Жишээ нь: энэ зогсоол дээр ямар автобус зогсдог вэ гэж асуугаарай."]
NO_ETA = ["Автобус хэзээ ирэхийг одоохондоо мэдэхгүй байна.", "Камер нээвэл автобус ирэхэд хэлнэ."]
NO_STOP = ["Таны ойролцоо 800 метрт автобусны зогсоол алга."]

# Question words: removed before looking for a place name in the question.
QUESTION_WORDS = {"хэдэн", "хэд", "вэ", "бэ", "яаж", "ямар", "аль", "хаагуур", "хаашаа", "хаана", "явдаг", "зогсдог",
                  "байдаг", "ирдэг", "очдог", "очих", "очно", "хүрэх", "хүрдэг", "хүртэл", "суух", "суувал", "явах", "явна",
                  "зогсоолоор", "зогсоолтой", "дугаар", "дугаарын", "дамжиж", "надад", "хэлээч", "хэлнэ", "үү", "уу",
                  "болох", "вэ?", "энд", "эндээс", "тэнд", "тийшээ", "ирэх", "ирнэ", "минут", "хэзээ", "хэр", "удах"}
ETA_WORDS = ("хэзээ", "минут", "хэр удах", "хэдийд", "одоо ирэх", "удахгүй")
NEAREST_WORDS = ("хамгийн ойр", "ойрын зогсоол", "ойрхон зогсоол", "ойролцоо зогсоол", "ойр зогсоол", "би хаана")
BUS_WORDS = ("автобус", "чиглэл", "маршрут")
ROUTE_INFO_WORDS = ("хаагуур", "хаашаа", "хаана хүртэл", "ямар зогсоол", "чиглэл", "маршрут", "хаанаас")

WALK_M = planner.WALK_MAX_M
# Speech recognition writes tens with a genitive-looking ending ("тавын тав" for "тавин тав" = 55),
# which the number reader would take as 5 + ending. In a bus question it's the tens word.
TENS_HEARD = {"хорын": "хорин", "гучын": "гучин", "дөчын": "дөчин", "тавын": "тавин", "жарын": "жаран",
              "далын": "далан", "наяын": "наян", "ерын": "ерэн"}
# "... руу / очих": a question about getting somewhere. If its place isn't recognised, a number in it
# is part of the place ("Дэнжийн 1000"), not a bus: say "not found" rather than answer about bus 1000.
PLACE_MARKERS = {"руу", "рүү", "луу", "лүү", "уруу", "очих", "очно", "очдог", "хүрэх", "хүрдэг", "явах"}


def _number_and_letter(route_no):
    """'Ч:29Б-Z' -> ('29', 'Б'); None if the route has no number."""
    m = re.match(r"\D*(\d+)\s*([АБаб])?", route_no.rsplit(":", 1)[-1])
    return (m.group(1), (m.group(2) or "").upper()) if m else None


def _sign(route_no):
    """What's on the bus: '29Б', '55'."""
    nl = _number_and_letter(route_no)
    return nl[0] + nl[1] if nl else route_no.strip()


def _bus_number(text):
    """The bus number asked about ('55', '29Б'), or None. Numbers said as words count too."""
    raw = re.findall(r"[^\W\d_]+|\d+", planner.cyrillic(text))
    words = numwords.to_digits([TENS_HEARD.get(w, w) for w in raw])
    for i, w in enumerate(words):
        if w.isdigit():
            nxt = words[i + 1] if i + 1 < len(words) else ""
            return w + (nxt.upper() if nxt in ("а", "б") else "")
    return None


def _place(text):
    """(named stops, nearby) for a place in the question, ignoring question words; ([], []) if none.
    A bare number is a bus, not a place."""
    words = [w for w in planner.query_words(text) if w not in QUESTION_WORDS]
    if not words or all(w.isdigit() or w in ("а", "б") for w in words):
        return [], []
    cleaned = " ".join(w for w in planner.cyrillic(text).split() if planner.fold(w) not in {planner.fold(q) for q in QUESTION_WORDS})
    return planner.find_destination(words, cleaned)


def _routes_here(lat, lon):
    origins = bus_api.nearest_stops(lat, lon, WALK_M, 1)
    if not origins:
        return NO_STOP
    st = origins[0]
    signs = sorted({_sign(r) for r in st["routes"]}, key=lambda s: (int(re.match(r"\d+", s).group()) if re.match(r"\d+", s) else 999, s))
    return [f"{planner.stop_name(st['name'])} зогсоол дээр {len(signs)} автобус зогсдог: {', '.join(signs)}."]


def _route_info(number, lat, lon):
    """Where bus `number` goes: its two ends, and from the nearest stop it serves, how many stops to the end."""
    wanted = number.upper()
    routes = {r for s in bus_api._stops() for r in s["routes"] if _sign(r).upper() == wanted}
    if not routes:
        return [f"{wanted} дугаартай автобус олдсонгүй."]
    near = [s for s in bus_api.nearest_stops(lat, lon, WALK_M, 20) if set(s["routes"]) & routes]
    by_id = {s["stop_id"]: s for s in bus_api._stops()}
    names = {sid: s["name"] for sid, s in by_id.items()}

    def ends(order):
        return planner.stop_name(names.get(order[0], "")), planner.stop_name(names.get(order[-1], ""))

    if near:
        st = near[0]
        route = sorted(set(st["routes"]) & routes)[0]
        bus_api.load_route_directions(st["route_ids"][route])
        for rid in st["route_ids"][route]:
            for order in bus_api.route_directions(rid):
                if st["stop_id"] in order and order[-1] != st["stop_id"]:
                    a, b = ends(order)
                    left = len(order) - 1 - order.index(st["stop_id"])
                    return [f"{planner.spoken_route(route)} {a} - {b} хооронд явдаг.",
                            f"{planner.stop_name(st['name'])} зогсоолоос {b} хүртэл {left} зогсоол."]
    # Not near the rider: just its ends.
    route = sorted(routes)[0]
    rid = next(rid for s in bus_api._stops() if route in s["route_ids"] for rid in s["route_ids"][route])
    bus_api.load_route_directions([rid])
    orders = bus_api.route_directions(rid)
    if not orders:
        return [f"{wanted} автобусны чиглэл олдсонгүй."]
    a, b = ends(orders[0])
    return [f"{planner.spoken_route(route)} {a} - {b} хооронд явдаг.", "Таны ойролцоо энэ автобус зогсдоггүй."]


def _nearest(lat, lon):
    origins = bus_api.nearest_stops(lat, lon, WALK_M, 1)
    if not origins:
        return NO_STOP
    st = origins[0]
    return ["Хамгийн ойрын зогсоол:"] + planner.stop_pieces(st["name"]) + [planner.walk_piece(st["distance_m"])]


def answer(text, lat, lon):
    """Mongolian sentences answering the question, from our data only."""
    t = " " + planner.cyrillic(text).lower() + " "
    if any(w in t for w in ETA_WORDS):
        return NO_ETA
    if any(w in t for w in NEAREST_WORDS) or ("хамгийн" in t and ("зогс" in t or "буудал" in t)):
        return _nearest(lat, lon)  # also when misheard: "хамгийн хоёрын зогсвол"
    number = _bus_number(text)
    named, _ = _place(text)
    # "Сансар руу ..." / "Дэнжийн 1000 руу хэдэн зогсоол": a place (its number is part of its name).
    if named and not (number and any(w in t for w in ROUTE_INFO_WORDS) and not any(number in s["name"] for s in named)):
        place = planner.stop_name(named[0]["name"])
        try:
            return planner.suggest(place, lat, lon)["speech"]
        except planner.PlanError as e:
            return [str(e)]
    if not named and set(t.split()) & PLACE_MARKERS:
        return [planner.MSG_NOT_FOUND]
    if number:
        return _route_info(number, lat, lon)
    words = set(t.split())
    if "энэ зогсоол" in t or "энэ буудал" in t or words & {"энд", "эндээс"} or any(w in t for w in BUS_WORDS):
        return _routes_here(lat, lon)
    return UNKNOWN
