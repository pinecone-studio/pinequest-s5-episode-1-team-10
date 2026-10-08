"""PaddleOCR wrapper: JPEG bytes -> [(text, confidence)]."""
from functools import cache

import cv2
import numpy as np

MAX_SIDE = 640


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
    # Big close-up digits break the detector (1280px "81" -> "8"); <=640px reads them right.
    scale = MAX_SIDE / max(img.shape[:2])
    if scale < 1:
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    res = _model().predict(img)[0]
    return [(t, float(s)) for t, s in zip(res["rec_texts"], res["rec_scores"])]
