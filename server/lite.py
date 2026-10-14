"""Lightweight server for free hosts (Vercel Python functions): no GPU models.

Live Hamuga planning, location, ride stops and the pre-made Mongolian voice clips (served as static
MP3s next to the app). Speech recognition runs in the rider's browser instead (/health says
"stt": false) and sign reading isn't available ("ocr": false), so the camera answers "unsure".
Routes carry the /api prefix because Vercel passes the original path through.
"""
import hashlib
import json
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import RedirectResponse

import bus_api
import planner
import tts
import assistant
from contract import AskResponse, NearestStop, PlanRequest, PlanResponse, RideResponse, VerifyRequest, VerifyResponse, VoiceLocateResponse

HERE = Path(__file__).parent
bus_api.ROUTE_CACHE = HERE / "hamuga_cache"  # read-only on Vercel; new routes are fetched, not saved
CLIPS = set(json.loads((HERE / "tts_manifest.json").read_text())) if (HERE / "tts_manifest.json").exists() else set()

app = FastAPI(title="Bus Boarding Guide (lite)")
UNAVAILABLE = "Bus data unavailable"


@app.get("/api/health")
def health():
    return {"ok": True, "stt": False, "ocr": False}


@app.get("/api/stops/nearest", response_model=NearestStop)
def nearest(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180)):
    try:
        return bus_api.nearest_stop(lat, lon)
    except (httpx.HTTPError, RuntimeError):
        raise HTTPException(status_code=503, detail=UNAVAILABLE)


@app.post("/api/plan", response_model=PlanResponse)
def plan(req: PlanRequest):
    try:
        return planner.suggest(req.text, req.lat, req.lon)
    except planner.PlanError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except (httpx.HTTPError, RuntimeError):
        raise HTTPException(status_code=503, detail=UNAVAILABLE)


@app.get("/api/locate", response_model=VoiceLocateResponse)
def locate(text: str = Query(min_length=1, max_length=200)):
    try:
        stop = planner.locate(text)
    except (httpx.HTTPError, RuntimeError):
        raise HTTPException(status_code=503, detail=UNAVAILABLE)
    if not stop:
        return VoiceLocateResponse(heard=text, message=planner.MSG_NOT_A_STOP)
    return VoiceLocateResponse(heard=text, stop={k: stop[k] for k in ("stop_id", "name", "lat", "lon")})


@app.get("/api/ask", response_model=AskResponse)
def ask(text: str = Query(min_length=1, max_length=200), lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180)):
    """Voice assistant, text in (the browser recognises the speech here): answers from bus data only."""
    try:
        speech = assistant.answer(text, lat, lon)
    except (httpx.HTTPError, RuntimeError):
        raise HTTPException(status_code=503, detail=UNAVAILABLE)
    return AskResponse(heard=text, answer=" ".join(speech), speech=speech)


@app.get("/api/ride", response_model=RideResponse)
def ride(route: str = Query(min_length=1, max_length=16), board: str = Query(min_length=1, max_length=64),
         alight: str = Query(min_length=1, max_length=64)):
    try:
        stops = bus_api.ride_stops(route, board, alight)
    except (httpx.HTTPError, RuntimeError):
        raise HTTPException(status_code=503, detail=UNAVAILABLE)
    if not stops:
        raise HTTPException(status_code=404, detail="This route doesn't go from that stop to that stop")
    for s in stops:
        s["speech"] = planner.next_stop_speech(s["name"]) if s["name"] else []
    return {"route": route, "stops": stops}


@app.get("/api/tts")
def speak(text: str = Query(min_length=1, max_length=tts.MAX_CHARS)):
    """Redirect to the pre-made clip (a static, cached file); 404 = shown as text only."""
    try:
        spoken = tts.speakable(text)
    except ValueError:
        raise HTTPException(status_code=422, detail="Can't speak this text")
    key = hashlib.sha1(spoken.encode()).hexdigest()[:20]
    if key not in CLIPS:
        raise HTTPException(status_code=404, detail="No pre-made clip for this text")
    return RedirectResponse(f"/tts/{key}.mp3", status_code=302, headers={"Cache-Control": "public, max-age=86400"})


@app.post("/api/verify", response_model=VerifyResponse)
def verify(req: VerifyRequest):
    return VerifyResponse(verdict="unsure", confidence=0.0, eta_seconds=None)  # no OCR here: never a guess


@app.post("/api/plan/voice")
@app.post("/api/locate/voice")
def no_speech_recognition():
    raise HTTPException(status_code=503, detail="Speech recognition runs in the browser on this server")
