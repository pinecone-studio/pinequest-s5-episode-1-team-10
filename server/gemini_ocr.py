"""The Reader's page text with Google Gemini (free tier, aistudio.google.com key GEMINI_API_KEY in .env /
Vercel env): the phone sends the page photo (JPEG); Gemini writes out the printed text exactly, line by
line, with punctuation, in reading order. Mongolian Cyrillic (ө, ү) is read far better than by the
phone's small model.

A language model, so it is told to copy, never to correct or guess: a part it can't read is left out.
Free tier: limited requests per minute / day (one per page), and Google may use the photos to improve
its products. The phone's own reader (PaddleOCR) reads when this fails.
"""
import base64
import os

import httpx

URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# Tried in order: an overloaded model (503), one out of free quota (429), closed (404) or refusing the
# settings (400) passes to the next. Measured on a small-print book page (1080p photo, 2026-10-15):
# gemini-flash-lite-latest 99.8% of characters right in 3.5 s (the phone's model: 91.9%);
# gemini-3.5-flash-lite 99.8% in 6.5 s; gemini-3.1-flash-lite 99.9% in 16 s; the newest Flash models
# were overloaded (503). Little thinking ("minimal"): copying text needs none, and it's ~5x faster.
MODELS = [m for m in [os.environ.get("GEMINI_MODEL", "")] if m] + ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"]
MAX_BYTES = 4 * 1024 * 1024

PROMPT = """This is a photo of printed text in Mongolian (Cyrillic script, with the letters Ө ө Ү ү).
Transcribe the text exactly as printed, in reading order (columns top to bottom, left column first).
Rules:
- Copy every word, letter and punctuation mark exactly as printed. Do not correct spelling, do not
  translate, do not summarise, do not add anything.
- Keep Ө ө and Ү ү distinct from О о, Е е and У у: look closely at each letter.
- One printed line per output line. Put an empty line between paragraphs, headings and columns.
- If a word or line cannot be read, leave it out. Never guess.
- Skip page numbers, running headers and text cut off at the photo's edge.
- Output only the text, nothing else. If there is no readable text, output nothing."""


def _key():
    return os.environ.get("GEMINI_API_KEY", "").strip().strip("\"'")


def configured():
    return bool(_key())


def read_page(jpeg):
    """Lines of the page [{"text", "conf", "breakAfter"}]; RuntimeError if not configured or refused."""
    key = _key()
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    if not 0 < len(jpeg) <= MAX_BYTES:
        raise RuntimeError(f"image must be 1-{MAX_BYTES} bytes, got {len(jpeg)}")
    body = {
        "contents": [{"parts": [
            {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(jpeg).decode("ascii")}},
            {"text": PROMPT},
        ]}],
        "generationConfig": {"temperature": 0, "thinkingConfig": {"thinkingLevel": "minimal"}},
    }
    for model in MODELS:
        r = httpx.post(URL.format(model=model), headers={"x-goog-api-key": key}, json=body, timeout=25)
        if r.status_code not in (400, 404, 429, 500, 503):
            break
        print("gemini", model, r.status_code, "-> next model")
    if r.status_code != 200:
        raise RuntimeError(f"Gemini {r.status_code} {r.text[:300]}")
    candidates = r.json().get("candidates") or []
    if not candidates:
        raise RuntimeError("Gemini gave no answer")
    parts = candidates[0].get("content", {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
    return _lines(text)


def _lines(text):
    out = []
    for raw in text.replace("\r", "").split("\n"):
        line = raw.strip().strip("`").strip()
        if not line:
            if out:
                out[-1]["breakAfter"] = True  # a paragraph ends
            continue
        out.append({"text": line, "conf": 0.95, "breakAfter": False})
    if out:
        out[-1]["breakAfter"] = True
    return out
