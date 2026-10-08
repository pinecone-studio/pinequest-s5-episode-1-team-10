"""Place name -> coordinates via OpenStreetMap Nominatim."""
from functools import lru_cache

import httpx

URL = "https://nominatim.openstreetmap.org/search"
UB_VIEWBOX = "106.6,48.05,107.25,47.75"  # Ulaanbaatar: lon_min, lat_max, lon_max, lat_min
USER_AGENT = "pinequest-team10-bus-guide/0.1 (+https://github.com/pinecone-studio/pinequest-s5-episode-1-team-10)"


# ponytail: public Nominatim allows ~1 req/s and no heavy use; move to a paid or self-hosted geocoder before real traffic.
@lru_cache(maxsize=1024)
def geocode(query):
    """Best match inside Ulaanbaatar as {name, lat, lon}, or None."""
    r = httpx.get(
        URL,
        params={"q": query, "format": "jsonv2", "limit": 1, "accept-language": "mn", "viewbox": UB_VIEWBOX, "bounded": 1},
        headers={"User-Agent": USER_AGENT},
        timeout=10,
    )
    r.raise_for_status()
    hits = r.json()
    if not hits:
        return None
    return {"name": hits[0]["name"] or query, "lat": float(hits[0]["lat"]), "lon": float(hits[0]["lon"])}
