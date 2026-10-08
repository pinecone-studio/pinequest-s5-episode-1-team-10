import base64
import binascii
import os
from contextlib import asynccontextmanager

import cv2
import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

import bus_api
import fusion
import ocr
import planner
import stt
import tts
from bus_api import get_eta_seconds
from contract import NearestStop, PlanRequest, PlanResponse, VerifyRequest, VerifyResponse, VoicePlanResponse

@asynccontextmanager
async def lifespan(app):
    # Warm OCR (~5 s) and bus data (~1 s) at startup so the first /verify fits the 1 s budget.
    ocr.read_texts(cv2.imencode(".jpg", np.full((32, 32, 3), 255, np.uint8))[1].tobytes())
    warm = tts.fixed_phrases()
    try:
        bus_api._stops()
        warm += planner.route_phrases()
    except (httpx.HTTPError, RuntimeError):
        pass  # retried on first request; /verify degrades to "unsure" meanwhile
    if os.environ.get("STT_WARM", "1") == "1":
        stt.warm()  # ~10 s once, so the first spoken destination is answered in about a second
    if os.environ.get("TTS_WARM", "1") == "1":
        # Missing clips only (~16 s each), paused whenever a rider is waiting for a live clip.
        tts.prefetch_in_background(warm)
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


def _suggest(text, lat, lon):
    """planner.suggest + start making the speech clips the app will ask for next."""
    try:
        result = planner.suggest(text, lat, lon)
    except (httpx.HTTPError, RuntimeError):
        raise HTTPException(status_code=503, detail="Bus data unavailable")
    tts.prefetch_in_background(result["speech"][1:], live=True)  # made while the first part plays
    tts.prefetch_in_background([result["found_speech"]])  # needed only once the bus comes
    return result


@app.post("/plan", response_model=PlanResponse)
def plan(req: PlanRequest):
    try:
        return _suggest(req.text, req.lat, req.lon)
    except planner.PlanError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/plan/voice", response_model=VoicePlanResponse)
async def plan_voice(request: Request, lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180)):
    body = await request.body()
    if not body or len(body) > 2_000_000:
        raise HTTPException(status_code=422, detail="Send a WAV body under 2 MB")
    try:
        audio = await run_in_threadpool(stt.load_audio, body)
    except Exception:  # noqa: BLE001 - any decode failure is the client's audio
        raise HTTPException(status_code=422, detail="Audio is not a readable WAV")
    heard = await run_in_threadpool(stt.transcribe, audio)
    if not heard:
        return VoicePlanResponse(heard="", message="Сонсогдсонгүй. Дэлгэцийг дахин дараад хэлнэ үү.")
    try:
        result = await run_in_threadpool(_suggest, heard, lat, lon)
    except planner.PlanError as e:
        print(f"voice: heard {heard!r} -> {e}")
        return VoicePlanResponse(heard=heard, message=str(e))
    print(f"voice: heard {heard!r} -> {result['route']} from {result['board_stop']['name']!r} "
          f"to {result['alight_stop']['name']!r} ({result['stops_to_ride']} stops), asked {result['destination']['name']!r}")
    return VoicePlanResponse(heard=heard, plan=result)


@app.get("/tts")
def speak(text: str = Query(min_length=1, max_length=tts.MAX_CHARS)):
    try:
        path = tts.synthesize(text)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=f"Can't speak this text: {e}")
    return FileResponse(path, media_type="audio/wav", headers={"Cache-Control": "public, max-age=31536000"})


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
