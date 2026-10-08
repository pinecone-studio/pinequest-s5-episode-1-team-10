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
