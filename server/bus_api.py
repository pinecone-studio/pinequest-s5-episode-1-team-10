"""Hamuga bus API client."""
import os
from functools import cache
from math import asin, cos, radians, sin, sqrt

import httpx

BASE = "https://gateway.hamuga.mn/transport"
PER_PAGE = 5000


def _get(path, params=None):
    r = httpx.get(BASE + path, params=params, headers={"x-api-key": os.environ["HAMUGA_API_KEY"]}, timeout=10)
    r.raise_for_status()
    body = r.json()
    if body.get("status") is not True:
        raise RuntimeError(f"Hamuga error {body.get('code')}: {body.get('msg')}")
    return body["data"]


# ponytail: cached for process lifetime, restart to refresh. Stations may be truncated if a full page comes back.
@cache
def _stops():
    """Stops that have coordinates and at least one route."""
    stations = _get("/api/bus/v1/bus_station_list", {"perPage": PER_PAGE, "page": 1})
    assert len(stations) < PER_PAGE, "station list may be truncated"
    coords = {s["busStopId"]: (float(s["gpxY"]), float(s["gpxX"])) for s in stations if s.get("gpxY") and s.get("gpxX")}
    stops = []
    for g in _get("/api/bus/v1/group/info"):
        routes = sorted({r["busRouteNo"] for r in g["routeList"] or [] if r["busRouteNo"]})
        if routes and g["busStopId"] in coords:
            lat, lon = coords[g["busStopId"]]
            stops.append({"stop_id": g["busStopId"], "name": g["busStopName"], "lat": lat, "lon": lon, "routes": routes})
    return stops


def _distance_m(lat1, lon1, lat2, lon2):
    """Haversine distance in meters."""
    a = sin(radians(lat2 - lat1) / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * asin(sqrt(a))


def nearest_stop(lat, lon):
    """Closest stop with its distance_m."""
    d, stop = min(((_distance_m(lat, lon, s["lat"], s["lon"]), s) for s in _stops()), key=lambda t: t[0])
    return {**stop, "distance_m": round(d)}


def routes_at_stop(stop_id):
    """busRouteNo list for a stop, or None if the stop isn't known."""
    return next((s["routes"] for s in _stops() if s["stop_id"] == stop_id), None)


def get_eta_seconds(stop_id, route):
    # No live positions yet (Hamuga /cluster returns 503); never fake an ETA.
    return None
