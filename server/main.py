import httpx
from fastapi import FastAPI, HTTPException, Query

import bus_api
from bus_api import get_eta_seconds
from contract import NearestStop, VerifyRequest, VerifyResponse

app = FastAPI(title="Bus Boarding Guide")


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/stops/nearest", response_model=NearestStop)
def nearest(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180)):
    try:
        return bus_api.nearest_stop(lat, lon)
    except (httpx.HTTPError, RuntimeError):
        raise HTTPException(status_code=503, detail="Bus data unavailable")


@app.post("/verify", response_model=VerifyResponse)
def verify(req: VerifyRequest):
    # Stub: OCR + fusion not built yet, so never claim "yes".
    return VerifyResponse(
        verdict="unsure",
        confidence=0.0,
        eta_seconds=get_eta_seconds(req.stop_id, req.wanted_route),
    )
