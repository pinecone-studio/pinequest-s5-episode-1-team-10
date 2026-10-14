"""Voice assistant: the rider's one voice interface. Free, offline, instant, never guessing.

No language model: what the rider wants is read from Mongolian keywords (tolerant of how speech
recognition spells them), the place or bus number from our own stop matcher, and every answer is
built only from Hamuga data (bus_api, planner) and the trip in progress (context from the app).
Anything it doesn't understand gets "Мэдэхгүй байна" plus examples, never a made-up answer.

Two kinds of reply:
- an answer to speak (buses here / at a stop, where bus N goes, does bus N go to X, which buses go
  to X, how far X is, from X to Y, nearest stop, where am I, arrival time (honest: unknown), help);
- an action for the app to do, with what to say: "plan" (a trip, so the camera is one tap away),
  "open_camera", "walk", "door", "stops_left", "boarded", "got_off", "repeat_route", "start_over",
  "tutorial".
"""
import re

import bus_api
import numwords
import planner

WALK_M = planner.WALK_MAX_M
UNKNOWN = ["Мэдэхгүй байна.",
           "Жишээ нь: Сансар руу яаж очих вэ, 55 хаагуур явдаг вэ, энд ямар автобус зогсдог вэ гэж асуугаарай."]
HELP = ["Би автобусны талаар хариулна.",
        "Очих газраа хэлбэл ямар автобусанд суухыг хэлнэ.",
        "Автобусны дугаар хэлбэл хаагуур явдгийг хэлнэ.",
        "Камер нээ, хаалга хаана байна, хэдэн зогсоол үлдсэн гэж хэлж болно."]
NO_ETA = ["Автобус хэзээ ирэхийг одоохондоо мэдэхгүй байна.", "Камер нээвэл автобус ирэхэд хэлнэ."]
NO_STOP = ["Таны ойролцоо 800 метрт автобусны зогсоол алга."]
NEED_PLAN = ["Эхлээд очих газраа хэлнэ үү."]
THANKS = ["Зүгээр ээ. Аюулгүй аялаарай."]
EMERGENCY_FIRST = "Ойролцоох хүнээс тусламж хүсээрэй."

# Speech recognition writes tens with a genitive-looking ending ("тавын тав" for 55).
TENS_HEARD = {"хорын": "хорин", "гучын": "гучин", "дөчын": "дөчин", "тавын": "тавин", "жарын": "жаран",
              "далын": "далан", "наяын": "наян", "ерын": "ерэн"}
# Words about the question itself, removed before looking for a place name.
QUESTION_WORDS = {"хэдэн", "хэд", "вэ", "бэ", "уу", "үү", "яаж", "ямар", "аль", "хаагуур", "хаашаа", "хаана", "явдаг",
                  "зогсдог", "байдаг", "ирдэг", "очдог", "очих", "очно", "хүрэх", "хүрдэг", "хүртэл", "суух", "суувал",
                  "явах", "явна", "зогсоолоор", "зогсоолтой", "дугаар", "дугаарын", "дамжиж", "надад", "хэлээч", "хэлнэ",
                  "болох", "энд", "эндээс", "тэнд", "тийшээ", "ирэх", "ирнэ", "минут", "хэзээ", "хэр", "удах", "хол",
                  "ойрхон", "шууд", "автобусууд", "дээр", "зогсдоггүй", "явдаггүй", "уруу", "луу", "лүү", "рүү", "руу",
                  "метр", "км", "километр", "зай", "зайтай", "очихын", "тулд", "хүргээч", "хүргэж", "өгөөч", "билээ",
                  "явмаар", "очмоор", "байна", "гэсэн", "юм", "намайг", "надад", "миний", "чи", "та", "вэ?", "нь", "юу", "ямар ямар", "өнгөрдөг", "хүрнэ", "очно", "суух"}
PLACE_MARKERS = {"руу", "рүү", "луу", "лүү", "уруу", "очих", "очно", "очдог", "хүрэх", "хүрдэг", "явах"}
ROUTE_INFO_WORDS = ("хаагуур", "хаашаа", "хаана хүртэл", "ямар зогсоол", "чиглэл", "маршрут", "хаанаас", "эцэс")


