#!/usr/bin/env python3
"""Export slides.html to PNG (per slide) + merged PDF."""

from __future__ import annotations

from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
HTML = ROOT / "deck" / "index.html"
if not HTML.is_file():
    HTML = ROOT / "slides.html"
OUT_DIR = ROOT / "export"
PDF = ROOT / "Team10-Avtobus-Khotoch.pdf"
SLIDE_COUNT = 13


def main():
    OUT_DIR.mkdir(exist_ok=True)
    paths = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        page.goto(HTML.as_uri())
        for i in range(SLIDE_COUNT):
            if i > 0:
                page.keyboard.press("ArrowRight")
            path = OUT_DIR / f"slide-{i + 1:02d}.png"
            page.locator(".slide.active").screenshot(path=str(path))
            paths.append(path)
        browser.close()

    try:
        import img2pdf

        with open(PDF, "wb") as f:
            f.write(img2pdf.convert([str(p) for p in paths]))
        print("Wrote", PDF)
    except ImportError:
        print("PNG only (pip install img2pdf for PDF)")
    for p in paths:
        print(p)


if __name__ == "__main__":
    main()
