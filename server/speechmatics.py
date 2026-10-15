"""Mongolian speech recognition for every phone with Speechmatics real-time (iPhone included: Apple's
own recognizer has no Mongolian). The phone streams its microphone straight to Speechmatics; this
server only hands out a temporary key (60 s), so the account key (SPEECHMATICS_API_KEY, in .env /
Vercel env) never reaches the phone. Free account: $100 credit, no card, 2 sessions at a time.
"""
import os

import httpx

URL = "wss://eu.rt.speechmatics.com/v2"
KEY_URL = "https://mp.speechmatics.com/v1/api_keys?type=rt"
TTL_S = 60  # the shortest Speechmatics allows


def _key():
    return os.environ.get("SPEECHMATICS_API_KEY", "").strip().strip("\"'")


def configured():
    return bool(_key())


def temporary_key():
    """{"jwt", "url", "ttl"} for one phone; RuntimeError if there's no key or Speechmatics refuses."""
    key = _key()
    if not key:
        raise RuntimeError("SPEECHMATICS_API_KEY is not set")
    r = httpx.post(KEY_URL, json={"ttl": TTL_S}, headers={"Authorization": f"Bearer {key}"}, timeout=5)
    if r.status_code >= 400:
        raise RuntimeError(f"Speechmatics refused a temporary key ({r.status_code})")
    return {"jwt": r.json()["key_value"], "url": URL, "ttl": TTL_S}