def _f(part):
    """A keyword folded like the text (ү/у, ө/о, й/и...), keeping its edge spaces (" суулаа" = word start)."""
    return (" " if part.startswith(" ") else "") + planner.fold(part) + (" " if part.endswith(" ") else "")


def _has(t, *parts):
    """t is folded text with spaces around it; parts match whatever the spelling of ү/у, ө/о, й/и."""
    return any(_f(p) in t for p in parts)


def _number_and_letter(route_no):
    m = re.match(r"\D*(\d+)\s*([АБаб])?", route_no.rsplit(":", 1)[-1])
    return (m.group(1), (m.group(2) or "").upper()) if m else None


def _sign(route_no):
    """What's on the bus: '29Б', '55'."""
    nl = _number_and_letter(route_no)
    return nl[0] + nl[1] if nl else route_no.strip()


def _sign_key(sign):
    m = re.match(r"\d+", sign)
    return (int(m.group()) if m else 999, sign)


def _bus_number(text):
    """The bus number asked about ('55', '29Б'), or None. Numbers said as words count too."""
    raw = re.findall(r"[^\W\d_]+|\d+", planner.cyrillic(text))
    words = numwords.to_digits([TENS_HEARD.get(w, w) for w in raw])
    for i, w in enumerate(words):
        if w.isdigit():
            nxt = words[i + 1] if i + 1 < len(words) else ""
            return w + (nxt.upper() if nxt in ("а", "б") else "")
    return None


def _strip(text):
    return " ".join(w for w in planner.cyrillic(text).split()
                    if planner.fold(w.strip("?.,!")) not in {planner.fold(q) for q in QUESTION_WORDS})


_GENERIC = ("автобус", "зогсоол", "буудал", "маршрут", "чиглэл")


def _place(text):
    """(named stops, nearby) for a place in the text; ([], []) if none. A bare number is a bus, not a place,
    and forms of автобус/зогсоол/буудал ("автобуснууд") never are."""
    # Every other word stays: the stop matcher needs them to reject a sentence that isn't a place.
    words = [w for w in planner.query_words(text) if w not in QUESTION_WORDS and not w.startswith(_GENERIC)]
    if not words or all(w.isdigit() or w in ("а", "б") for w in words):
        return [], []
    return planner.find_destination(words, _strip(text))


def _routes_of_sign(sign):
    wanted = sign.upper()
    return {r for s in bus_api._stops() for r in s["routes"] if _sign(r).upper() == wanted}


def _names():
    return {s["stop_id"]: s["name"] for s in bus_api._stops()}


def _nearest_stop(lat, lon):
    found = bus_api.nearest_stops(lat, lon, WALK_M, 1)
    return found[0] if found else None


def _say_meters(m):
    return f"{round(m, -1):.0f} метр" if m < 1000 else f"{m / 1000:.1f} километр".replace(".", ",")


# --- answers -------------------------------------------------------------------------------------

def _buses_at(stop, here):
    signs = sorted({_sign(r) for r in stop["routes"]}, key=_sign_key)
    where = "Энэ зогсоол" if here else planner.stop_name(stop["name"]) + " зогсоол"
    return [f"{where} дээр {len(signs)} автобус зогсдог:", ", ".join(signs) + "."]


