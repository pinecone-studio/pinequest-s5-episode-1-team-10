import io

import pytest
from PIL import Image, ImageDraw, ImageFont

pytest.importorskip("paddleocr")
import ocr


def test_reads_rendered_number():
    im = Image.new("RGB", (240, 120), "white")
    ImageDraw.Draw(im).text((60, 10), "81", fill="black", font=ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 90))
    buf = io.BytesIO()
    im.save(buf, "JPEG")
    assert "81" in [t for t, _ in ocr.read_texts(buf.getvalue())]
