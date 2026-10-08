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


def test_reads_closeup_number_on_large_photo():
    # 1280px phone photo with huge digits: read only "8" before images were capped at 640px.
    im = Image.new("RGB", (1280, 960), (120, 130, 140))
    d = ImageDraw.Draw(im)
    d.rectangle((240, 260, 1040, 700), fill=(10, 10, 10))
    d.text((640, 480), "81", fill=(255, 170, 0), font=ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 360), anchor="mm")
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    assert "81" in [t for t, _ in ocr.read_texts(buf.getvalue())]
