#!/usr/bin/env python3
"""Build Team 10 pitch deck (.pptx) — 16:9, minimal text, royal blue theme."""

from __future__ import annotations

import os
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
OUT = ROOT / "Team10-Avtobus-Khotoch.pptx"

BLUE = RGBColor(0x1D, 0x4E, 0xD8)
BLUE_SOFT = RGBColor(0x3B, 0x82, 0xF6)
INK = RGBColor(0x0F, 0x17, 0x2A)
MUTED = RGBColor(0x64, 0x74, 0x8B)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

SLIDE_W = Inches(13.333)
SLIDE_H = Inches(7.5)


def blank_slide(prs: Presentation):
    layout = prs.slide_layouts[6]
    return prs.slides.add_slide(layout)


def textbox(slide, left, top, width, height, text, size=28, bold=False, color=INK, align=PP_ALIGN.LEFT):
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = MSO_ANCHOR.TOP
    p = tf.paragraphs[0]
    p.text = text
    p.alignment = align
    p.font.size = Pt(size)
    p.font.bold = bold
    p.font.color.rgb = color
    p.font.name = "Arial"
    return box


def soft_blob(slide, left, top, size_in):
    shape = slide.shapes.add_shape(
        MSO_SHAPE.OVAL, left, top, Inches(size_in), Inches(size_in)
    )
    shape.fill.solid()
    shape.fill.fore_color.rgb = BLUE_SOFT
    shape.line.fill.background()
    shape.shadow.inherit = False
    # python-pptx has no blur; soft color reads as decorative circle
    return shape


def blue_panel(slide, width_in=5.5):
    panel = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE, Inches(0), Inches(0), Inches(width_in), SLIDE_H
    )
    panel.fill.solid()
    panel.fill.fore_color.rgb = BLUE
    panel.line.fill.background()
    return panel


def slide_title(prs: Presentation):
    slide = blank_slide(prs)
    soft_blob(slide, Inches(8.5), Inches(1.2), 3.2)
    soft_blob(slide, Inches(10), Inches(4), 2.2)
    textbox(slide, Inches(0.9), Inches(2.4), Inches(7), Inches(1.5), "Автобус хотоход", 54, True, INK)
    textbox(slide, Inches(0.9), Inches(3.8), Inches(7), Inches(0.6), "Pinequest S5 · Баг 10", 18, True, MUTED)


def slide_section(prs: Presentation, panel_title: str, headline: str, sub: str):
    slide = blank_slide(prs)
    blue_panel(slide)
    textbox(slide, Inches(0.7), Inches(2.8), Inches(4.5), Inches(1.2), panel_title, 44, True, WHITE)
    soft_blob(slide, Inches(9), Inches(1), 2.8)
    textbox(slide, Inches(6.2), Inches(2.5), Inches(6.5), Inches(1.2), headline, 28, True, INK)
    textbox(slide, Inches(6.2), Inches(3.8), Inches(6.5), Inches(1), sub, 20, False, MUTED)


def slide_big_stat(prs: Presentation, stat: str, line1: str, line2: str):
    slide = blank_slide(prs)
    soft_blob(slide, Inches(9.5), Inches(2), 2.5)
    textbox(slide, Inches(0.9), Inches(2), Inches(10), Inches(1.8), stat, 96, True, BLUE)
    textbox(slide, Inches(0.9), Inches(4), Inches(10), Inches(0.8), line1, 26, True, INK)
    textbox(slide, Inches(0.9), Inches(4.9), Inches(10), Inches(0.8), line2, 20, False, MUTED)


def slide_steps(prs: Presentation, title: str, steps: list[tuple[str, str]]):
    slide = blank_slide(prs)
    textbox(slide, Inches(0.9), Inches(0.8), Inches(8), Inches(0.9), title, 44, True, INK)
    y = Inches(2.0)
    for num, body in steps:
        textbox(slide, Inches(0.9), y, Inches(1), Inches(0.5), num, 22, True, BLUE)
        textbox(slide, Inches(1.8), y, Inches(10.5), Inches(0.7), body, 22, False, INK)
        y += Inches(0.95)


def slide_stats_grid(prs: Presentation):
    slide = blank_slide(prs)
    textbox(slide, Inches(0.9), Inches(0.8), Inches(4), Inches(0.9), "Тоо", 44, True, INK)
    cols = [
        ("11.1K", "хараа ихэссэн (2025)"),
        ("2", "эх сурвалж зөвшилцөх"),
        ("<2s", "«таны автобус» хэлэх"),
    ]
    x = Inches(0.9)
    for num, lbl in cols:
        textbox(slide, x, Inches(2.5), Inches(3.5), Inches(1), num, 48, True, BLUE)
        textbox(slide, x, Inches(3.6), Inches(3.5), Inches(1), lbl, 18, False, MUTED)
        x += Inches(4)


def slide_demo(prs: Presentation):
    slide = blank_slide(prs)
    soft_blob(slide, Inches(8), Inches(1.5), 3)
    textbox(
        slide,
        Inches(0.9),
        Inches(2.6),
        Inches(11),
        Inches(1.2),
        "avtobus-khotoch.vercel.app",
        40,
        True,
        INK,
    )
    textbox(slide, Inches(0.9), Inches(4), Inches(8), Inches(0.6), "Live demo · Android Chrome", 20, False, MUTED)


def add_circle_photo(slide, path: Path, left, top, size_in):
    if path.is_file():
        slide.shapes.add_picture(str(path), left, top, Inches(size_in), Inches(size_in))
    else:
        sh = slide.shapes.add_shape(MSO_SHAPE.OVAL, left, top, Inches(size_in), Inches(size_in))
        sh.fill.solid()
        sh.fill.fore_color.rgb = BLUE
        sh.line.fill.background()


