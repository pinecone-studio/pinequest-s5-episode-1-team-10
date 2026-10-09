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


class PlanRequest(BaseModel):
    text: str = Field(min_length=1, max_length=200, description='What the rider said, e.g. "Сансар руу явна"')
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class PlanStop(BaseModel):
    stop_id: str
    name: str


class BoardStop(PlanStop):
    distance_m: int = Field(ge=0, description="Walk from the rider, straight line")
    lat: float
    lon: float


class PlanResponse(BaseModel):
    route: str = Field(description='Hamuga busRouteNo to take, e.g. "Ч:75"; send as wanted_route to /verify')
    board_stop: BoardStop = Field(description="Send its stop_id to /verify")
    destination: PlanStop = Field(description="The stop the rider named (as matched from what was heard)")
    alight_stop: PlanStop = Field(description="Where to get off: the named stop, or a neighbour within 500 m "
                                              "when no direct bus goes to the named one")
    stops_to_ride: int = Field(ge=1)
    routes_at_stop: list[str] = Field(description="Every busRouteNo serving board_stop")
    speech: list[str] = Field(description="Mongolian sentences to speak in order; fetch each from /tts")
    found_speech: str = Field(description='Mongolian "this is your bus" sentence for when /verify says yes')


class LocatedStop(BaseModel):
    stop_id: str
    name: str
    lat: float
    lon: float


class VoiceLocateResponse(BaseModel):
    heard: str = Field(description="What speech recognition heard ('' if nothing)")
    stop: Optional[LocatedStop] = Field(default=None, description="The stop the rider said they're at; use its lat/lon")
    message: Optional[str] = Field(default=None, description="Mongolian reason when stop is null; speak it")


class RideStop(BaseModel):
    stop_id: str
    name: str = Field(description="'' if Hamuga doesn't know the stop")
    lat: Optional[float] = Field(default=None, description="null if Hamuga has no coordinates; still counts as a stop")
    lon: Optional[float] = None
    speech: str = Field(description='"Дараагийн зогсоол: ..." to say as this stop comes up ("" if unnamed)')


class RideResponse(BaseModel):
    route: str
    stops: list[RideStop] = Field(description="Boarding stop first, alighting stop last, in riding order")


class VoicePlanResponse(BaseModel):
    heard: str = Field(description="What speech recognition heard ('' if nothing)")
    plan: Optional[PlanResponse] = Field(default=None, description="The bus to take; null if none")
    message: Optional[str] = Field(default=None, description="Mongolian reason when plan is null; speak it")
