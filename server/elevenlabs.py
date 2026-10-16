"""The Reader's voice with ElevenLabs Eleven v4 (Mongolian, "mn"): the phone sends one sentence with the
sentences around it (so the voice reads it as part of the story, not word by word); this server adds
the secret key (ELEVENLABS_API_KEY, in .env / Vercel env) and returns MP3.

Paid by characters (the account's credit), so the phone asks only for the sentences it is about to
read, a couple ahead, never twice; without a key or network the phone's own Mongolian voice reads.
Docs: elevenlabs.io/docs/api-reference/text-to-speech (Eleven v4: no speed setting, the phone speeds up).
"""
import os

import httpx

URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_44100_128"
MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_v4")
MAX_CHARS = 1000  # one sentence (a page has ~1500); longer is refused, not billed
CONTEXT_CHARS = 300  # previous / next text sent for flow (not spoken, not billed)


def _key():
    key = os.environ.get("ELEVENLABS_API_KEY") or os.environ.get("ELEVENLAB_API_KEY") or ""
    return key.strip().strip("\"'")


def _voice():
    return os.environ.get("ELEVENLABS_VOICE_ID", "").strip() or "EXAVITQu4vr4xnSDxMaL"


class Busy(RuntimeError):
    """The plan's limit of requests at a time (free: 2): the phone waits a moment and asks again."""


def configured():
    return bool(_key())


def speak(text, previous="", following=""):
    """MP3 bytes; RuntimeError if not configured, too long, or refused."""
    key = _key()
    if not key:
        raise RuntimeError("ELEVENLABS_API_KEY is not set")
    text = text.strip()
    if not text or len(text) > MAX_CHARS:
        raise RuntimeError(f"text must be 1-{MAX_CHARS} characters, got {len(text)}")
    body = {
        "text": text,
        "model_id": MODEL,
        "language_code": "mn",
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
    }
    if previous:
        body["previous_text"] = previous[-CONTEXT_CHARS:]
    if following:
        body["next_text"] = following[:CONTEXT_CHARS]
    r = httpx.post(URL.format(voice=_voice()), json=body, headers={"xi-api-key": key, "accept": "audio/mpeg"}, timeout=25)
    if r.status_code == 429:
        raise Busy("ElevenLabs busy (429)")
    if r.status_code != 200:
        detail = ""
        try:
            detail = str(r.json().get("detail", ""))[:200]
        except ValueError:
            pass
        raise RuntimeError(f"ElevenLabs {r.status_code} {detail}")
    return r.content
