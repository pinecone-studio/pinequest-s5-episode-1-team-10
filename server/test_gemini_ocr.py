"""The Reader's server OCR (gemini_ocr.py, vision.py, /api/reader/ocr) with httpx.post mocked: no live
Gemini or Google Vision call is ever made."""
import httpx
import pytest
from fastapi.testclient import TestClient

import gemini_ocr
import lite
import vision

client = TestClient(lite.app)
JPEG = b"\xff\xd8\xff\xe0 fake page \xff\xd9"
MODELS = ["model-a", "model-b", "model-c"]


@pytest.fixture(autouse=True)
def no_keys(monkeypatch):
    # Every test starts with no key from the shell, a fixed model list, and no network at all
    for name in ("GEMINI_API_KEY", "GOOGLE_VISION_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(gemini_ocr, "MODELS", MODELS)

    def no_network(*args, **kwargs):
        raise AssertionError("live call")

    monkeypatch.setattr(httpx, "post", no_network)


def answer(text, thought=None):
    parts = ([{"text": thought, "thought": True}] if thought else []) + [{"text": text}]
    return {"candidates": [{"content": {"parts": parts}}]}


def fake_gemini(monkeypatch, replies):
    """replies: model -> (status, json); records the models asked, in order."""
    asked = []

    def fake_post(url, headers=None, json=None, timeout=None, params=None):
        model = url.split("/models/")[1].split(":")[0]
        asked.append(model)
        assert url == gemini_ocr.URL.format(model=model)
        assert headers == {"x-goog-api-key": "gemini-secret"}
        assert json["contents"][0]["parts"][1]["text"] == gemini_ocr.PROMPT
        status, body = replies[model]
        return httpx.Response(status, json=body, request=httpx.Request("POST", url))

    monkeypatch.setenv("GEMINI_API_KEY", "gemini-secret")
    monkeypatch.setattr(gemini_ocr.httpx, "post", fake_post)
    return asked


def test_configured_only_with_a_key(monkeypatch):
    assert gemini_ocr.configured() is False
    with pytest.raises(RuntimeError):
        gemini_ocr.read_page(JPEG)
    monkeypatch.setenv("GEMINI_API_KEY", "  ")
    assert gemini_ocr.configured() is False
    monkeypatch.setenv("GEMINI_API_KEY", "\"gemini-secret\"")
    assert gemini_ocr.configured() is True


def test_lines_one_per_printed_line_and_paragraph_breaks():
    text = "```\nНэгдүгээр мөр\n  Хоёрдугаар мөр  \n\n\nШинэ догол мөр\n```\n"
    assert gemini_ocr._lines(text) == [
        {"text": "Нэгдүгээр мөр", "conf": 0.95, "breakAfter": False},
        {"text": "Хоёрдугаар мөр", "conf": 0.95, "breakAfter": True},
        {"text": "Шинэ догол мөр", "conf": 0.95, "breakAfter": True},
    ]
    assert gemini_ocr._lines("") == []
    assert gemini_ocr._lines("\r\n\n") == []


def test_read_page_skips_thoughts(monkeypatch):
    asked = fake_gemini(monkeypatch, {"model-a": (200, answer("Мөр нэг\r\nМөр хоёр", thought="let me look"))})
    lines = gemini_ocr.read_page(JPEG)
    assert [line["text"] for line in lines] == ["Мөр нэг", "Мөр хоёр"]
    assert asked == ["model-a"]


@pytest.mark.parametrize("status", [429, 500, 503, 404, 400])
def test_busy_or_closed_model_passes_to_the_next(monkeypatch, status):
    asked = fake_gemini(monkeypatch, {"model-a": (status, {"error": {}}), "model-b": (200, answer("Мөр"))})
    assert [line["text"] for line in gemini_ocr.read_page(JPEG)] == ["Мөр"]
    assert asked == ["model-a", "model-b"]


def test_all_models_busy_is_an_error(monkeypatch):
    asked = fake_gemini(monkeypatch, {model: (429, {"error": {}}) for model in MODELS})
    with pytest.raises(RuntimeError, match="429"):
        gemini_ocr.read_page(JPEG)
    assert asked == MODELS


def test_bad_key_stops_at_the_first_model(monkeypatch):
    # 403 is not a model problem: trying the others would only spend quota
    asked = fake_gemini(monkeypatch, {"model-a": (403, {"error": {}})})
    with pytest.raises(RuntimeError, match="403"):
        gemini_ocr.read_page(JPEG)
    assert asked == ["model-a"]


def test_no_answer_is_an_error(monkeypatch):
    fake_gemini(monkeypatch, {"model-a": (200, {"candidates": []})})
    with pytest.raises(RuntimeError):
        gemini_ocr.read_page(JPEG)


def test_photo_size_is_checked_before_any_call(monkeypatch):
    asked = fake_gemini(monkeypatch, {})
    with pytest.raises(RuntimeError):
        gemini_ocr.read_page(b"")
    with pytest.raises(RuntimeError):
        gemini_ocr.read_page(b"x" * (gemini_ocr.MAX_BYTES + 1))
    assert asked == []


VISION_ANSWER = {"responses": [{"fullTextAnnotation": {"pages": [{"blocks": [{"paragraphs": [{"words": [
    {"symbols": [{"text": "Н", "confidence": 0.9}, {"text": "э", "confidence": 0.8}, {"text": "г", "confidence": 1.0,
                                                                                           "property": {"detectedBreak": {"type": "LINE_BREAK"}}}]},
]}]}]}]}}]}


def test_reader_ocr_uses_vision_when_there_is_no_gemini_key(monkeypatch):
    asked = []

    def fake_post(url, params=None, json=None, timeout=None, headers=None):
        asked.append(url)
        assert url == vision.URL and params == {"key": "vision-secret"}
        return httpx.Response(200, json=VISION_ANSWER, request=httpx.Request("POST", url))

    monkeypatch.setenv("GOOGLE_VISION_API_KEY", "vision-secret")
    monkeypatch.setattr(vision.httpx, "post", fake_post)
    r = client.post("/api/reader/ocr", content=JPEG, headers={"Content-Type": "image/jpeg"})
    assert r.status_code == 200
    assert r.json() == {"lines": [{"text": "Нэг", "conf": 0.9, "breakAfter": True}]}
    assert asked == [vision.URL]


def test_reader_ocr_uses_gemini_first_when_both_keys_are_set(monkeypatch):
    asked = fake_gemini(monkeypatch, {"model-a": (200, answer("Мөр"))})
    monkeypatch.setenv("GOOGLE_VISION_API_KEY", "vision-secret")
    r = client.post("/api/reader/ocr", content=JPEG)
    assert r.status_code == 200 and [line["text"] for line in r.json()["lines"]] == ["Мөр"]
    assert asked == ["model-a"]


def test_reader_ocr_failure_is_503_not_a_crash(monkeypatch):
    # The phone then reads the page with its own model
    fake_gemini(monkeypatch, {model: (503, {"error": {}}) for model in MODELS})
    assert client.post("/api/reader/ocr", content=JPEG).status_code == 503
    monkeypatch.delenv("GEMINI_API_KEY")
    assert client.post("/api/reader/ocr", content=JPEG).status_code == 503  # neither key: not configured


def test_reader_ocr_refuses_a_too_big_photo():
    assert client.post("/api/reader/ocr", content=b"x" * (vision.MAX_BYTES + 1)).status_code == 413
