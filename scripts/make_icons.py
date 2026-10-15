# App icons (home screen, manifest): a yellow bus front on black, the app's own colours (globals.css:
# --bg #000, --accent #ffd400). High contrast and no text, so it reads at 48 px and for low vision.
#   server/.venv/bin/python scripts/make_icons.py      -> app/public/icons/*.png, app/public/apple-touch-icon.png
# Drawn 4x larger, then scaled down (smooth edges). The maskable icon keeps the bus inside the
# centre 80% circle (Android crops it to a circle, squircle, ...).
from pathlib import Path

from PIL import Image, ImageDraw

BG = (0, 0, 0, 255)
BUS = (255, 212, 0, 255)  # --accent
OUT = Path(__file__).resolve().parent.parent / "app" / "public"


def draw(size, bus_width):
    """bus_width: the bus's width as a share of the icon (0-1), centred."""
    big = size * 4
    img = Image.new("RGBA", (big, big), BG)
    d = ImageDraw.Draw(img)
    w = big * bus_width

    def box(x0, y0, x1, y1):
        # Bus coordinates: x -0.5..0.5 of the bus width, y -0.6..0.6 (centred on the icon).
        c = big / 2
        return [c + x0 * w, c + y0 * w, c + x1 * w, c + y1 * w]

    r = w * 0.09
    d.rounded_rectangle(box(-0.5, -0.52, 0.5, 0.44), radius=r, fill=BUS)  # body
    d.rounded_rectangle(box(-0.36, -0.42, 0.36, -0.33), radius=w * 0.03, fill=BG)  # route sign
    d.rounded_rectangle(box(-0.4, -0.25, 0.4, 0.1), radius=w * 0.05, fill=BG)  # windscreen
    for x in (-0.28, 0.28):  # headlights
        d.ellipse(box(x - 0.08, 0.2, x + 0.08, 0.36), fill=BG)
    for x in (-0.36, 0.22):  # wheels under the body
        d.rounded_rectangle(box(x, 0.4, x + 0.14, 0.56), radius=w * 0.03, fill=BUS)
    for side in (-1, 1):  # mirrors
        x = 0.5 * side
        d.rounded_rectangle(box(min(x, x + 0.08 * side), -0.3, max(x, x + 0.08 * side), -0.26), radius=w * 0.01, fill=BUS)
        d.rounded_rectangle(box(min(x + 0.06 * side, x + 0.1 * side), -0.3, max(x + 0.06 * side, x + 0.1 * side), -0.12), radius=w * 0.015, fill=BUS)
    return img.resize((size, size), Image.LANCZOS).convert("RGB")  # no alpha: iOS fills it black anyway


def main():
    (OUT / "icons").mkdir(parents=True, exist_ok=True)
    draw(192, 0.62).save(OUT / "icons" / "icon-192.png", optimize=True)
    draw(512, 0.62).save(OUT / "icons" / "icon-512.png", optimize=True)
    draw(512, 0.5).save(OUT / "icons" / "icon-512-maskable.png", optimize=True)  # bus within the 80% circle
    draw(180, 0.62).save(OUT / "apple-touch-icon.png", optimize=True)
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
