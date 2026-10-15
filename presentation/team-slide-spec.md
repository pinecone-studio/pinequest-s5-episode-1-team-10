# Team slide — 6 гишүүн (2×3 grid)

## Layout (1920×1080)

- Гарчиг зүүн дээд: **Манай баг** (48pt Bold, ink)
- Grid: 3 багана × 2 мөр, gap 48px, бүхэл slide-ийн төв доор
- Нэг карт:
  - Дiameter **160px** circle (photo эсвэл initials)
  - Circle ард soft blue blur ring (template-тай ижил)
  - Нэр: 28pt Bold
  - Role: 20pt muted, **1 мөр**, тасалбаргүй

## 6 гишүүн (repo + CLAUDE.md)

| # | Нэр | Role (slide дээр) | GitHub (photo) |
|---|-----|-------------------|----------------|
| 1 | Lead | Backend · API · OCR | Kajjpro |
| 2 | Халиун | YOLO · ONNX · AI UI | syrethestar-sys |
| 3 | Чулуунбат | App · PWA · дуу | chuluunbatt |
| 4 | Uranzul | Чиглүүлэг · SOS · аюул | turbold10 |
| 5 | Otgonjargal | Дата · дуу · тест | otgonjargall |
| 6 | *(6 дахь)* | **Нэрийг Figma-д оруул** | — |

> NOTES: албан ёсоор 5 role + Lead гэж 5–6 тоолол зөрүүтэй. Pinequest 6 хүн гэвэл 6-р slot-д багийн нэмэлт гишүүн эсвэл Lead-ийн бодит нэрийг оруулна уу.

## Figma-д хурдан хийх

1. Frame duplicate → «Team»
2. 6 circle component (`Team/Avatar`) — variant: photo / initials
3. Auto layout row × 2
4. Нэг удаа blur circle background баруун доод буланд

## Initials fallback (photo байхгүй бол)

- L, Kh, Ch, U, O, +6th

Photo: GitHub avatar URL `https://avatars.githubusercontent.com/u/<id>?v=4` (export 320×320).
