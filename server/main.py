import base64
import binascii
from contextlib import asynccontextmanager

import cv2
import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, Query

import bus_api
import fusion
import geocode
import ocr
from bus_api import get_eta_seconds
from contract import NearestStop, RouteSuggestions, VerifyRequest, VerifyResponse

@asynccontextmanager
async def lifespan(app):
    # Warm OCR (~5 s) and bus data (~1 s) at startup so the first /verify fits the 1 s budget.
    ocr.read_texts(cv2.imencode(".jpg", np.full((32, 32, 3), 255, np.uint8))[1].tobytes())
    try:
        bus_api._stops()
    except (httpx.HTTPError, RuntimeError):
        pass  # retried on first request; /verify degrades to "unsure" meanwhile
    yield


app = FastAPI(title="Bus Boarding Guide", lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/stops/nearest", response_model=NearestStop)
def nearest(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180)):
    try:
        return bus_api.nearest_stop(lat, lon)
    except (httpx.HTTPError, RuntimeError):
        raise HTTPException(status_code=503, detail="Bus data unavailable")


@app.get("/routes/suggest", response_model=RouteSuggestions)
def suggest(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    to: str = Query(min_length=1, max_length=100, description="Destination place name, e.g. Улсын их дэлгүүр"),
):
    try:
        dest = geocode.geocode(to.strip())
    except (httpx.HTTPError, ValueError):
        raise HTTPException(status_code=503, detail="Place search unavailable")
    if dest is None:
        raise HTTPException(status_code=404, detail="Destination not found")
    try:
        trips = bus_api.plan_trip(lat, lon, dest["lat"], dest["lon"])
    except (httpx.HTTPError, ValueError, KeyError):
        raise HTTPException(status_code=503, detail="Bus data unavailable")
    return {"destination": dest, "suggestions": trips}


@app.post("/verify", response_model=VerifyResponse)
def verify(req: VerifyRequest):
    try:
        jpeg = base64.b64decode(req.sign_crop, validate=True)
    except binascii.Error:
        raise HTTPException(status_code=422, detail="sign_crop is not valid base64")
    try:
        texts = ocr.read_texts(jpeg)
    except Exception:  # never a 500 on the phone; unsure is always safe
        return VerifyResponse(verdict="unsure", confidence=0.0, eta_seconds=None)
    try:
        routes_here = bus_api.routes_at_stop(req.stop_id)
    except (httpx.HTTPError, RuntimeError):
        routes_here = None  # without bus data, fusion can never say "yes"
    verdict, confidence = fusion.decide(texts, req.wanted_route, routes_here)
    return VerifyResponse(
        verdict=verdict,
        confidence=confidence,
        eta_seconds=get_eta_seconds(req.stop_id, req.wanted_route),
    )