def _route_info(sign, lat, lon):
    """Where bus `sign` goes: its two ends, and from the nearest stop it serves, how many stops to the end."""
    routes = _routes_of_sign(sign)
    if not routes:
        return [f"{sign.upper()} дугаартай автобус олдсонгүй."]
    names = _names()
    near = [s for s in bus_api.nearest_stops(lat, lon, WALK_M, 20) if set(s["routes"]) & routes]
    if near:
        st = near[0]
        route = sorted(set(st["routes"]) & routes)[0]
        bus_api.load_route_directions(st["route_ids"][route])
        for rid in st["route_ids"][route]:
            for order in bus_api.route_directions(rid):
                if st["stop_id"] in order and order[-1] != st["stop_id"]:
                    a, b = planner.stop_name(names.get(order[0], "")), planner.stop_name(names.get(order[-1], ""))
                    left = len(order) - 1 - order.index(st["stop_id"])
                    return [f"{planner.spoken_route(route)} {a} - {b} хооронд явдаг.",
                            f"{planner.stop_name(st['name'])} зогсоолоос {b} хүртэл {left} зогсоол."]
    route = sorted(routes)[0]
    rids = [rid for s in bus_api._stops() if route in s["route_ids"] for rid in s["route_ids"][route]]
    bus_api.load_route_directions(rids[:1])
    orders = bus_api.route_directions(rids[0]) if rids else []
    if not orders:
        return [f"{sign.upper()} автобусны чиглэл олдсонгүй."]
    a, b = planner.stop_name(names.get(orders[0][0], "")), planner.stop_name(names.get(orders[0][-1], ""))
    return [f"{planner.spoken_route(route)} {a} - {b} хооронд явдаг.", "Таны ойролцоо энэ автобус зогсдоггүй."]


def _direct_options(named, lat, lon):
    """[(stops, sign, origin)]: every direct bus from the rider's nearby stops to the place, best first."""
    origins = bus_api.nearest_stops(lat, lon, WALK_M, planner.ORIGIN_LIMIT)
    bus_api.load_route_directions(rid for st in origins + named for rids in st["route_ids"].values() for rid in rids)
    best = {}
    for o in origins:
        for d in named:
            for route in set(o["routes"]) & set(d["routes"]):
                n = bus_api.stops_between(o["route_ids"][route], o["stop_id"], d["stop_id"])
                if n is not None:
                    sign = _sign(route)
                    cost = n + o["distance_m"] / planner.WALK_COST_M
                    if sign not in best or cost < best[sign][0]:
                        best[sign] = (cost, n, o)
    ranked = sorted(best.items(), key=lambda item: item[1][0])
    return [(n, sign, o) for sign, (_, n, o) in ranked]


def _buses_to(named, place, lat, lon):
    options = _direct_options(named, lat, lon)
    if not options:
        return [f"Таны ойролцоох зогсоолоос {place} руу шууд автобус алга."]
    listed = ", ".join(f"{sign} {n} зогсоол" for n, sign, _ in options[:4])
    return [f"{place} руу шууд явдаг автобус:", listed + "."]


def _bus_goes_to(sign, named, place, lat, lon):
    for n, s, o in _direct_options(named, lat, lon):
        if s.upper() == sign.upper():
            return [f"Тийм. {sign.upper()} автобус {place} руу явдаг.",
                    f"{planner.stop_name(o['name'])} зогсоолоос {n} зогсоол."]
    return [f"Үгүй. {sign.upper()} автобус таны ойролцооноос {place} руу явдаггүй."]


def _how_far(named, place, lat, lon):
    m = min(bus_api._distance_m(lat, lon, s["lat"], s["lon"]) for s in named)
    return [f"{place} эндээс шулуунаар {_say_meters(m)}."]


def _nearest(lat, lon):
    st = _nearest_stop(lat, lon)
    if not st:
        return NO_STOP
    return ["Хамгийн ойрын зогсоол:"] + planner.stop_pieces(st["name"]) + [planner.walk_piece(st["distance_m"])]


def _emergency(lat, lon):
    st = _nearest_stop(lat, lon)
    where = [f"Та {planner.stop_name(st['name'])} зогсоолоос {_say_meters(st['distance_m'])} зайд байна."] if st else []
    return [EMERGENCY_FIRST] + where


def _waiting_for(context):
    route = context.get("route")
    if not route:
        return NEED_PLAN
    out = [f"Та {planner.spoken_route(route)} хүлээж байна."]
    if context.get("alight"):
        out.append(f"Буух зогсоол: {planner.stop_name(context['alight'])}.")
    return out