def slide_team(prs: Presentation):
    slide = blank_slide(prs)
    textbox(slide, Inches(0.9), Inches(0.55), Inches(6), Inches(0.8), "Манай баг", 40, True, INK)
    members = [
        ("Lead", "Backend · API · OCR", ASSETS / "lead.jpg"),
        ("Халиун", "YOLO · ONNX · AI UI", ASSETS / "khaliun.jpg"),
        ("Чулуунбат", "App · PWA · дуу", ASSETS / "chuluun.jpg"),
        ("Uranzul", "Чиглүүлэг · SOS", ASSETS / "uranzul.jpg"),
        ("Otgonjargal", "Дата · дуу · тест", ASSETS / "otgon.jpg"),
        ("6-р гишүүн", "Нэр · үүрэг", None),
    ]
    col_w = Inches(3.9)
    row_h = Inches(2.85)
    start_x = Inches(0.75)
    start_y = Inches(1.45)
    photo = Inches(1.05)
    for i, (name, role, photo_path) in enumerate(members):
        col = i % 3
        row = i // 3
        x = start_x + col * col_w
        y = start_y + row * row_h
        cx = x + (col_w - photo) / 2
        if photo_path:
            add_circle_photo(slide, photo_path, cx, y, 1.05)
        else:
            sh = slide.shapes.add_shape(MSO_SHAPE.OVAL, cx, y, photo, photo)
            sh.fill.solid()
            sh.fill.fore_color.rgb = BLUE_SOFT
            sh.line.fill.background()
            textbox(slide, cx, y + Inches(0.35), photo, Inches(0.4), "?", 28, True, WHITE, PP_ALIGN.CENTER)
        textbox(slide, x, y + Inches(1.15), col_w, Inches(0.45), name, 18, True, INK, PP_ALIGN.CENTER)
        textbox(slide, x, y + Inches(1.55), col_w, Inches(0.55), role, 14, False, MUTED, PP_ALIGN.CENTER)


def slide_thanks(prs: Presentation):
    slide = blank_slide(prs)
    soft_blob(slide, Inches(1), Inches(2), 2.5)
    textbox(slide, Inches(0.9), Inches(2.5), Inches(8), Inches(1.2), "Баярлалаа", 54, True, INK)
    textbox(slide, Inches(0.9), Inches(3.8), Inches(6), Inches(0.6), "Асуулт?", 24, False, MUTED)
    textbox(slide, Inches(0.9), Inches(6.2), Inches(8), Inches(0.5), "Баг 10 · Pinequest Season 5", 16, True, MUTED)


def slide_quote(prs: Presentation):
    slide = blank_slide(prs)
    textbox(
        slide,
        Inches(1.2),
        Inches(2.2),
        Inches(10.5),
        Inches(1.8),
        "«Автобусын дугаарыг харахгүй — зөвхөн сонсож мэдэхгүй.»",
        28,
        True,
        INK,
    )
    textbox(
        slide,
        Inches(1.2),
        Inches(4.2),
        Inches(10),
        Inches(0.6),
        "— Хэрэглэгчийн ярилцлага",
        18,
        False,
        MUTED,
    )


def slide_qa(prs: Presentation):
    slide = blank_slide(prs)
    textbox(slide, Inches(0.9), Inches(0.8), Inches(10), Inches(0.9), "Бид юу хэмжих вэ?", 44, True, INK)
    bullets = [
        "Буруу «тийм» = 0",
        "Хаалга хүрсэн X/Y",
        "Туслах 10 асуулт X/10",
    ]
    y = Inches(2.2)
    for item in bullets:
        textbox(slide, Inches(1.2), y, Inches(10), Inches(0.6), "•  " + item, 24, False, INK)
        y += Inches(0.75)


def build():
    prs = Presentation()
    prs.slide_width = SLIDE_W
    prs.slide_height = SLIDE_H

    slide_title(prs)
    slide_section(
        prs,
        "Асуудал",
        "11,125 хараа ихэссэн иргэн · автобусанд гарахад тусламжгүй",
        "Камер + Hamuga API — хаалга хүртэл чиглүүлнэ",
    )
    slide_big_stat(prs, "0", "Буруу «энэ таны автобус»", "Итгэлгүй бол «баталгаажуулна уу»")
    slide_steps(
        prs,
        "Зам",
        [
            ("01", "Хаашаа · эсвэл автобусын дугаар"),
            ("02", "Ирэх мэдэгдэл · бэлэн бол"),
            ("03", "Камер + API · хаалга руу чиглүүлэх"),
        ],
    )
    slide_stats_grid(prs)
    slide_section(prs, "Шийдэл", "Утасны PWA", "Сүлжээ хүлээхгүй чиглүүлэг")
    slide_big_stat(prs, "5/7", "Frame санал", "Нэг кадраар шийдэхгүй")
    slide_steps(
        prs,
        "Аюулгүй байдал",
        [
            ("01", "Автобус хөдлөх → «хол зогс»"),
            ("02", "SOS — гэр бүлд байршил"),
            ("03", "Нэг чихний дуу + илбэр"),
        ],
    )
    slide_demo(prs)
    slide_team(prs)
    slide_quote(prs)
    slide_qa(prs)
    slide_thanks(prs)

    prs.save(str(OUT))
    print("Wrote", OUT, "slides:", len(prs.slides))


if __name__ == "__main__":
    build()
