"""PaddleOCR wrapper: JPEG bytes -> [(text, confidence)]."""
import threading
from functools import cache

import cv2
import numpy as np

# Big close-up digits break the detector (1280px "81" -> "8"), while a wide bus-side crop shrunk to
# 640px leaves the LED text a few pixels tall (tov_nomyn_san_1.png: conf 0.78 at 640, 0.95 at 1587).
# So cap the height, not the long side.
MAX_HEIGHT = 640
MAX_WIDTH = 1600

# PaddleOCR isn't thread-safe: two /verify requests running it at once on FastAPI's thread pool
# hung the server (and twice killed it) once the app kept 2 requests in flight.
_lock = threading.Lock()


@cache
def _model():
    from paddleocr import PaddleOCR

    # English model: digits are what matter. Mobile detector: same reads, ~2x faster, less RAM than server det.
    return PaddleOCR(
        lang="en",
        text_detection_model_name="PP-OCRv5_mobile_det",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )


def read_texts(jpeg_bytes):
    img = cv2.imdecode(np.frombuffer(jpeg_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("not a decodable image")
    scale = min(MAX_HEIGHT / img.shape[0], MAX_WIDTH / img.shape[1])
    if scale < 1:
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    with _lock:
        res = _model().predict(img)[0]
    return [(t, float(s)) for t, s in zip(res["rec_texts"], res["rec_scores"])]

