# Баг 10 — илгээх presentation (шууд ашиглах)

## Шууд нээх

| Файл | Хэрэглээ |
|------|----------|
| **`Team10-Avtobus-Khotoch.pptx`** | PowerPoint / Google Slides (**Файл → Импорт**) / Keynote — **гол файл** |
| **`Team10-Avtobus-Khotoch.pdf`** | PDF (илгээх / хэвлэх) |
| `export/slide-01.png` … `slide-13.png` | Figma / Canva-д зураг импорт |

13 slide: title, асуудал, 0 stat, зам, тоо, шийдэл, 5/7, аюулгүй байдал, demo, **баг 6**, quote, Q&A, баярлалаа.

## Дахин үүсгэх

```bash
cd presentation
pip install python-pptx pillow   # PPTX
python3 build_pptx.py

pip install playwright img2pdf   # PDF + PNG
python3 -m playwright install chromium
python3 export_png_pdf.py
```

## Figma

`FIGMA_STYLE.md` + `slides-content-mn.md` — Figma Slides-д гараар тааруулах бол.

## HTML preview

```bash
python3 -m http.server 8765
# slides.html — ←/→
```

## 6-р гишүүн

PPTX дээр «6-р гишүүн» placeholder — PowerPoint дээр нэр солино.
