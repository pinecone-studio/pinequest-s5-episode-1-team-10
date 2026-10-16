"""Fixtures for the Playwright e2e tests (gitignored: the bus photo shows bystanders' faces).

    server/.venv/bin/python app/e2e/make-fixtures.py

- e2e/fixtures/bus.y4m: one night photo at Сүхбаатарын талбай as Chromium's fake camera video (Pixel)
- e2e/fixtures/bus.jpg: the same photo for the iPhone camera stand-in (WebKit has no fake camera)
- e2e/fixtures/page.png: a printed page for the reader
"""
import shutil
import sys
from pathlib import Path

from PIL import Image

APP = Path(__file__).resolve().parent.parent
OUT = APP / "e2e" / "fixtures"
PHOTO = APP / "public" / "test-fixtures" / "bus" / "IMG_3388.jpg"  # Ч:29Б at the stop, sign lit
PAGE = APP / "public" / "test" / "page_1080.png"
SIZE = (720, 960)  # 3:4 like the photo; both sides even (4:2:0)
FRAMES = 10  # Chromium loops the file


def y4m(image, path):
    # YUV4MPEG2, 4:2:0: a header, then per frame "FRAME\n" and the Y, U, V planes (U and V at half size)
    y, u, v = image.convert("YCbCr").split()
    w, h = image.size
    half = (w // 2, h // 2)
    planes = y.tobytes() + u.resize(half, Image.BILINEAR).tobytes() + v.resize(half, Image.BILINEAR).tobytes()
    with open(path, "wb") as f:
        f.write(f"YUV4MPEG2 W{w} H{h} F15:1 Ip A1:1 C420jpeg\n".encode("ascii"))
        for _ in range(FRAMES):
            f.write(b"FRAME\n")
            f.write(planes)


def main():
    missing = [str(p) for p in (PHOTO, PAGE) if not p.exists()]
    if missing:
        sys.exit("missing (local only, not in git): " + ", ".join(missing))
    OUT.mkdir(parents=True, exist_ok=True)
    photo = Image.open(PHOTO).convert("RGB").resize(SIZE, Image.LANCZOS)
    y4m(photo, OUT / "bus.y4m")
    photo.save(OUT / "bus.jpg", quality=90)
    shutil.copyfile(PAGE, OUT / "page.png")
    for name in ("bus.y4m", "bus.jpg", "page.png"):
        print(OUT / name, (OUT / name).stat().st_size, "bytes")


if __name__ == "__main__":
    main()
