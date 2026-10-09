"""Pre-pitch check: is every part of the live demo working? Run with both servers up:

  cd server && set -a && . ../.env && set +a && .venv/bin/python pitch_check.py

Checks through the app's proxy (http://localhost:3000/api), so it also proves the app is up.
"""
import base64
import io
import sys
import time
from pathlib import Path

import httpx

import planner
import tts

APP = "http://localhost:3000"
API = APP + "/api"
STOP = "000000282"  # Төв номын сан /Зүүн/
AT_STOP = (47.914633, 106.915628)
PHOTO_CROP = Path(__file__).parent.parent / "app" / "public" / "test" / "tov_nomyn_san_1.png"

results = []


def check(name, fn):
    t = time.time()
    try:
        detail = fn()
        results.append((True, name, detail, time.time() - t))
    except Exception as e:  # noqa: BLE001 - report every failure, keep checking the rest
        results.append((False, name, f"{type(e).__name__}: {e}", time.time() - t))


def app_page():
    r = httpx.get(APP, timeout=20)
    r.raise_for_status()
    return "app answers"


def server_health():
    assert httpx.get(API + "/health", timeout=10).json() == {"ok": True}
    return "server answers through the app proxy"


def yolo_model():
    r = httpx.head(APP + "/models/yolo11n.onnx", timeout=10)
    r.raise_for_status()
    r = httpx.head(APP + "/ort/ort.webgpu.min.mjs", timeout=10)
    r.raise_for_status()
    return "YOLO model and onnxruntime files served"


def plan_demo():
    p = httpx.post(API + "/plan", json={"text": "Дэнжийн 1000", "lat": AT_STOP[0], "lon": AT_STOP[1]}, timeout=60).json()
    assert p.get("route") == "Ч:55", p
    return f"{p['route']} {p['board_stop']['name']} -> {p['alight_stop']['name']} ({p['stops_to_ride']} stops)"


def locate_text():
    s = httpx.get(API + "/locate", params={"text": "Төв номын сан дээр байна"}, timeout=30).json()["stop"]
    assert s and s["stop_id"] == STOP, s
    return s["name"]


def verify_photo():
    import cv2

    img = cv2.imread(str(PHOTO_CROP))
    assert img is not None, f"missing {PHOTO_CROP}"
    crop = img[582:582 + 239, 146:146 + 1587]  # top 45% of the bus box YOLO finds in this photo
    jpeg = base64.b64encode(cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()).decode()
    r = httpx.post(API + "/verify", json={"sign_crop": jpeg, "stop_id": STOP, "wanted_route": "Ч:55"}, timeout=30).json()
    assert r["verdict"] == "yes", r
    return f"photo 1 sign -> yes ({r['confidence']:.2f})"


def voice_clips():
    texts = tts.fixed_phrases() + [planner.take_speech("Ч:55"), planner.found_speech("Ч:55")]
    missing = [t for t in texts if not tts.is_cached(t)]
    assert not missing, f"{len(missing)} not made yet, e.g. {missing[0]!r} (the server makes them in the background)"
    return f"{len(texts)} clips ready"


def speech_recognition():
    import numpy as np
    import soundfile as sf

    clip = tts._path(tts.speakable(tts.fixed_phrases()[0]))  # any real Mongolian speech
    audio, rate = sf.read(clip)
    buf = io.BytesIO()
    sf.write(buf, np.asarray(audio, dtype=np.float32), rate, format="WAV", subtype="PCM_16")
    t = time.time()
    r = httpx.post(API + "/locate/voice", content=buf.getvalue(), headers={"Content-Type": "audio/wav"}, timeout=60).json()
    assert r["heard"], r
    return f"heard {r['heard'][:40]!r} in {time.time() - t:.1f} s"


def demo_photos():
    for n in (1, 2):
        httpx.head(f"{APP}/test/tov_nomyn_san_{n}.png", timeout=10).raise_for_status()
    return "?image=/test/tov_nomyn_san_1.png and _2.png served"


check("App (Next.js, :3000)", app_page)
check("Server via /api proxy", server_health)
check("YOLO + onnxruntime files", yolo_model)
check("Demo photos", demo_photos)
check("Hamuga plan: Дэнжийн 1000 -> Ч:55", plan_demo)
check("Typed location", locate_text)
check("Sign reading (PaddleOCR + fusion)", verify_photo)
check("Speech recognition (Whisper)", speech_recognition)
check("Mongolian voice clips", voice_clips)

width = max(len(n) for _, n, _, _ in results)
for ok, name, detail, secs in results:
    print(f"{'PASS' if ok else 'FAIL'}  {name:<{width}}  {secs:5.1f}s  {detail}")
failed = sum(not ok for ok, *_ in results)
print("\nAll good: ready to demo." if not failed else f"\n{failed} check(s) failed: fix before the pitch.")
sys.exit(1 if failed else 0)
