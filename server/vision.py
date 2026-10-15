"""The Reader's page text with Google Cloud Vision (DOCUMENT_TEXT_DETECTION, Mongolian hint "mn"): the
phone sends the page photo (JPEG); this server adds the key (GOOGLE_VISION_API_KEY, in .env / Vercel env)
and returns the lines in reading order, with punctuation, each with its confidence.

An OCR engine, not a language model: it reports what it sees and never makes up words. Mongolian is
"experimental" in Vision's language list. 1,000 pages a month free, then paid; the phone sends a page
once, and reads with its own model (PaddleOCR) when this fails or there's no network.
Docs: cloud.google.com/vision/docs/fulltext-annotations
"""
import base64
import os

import httpx

URL = "https://vision.googleapis.com/v1/images:annotate"
MAX_BYTES = 4 * 1024 * 1024  # Vercel takes 4.5 MB per request; a 3000 px JPEG page is ~1-2 MB

# How a character ends: a space, the end of a line, or a hyphen at the end of a line.
SPACE = {"SPACE", "SURE_SPACE"}
LINE_END = {"EOL_SURE_SPACE", "LINE_BREAK"}


def _key():
    return os.environ.get("GOOGLE_VISION_API_KEY", "").strip().strip("\"'")


def configured():
    return bool(_key())


def _lines(annotation):
    """fullTextAnnotation -> [{"text", "conf", "breakAfter"}] in reading order (blocks, paragraphs)."""
    out = []
    for page in annotation.get("pages", []):
        for block in page.get("blocks", []):
            for paragraph in block.get("paragraphs", []):
                text, confs = "", []
                for word in paragraph.get("words", []):
                    for symbol in word.get("symbols", []):
                        text += symbol.get("text", "")
                        if "confidence" in symbol:
                            confs.append(symbol["confidence"])
                        kind = symbol.get("property", {}).get("detectedBreak", {}).get("type")
                        if kind in SPACE:
                            text += " "
                        elif kind == "HYPHEN":
                            text += "-"
                        if kind in LINE_END or kind == "HYPHEN":
                            if text.strip():
                                out.append({"text": text.strip(), "conf": _mean(confs), "breakAfter": False})
                            text, confs = "", []
                if text.strip():
                    out.append({"text": text.strip(), "conf": _mean(confs), "breakAfter": False})
                if out:
                    out[-1]["breakAfter"] = True  # a paragraph ends
    return out


def _mean(confs):
    # Vision leaves confidence out for some languages: then the line counts as read
    return round(sum(confs) / len(confs), 3) if confs else 0.9


def read_page(jpeg):
    """Lines of the page; RuntimeError if not configured, too big, or refused."""
    key = _key()
    if not key:
        raise RuntimeError("GOOGLE_VISION_API_KEY is not set")
    if not 0 < len(jpeg) <= MAX_BYTES:
        raise RuntimeError(f"image must be 1-{MAX_BYTES} bytes, got {len(jpeg)}")
    body = {"requests": [{
        "image": {"content": base64.b64encode(jpeg).decode("ascii")},
        "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
        "imageContext": {"languageHints": ["mn"]},
    }]}
    r = httpx.post(URL, params={"key": key}, json=body, timeout=25)
    if r.status_code != 200:
        raise RuntimeError(f"Vision {r.status_code} {r.text[:200]}")
    answer = r.json()["responses"][0]
    if "error" in answer:
        raise RuntimeError(f"Vision error {answer['error'].get('message', '')[:200]}")
    return _lines(answer.get("fullTextAnnotation", {}))
