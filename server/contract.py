"""Data contract between the phone app and the server. Mirror: shared/contract.ts."""
from typing import Literal, Optional

from pydantic import BaseModel, Field

Verdict = Literal["yes", "no", "unsure"]


class VerifyRequest(BaseModel):
    sign_crop: str = Field(min_length=1, max_length=2_000_000, description="Base64 JPEG of the route-sign crop")
    stop_id: str = Field(min_length=1, max_length=64, description='Hamuga busStopId, e.g. "000000529"')
    wanted_route: str = Field(min_length=1, max_length=16, description='Hamuga busRouteNo the rider chose, e.g. "Ч:81"')


class VerifyResponse(BaseModel):
    verdict: Verdict
    confidence: float = Field(ge=0, le=1)
    eta_seconds: Optional[int] = Field(default=None, description="Wanted bus ETA at this stop; null if unknown")


class NearestStop(BaseModel):
    stop_id: str = Field(description='Hamuga busStopId, e.g. "000000529"')
    name: str
    distance_m: int = Field(ge=0, description="Meters from the given point")
    routes: list[str] = Field(description='Hamuga busRouteNo values serving this stop, e.g. "Ч:81"')


class Place(BaseModel):
    name: str
    lat: float
    lon: float


class RouteSuggestion(BaseModel):
    route: str = Field(description='Hamuga busRouteNo, e.g. "Ч:34"')
    board_stop_id: str = Field(description='Hamuga busStopId to get on at, e.g. "000000283"')
    board_stop_name: str
    alight_stop_id: str = Field(description="Hamuga busStopId to get off at")
    alight_stop_name: str
    walk_m: int = Field(ge=0, description="Total walking in meters")
    duration_s: int = Field(ge=0, description="Whole trip in seconds, walking and waiting included")


class RouteSuggestions(BaseModel):
    destination: Place
    suggestions: list[RouteSuggestion] = Field(description="One-bus trips, fastest first, max 3; empty = no direct bus")