def _two_places(text):
    """('Сансар', 'Зайсан') for "Сансараас Зайсан руу ..."; None if the question isn't from X to Y."""
    m = re.search(r"(\S+(?:\s+\S+){0,3}?)(аас|ээс|оос|өөс|гаас|гээс)\s+(.+?)\s+(руу|рүү|луу|лүү|уруу|хүртэл)",
                  planner.cyrillic(text).lower())
    return (m.group(1), m.group(3)) if m else None


# --- the one entry point -------------------------------------------------------------------------

def reply(text, lat, lon, context=None):
    """{"speech": [...], "action": str|None, "plan": PlanResponse dict|None} for what the rider said.
    context: the trip in progress from the app: {"step", "route", "alight"} (all optional)."""
    context = context or {}
    t = " " + planner.fold(planner.cyrillic(text)) + " "
    words = set(t.split())
    has_plan = bool(context.get("route"))

    def say(speech, action=None, plan=None):
        return {"speech": speech, "action": action, "plan": plan}

    if not words:
        return say(UNKNOWN)
    # Emergencies and commands first: short, and the app acts on them.
    if _has(t, "тусламж хэр", "төөр", "төвөр", "замаа алд", "аюул", "яаралтай"):  # "төвөрчихлөө": as heard
        return say(_emergency(lat, lon))
    if _has(t, "баярлалаа", "баярлаа"):
        return say(THANKS)
    if _has(t, "заавар"):
        return say(["Заавар эхэллээ."], "tutorial")
    if _has(t, "шинээр", "эхнээс", "өөр газар", "болих", "цуцал", "дахиад эхл", "дахин эхл", "эхлүүл"):
        return say(["Шинээр эхэллээ."], "start_over")
    if _has(t, "камер"):
        return say([], "open_camera") if has_plan else say(NEED_PLAN)
    if _has(t, "хаалг"):  # хаалга, хаалгыг, хаалганы
        return say([], "door") if has_plan else say(NEED_PLAN)
    if _has(t, " суулаа", "суучихлаа", " суусан", "автобусанд орлоо", "автобусанд орсон"):
        return say([], "boarded") if has_plan else say(NEED_PLAN)
    if _has(t, "буулаа", "буучихлаа", " буусан", "бууж байна"):
        return say([], "got_off") if has_plan else say(NEED_PLAN)
    if _has(t, "үлдсэн", "үлдлээ", "үлдэв", "үлдэж", "дараагийн зогсоол", "дараагийн буудал", "дараа буух", "хэзээ буух"):
        return say([], "stops_left") if has_plan else say(NEED_PLAN)
    if _has(t, "хөтл", "хөтөл", "замчил", "дагуул") and _has(t, "зогсоол", "буудал"):
        return say([], "walk") if has_plan else say(NEED_PLAN)
    if _has(t, "миний автобус", "миний суух", "аль автобус хүлээ", "ямар автобус хүлээ", "миний зам", "замаа давт",
            "дахин хэл", "билээ"):
        return say(_waiting_for(context), "repeat_route" if has_plan else None)
    if _has(t, "хийж чад", "юу чад", "чадах вэ", "яаж ашигла", " тусламж ", "командууд", "апп юу", "юу хийдэг",
            "юу хийх вэ"):
        return say(HELP)
    if _has(t, "хэзээ", "минут", "хэр удах", "удах уу", "удаж байна", "хэдийд", "удахгүй ирэх", "одоо ирэх"):
        return say(NO_ETA)
    if _has(t, "би хаана", "миний байршил", "хаана байгаа вэ", "би одоо хаана"):
        return say(_nearest(lat, lon))
    if _has(t, "хамгийн ойр", "ойрын зогсоол", "ойрхон зогсоол", "ойролцоо зогсоол", "ойрхон буудал", "ойрын буудал",
            "дөхөм") or ("хамгийн" in words and _has(t, "зогс", "буудал")):
        return say(_nearest(lat, lon))  # also when misheard: "хамгийн хоёрын зогсвол"

    # From X to Y: the trip from X's stop.
    pair = _two_places(text)
    if pair:
        a, _ = _place(pair[0])
        b, _ = _place(pair[1])
        if a and b:
            try:
                return say(planner.suggest(planner.stop_name(b[0]["name"]), a[0]["lat"], a[0]["lon"])["speech"])
            except planner.PlanError as e:
                return say([str(e)])
        if a and not b:
            return say([planner.MSG_NOT_FOUND])  # "...-аас айсан руу": never plan to the start instead

    number = _bus_number(text)
    named, _ = _place(text)
    if not named and number:
        # "75 Сансар руу явдаг уу": the bus number isn't part of the place; look again without it.
        without = re.sub(r"\b" + re.escape(number) + r"\b|\b" + re.escape(number.rstrip("АБ")) + r"\b", " ", planner.cyrillic(text), flags=re.I)
        named, _ = _place(without)
    number_is_place = bool(named and number and any(number in s["name"] for s in named))
    bus_number = number if number and not number_is_place else None
    if named:
        place = planner.stop_name(named[0]["name"])
        if bus_number and _has(t, "руу", "рүү", "явдаг уу", "очдог уу", "хүрдэг уу", "зогсдог уу", "явах уу", "очих уу", "хүрэх уу"):
            return say(_bus_goes_to(bus_number, named, place, lat, lon))
        if bus_number and _has(t, *ROUTE_INFO_WORDS):
            return say(_route_info(bus_number, lat, lon))
        if _has(t, "хэр хол", "хол уу", "хол байдаг", "хэдэн метр", "хэдэн км", "хэдэн километр") or words & {"зай", "зайтай"}:
            return say(_how_far(named, place, lat, lon))
        if _has(t, "дээр ямар", "дээр хэдэн", "автобус зогсдог") and not _has(t, " руу", " рүү"):
            return say(_buses_at(named[0], here=False))
        if _has(t, "ямар автобус", "аль автобус", "хэдэн автобус", "шууд") and _has(t, "руу", "рүү", "явдаг", "очдог"):
            options = _buses_to(named, place, lat, lon)
            try:
                plan = planner.suggest(place, lat, lon)
            except planner.PlanError:
                return say(options)
            if plan["transfer"] or not _direct_options(named, lat, lon):
                return say(plan["speech"], "plan", plan)  # no direct bus: the whole transfer trip
            # Every direct bus, then the best one (the full trip is on the plan screen / "repeat route").
            return say(options + ["Хамгийн тохиромжтой нь:", plan["speech"][0]], "plan", plan)
        # "Сансар руу яаж очих вэ" / "Сансар руу хэдэн зогсоол" / just a place: the trip itself.
        try:
            plan = planner.suggest(place, lat, lon)
            return say(plan["speech"], "plan", plan)
        except planner.PlanError as e:
            return say([str(e)])
    if _has(t, "буудал хаана", "зогсоол хаана") and not bus_number:
        return say(_nearest(lat, lon))  # "Автобусны буудал хаана байна": no place named = the nearest one
    if words & PLACE_MARKERS or _has(t, "хүргээч", "хүргэж өг", "очихын тулд"):
        return say([planner.MSG_NOT_FOUND])  # a place we didn't recognise: never answer about a number in it
    if bus_number:
        return say(_route_info(bus_number, lat, lon))
    if _has(t, "туслаач", "туслаарай", "тусална уу"):
        return say(_emergency(lat, lon))  # "help me" with nothing else asked
    if _has(t, "энэ зогсоол", "энэ буудал", "автобус", "чиглэл", "маршрут") or words & {"энд", "эндээс"}:
        st = _nearest_stop(lat, lon)
        return say(_buses_at(st, here=st["distance_m"] < planner.AT_STOP_M) if st else NO_STOP)
    return say(UNKNOWN)


def answer(text, lat, lon, context=None):
    """Just the sentences (tests, eval)."""
    return reply(text, lat, lon, context)["speech"]


def fixed_phrases():
    """Sentences that never change, for pre-making voice clips at startup."""
    return UNKNOWN + HELP + NO_ETA + NEED_PLAN + THANKS + [EMERGENCY_FIRST, "Заавар эхэллээ.", "Шинээр эхэллээ.",
                                                           "Хамгийн тохиромжтой нь:"]
