"""Mongolian speech -> text with Chimege (api.chimege.com, a Mongolian speech company): the phone
sends the recording of one thing the rider said; this server adds the secret token (CHIMEGE_API_KEY,
in .env / Vercel env) and returns Chimege's text.

Paid per request (15₮ per call of up to 15 s), so the phone calls it only when it heard speech, once
per utterance, never to warm up or retry; Speechmatics still times the speech and is the fallback.
Chimege needs WAV of at least 50 KB and 0.5 s, at most 3 MB (docs.api.chimege.com/v1.2/en).
"""
import os

import httpx

URL = "https://api.chimege.com/v1.2/transcribe"
MAX_BYTES = 3 * 1024 * 1024
MIN_BYTES = 50 * 1024


def _key():
    return os.environ.get("CHIMEGE_API_KEY", "").strip().strip("\"'")


def configured():
    return bool(_key())


def transcribe(wav):
    """Lowercase Cyrillic text ('' if nothing was said); RuntimeError if not configured or refused."""
    key = _key()
    if not key:
        raise RuntimeError("CHIMEGE_API_KEY is not set")
    if not MIN_BYTES <= len(wav) <= MAX_BYTES:
        raise RuntimeError(f"audio must be {MIN_BYTES}-{MAX_BYTES} bytes, got {len(wav)}")
    r = httpx.post(URL, content=wav, headers={"Content-Type": "application/octet-stream", "Token": key, "Punctuate": "false"},
                   timeout=12)
    if r.status_code != 200:
        raise RuntimeError(f"Chimege {r.status_code} (error code {r.headers.get('Error-Code', '?')})")
    return r.content.decode("utf-8").strip()
