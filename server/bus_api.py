"""Hamuga bus API client."""
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from functools import cache
from pathlib import Path
from math import asin, cos, radians, sin, sqrt

import httpx

BASE = "https://gateway.hamuga.mn/transport"
PER_PAGE = 5000
ROUTE_CACHE = Path(__file__).parent / "hamuga_cache"  # stop order per route; delete to refresh


def _get(path, params=None):
    r = httpx.get(BASE + path, params=params, headers={"x-api-key": os.environ["HAMUGA_API_KEY"]}, timeout=10)
    r.raise_for_status()
    body = r.json()
    if body.get("status") is not True:
        raise RuntimeError(f"Hamuga error {body.get('code')}: {body.get('msg')}")
    return body["data"]


@cache
def _stations():
    """Every station with coordinates: {busStopId: {"name", "lat", "lon"}}."""
    stations = _get("/api/bus/v1/bus_station_list", {"perPage": PER_PAGE, "page": 1})
    assert len(stations) < PER_PAGE, "station list may be truncated"
    return {s["busStopId"]: {"name": s.get("busStopName") or "", "lat": float(s["gpxY"]), "lon": float(s["gpxX"])}
            for s in stations if s.get("gpxY") and s.get("gpxX")}


# ponytail: cached for process lifetime, restart to refresh. Stations may be truncated if a full page comes back.
@cache
def _stops():
    """Stops that have coordinates and at least one route."""
    coords = {sid: (s["lat"], s["lon"]) for sid, s in _stations().items()}
    stops = []
    for g in _get("/api/bus/v1/group/info"):
        route_ids = {}  # one busRouteNo can have several busRouteIds (variants)
        for r in g["routeList"] or []:
            if r["busRouteNo"]:
                route_ids.setdefault(r["busRouteNo"], []).append(r["busRouteId"])
        if route_ids and g["busStopId"] in coords and not g["busStopName"].lower().startswith("test"):
            lat, lon = coords[g["busStopId"]]
            stops.append({"stop_id": g["busStopId"], "name": g["busStopName"], "lat": lat, "lon": lon,
                          "routes": sorted(route_ids), "route_ids": route_ids})
    return stops


def _distance_m(lat1, lon1, lat2, lon2):
    """Haversine distance in meters."""
    a = sin(radians(lat2 - lat1) / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * asin(sqrt(a))


def nearest_stops(lat, lon, max_m, limit):
    """Stops within max_m, closest first, each with its distance_m."""
    found = sorted(((_distance_m(lat, lon, s["lat"], s["lon"]), s) for s in _stops()), key=lambda t: t[0])
    return [{**s, "distance_m": round(d)} for d, s in found[:limit] if d <= max_m]


def nearest_stop(lat, lon):
    """Closest stop with its distance_m."""
    return nearest_stops(lat, lon, float("inf"), 1)[0]


def city_route_numbers():
    """Every route number in the city ('81', '3ма'), to tell a misread prefix from a real route."""
    from fusion import route_number

    return {route_number(r) for s in _stops() for r in s["routes"]}


def routes_at_stop(stop_id):
    """busRouteNo list for a stop, or None if the stop isn't known."""
    return next((s["routes"] for s in _stops() if s["stop_id"] == stop_id), None)


def base_name(name):
    """'Сансар ШТС /Урд/' -> 'сансар штс': no side markers or brackets, lowercase."""
    return " ".join(re.sub(r"/[^/]*/|\([^)]*\)", " ", name).lower().split())


NUMBER_SCORE = 6  # a matching number pins the stop down more than a matching word


def _stem_match(word, name_words):
    """Letters of word matched by a name word: the word itself, or minus up to 3 trailing letters
    (Mongolian suffixes: 'сансарт', 'сансарын' -> 'сансар'), never shorter than 4 letters.
    A number must match a name word's whole number ('1000' matches '1000-ын', not '1-р')."""
    if word.isdigit():
        return NUMBER_SCORE if any(re.match(r"\d+", nw) and re.match(r"\d+", nw).group() == word
                                   for nw in name_words) else 0
    if len(word) <= 3:  # "хүн" must not match "хүнс": short words match whole words only ("төв")
        return len(word) if word in name_words else 0
    for n in range(len(word), max(4, len(word) - 3) - 1, -1):
        if any(nw.startswith(word[:n]) for nw in name_words):
            return n
    return 0


def search_stops(words):
    """Stops whose name best matches the given lowercase words (most matched letters), shortest name first."""
    best, found = 0, []
    for s in _stops():
        name_words = base_name(s["name"]).split()
        score = sum(_stem_match(w, name_words) for w in words)
        if score and score >= best:
            if score > best:
                best, found = score, []
            found.append(s)
    return sorted(found, key=lambda s: len(s["name"]))


@cache
def route_directions(route_id):
    """busStopId lists in riding order, one per direction of this route variant.

    Kept on disk: stop order rarely changes, and each Hamuga call costs time and money.
    """
    path = ROUTE_CACHE / f"{route_id}.json"
    if path.exists():
        return json.loads(path.read_text())
    data = _get("/api/bus/v1/rot_stop_by_route", {"route_id": route_id})
    orders = [[s["busStopId"] for s in sorted(stops, key=lambda s: int(s["busStopSeq"]))]
              for key, stops in data.items() if key.endswith("StopList") and stops]
    ROUTE_CACHE.mkdir(exist_ok=True)
    path.write_text(json.dumps(orders))
    return orders


def load_route_directions(route_ids):
    """Fetch many routes' stop orders in parallel (one Hamuga call each, ~0.5 s) before using them."""
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(route_directions, set(route_ids)))


def stops_between(route_ids, from_id, to_id):
    """Fewest stops ridden from from_id to to_id on any variant/direction, or None if it doesn't go there."""
    best = None
    for rid in route_ids:
        for order in route_directions(rid):
            if from_id in order and to_id in order:
                n = order.index(to_id) - order.index(from_id)
                if n > 0 and (best is None or n < best):
                    best = n
    return best


def ride_stops(route_no, board_id, alight_id):
    """Stops from boarding to alighting, inclusive, in riding order, on the variant/direction with the
    fewest stops; [] if the route doesn't go there. A stop Hamuga has no coordinates for keeps its
    place (lat/lon None) so "stops left" stays right."""
    board = next((s for s in _stops() if s["stop_id"] == board_id), None)
    if not board or route_no not in board["route_ids"]:
        return []
    best = None
    for rid in board["route_ids"][route_no]:
        for order in route_directions(rid):
            if board_id in order and alight_id in order and order.index(board_id) < order.index(alight_id):
                seg = order[order.index(board_id): order.index(alight_id) + 1]
                if best is None or len(seg) < len(best):
                    best = seg
    stations = _stations()
    names = {s["stop_id"]: s["name"] for s in _stops()}  # the names used everywhere else
    return [{"stop_id": sid, "name": names.get(sid) or stations.get(sid, {}).get("name", ""),
             "lat": stations.get(sid, {}).get("lat"), "lon": stations.get(sid, {}).get("lon")} for sid in best or []]


def get_eta_seconds(stop_id, route):
    # No live positions yet (Hamuga /cluster returns 503); never fake an ETA.
    return None
