# TEAM 10 — Figma slide style (нэгдсэн өнгө)

Template-ийн Nursing Care загварын дагуу **3 өнгө + саарал** л үлдээнэ. Нэмэлт ногоон, улбар шар, олон цэнхэрийг устгана.

## Palette (Figma Variables эсвэл Styles)

| Token | Hex | Хэрэглээ |
|--------|-----|----------|
| `blue/primary` | `#1D4ED8` | Хэсгийн panel, цэг, progress bar |
| `blue/soft` | `#3B82F6` @ 35% blur | Blurred circle background |
| `white` | `#FFFFFF` | Slide background |
| `ink` | `#0F172A` | Гарчиг |
| `muted` | `#64748B` | Дэд текст (1 мөр л) |

**Устгах:** gradient олон өнгө, red/green status, 4+ өөр accent.

## Blurred circles (template signature)

1. Ellipse 400–600 px, fill `#3B82F6`, opacity 40%.
2. Effect → Layer blur **80px**.
3. Title slide баруун талд 2–3 давхар circle.
4. Content slide-үүдэд зөвхөн **1** soft circle (бусад slide clutter).

## Typography

- Font: **Inter** (Bold/Black гарчиг, Regular body).
- Гарчиг: 48–64 pt, max **6 үг**.
- Body: 24–28 pt, max **1 өгүүлбэр** эсвэл 3 bullet × 4 үг.

## Layout types (template-ээс)

1. **Title** — зүүн: том гарчиг; баруун: blurred circles.
2. **Section** — зүүн 40% solid blue panel + цагаан гарчиг; баруун цагаан.
3. **Big stat** — 1 тоо (89%, 11.1K) + 1 label доор.
4. **Process 01–03** — horizontal, blue dot + 1 мөр.
5. **Team 2×3** — доор тусад slide.

## Figma файл дээр хийх алхам

1. Бүх frame-ийн background → `#FFFFFF`.
2. Бүх текстийг `slides-content-mn.md`-ээс хуулж, lorem ipsum устгах.
3. Нэг **Color styles** library: primary, soft, ink, muted.
4. Давхардсан decoration layer-үүдийг нэг slide-д 1 circle rule-оор цэвэрлэх.
5. Team slide: `team-slide-spec.md` — 6 avatar circle + нэр + 1 role мөр.

## Slide жагсаалт (11 → 10, бага текст)

| # | Төрөл | Файл текст |
|---|--------|------------|
| 1 | Title | `slides-content-mn.md` §1 |
| 2 | Section | §2 |
| 3 | Stat | §3 |
| 4 | Process | §4 |
| 5 | Stat grid | §5 |
| 6 | Section | §6 |
| 7 | Big stat | §7 |
| 8 | Process | §8 |
| 9 | Demo | §9 |
| 10 | Team 6 | `team-slide-spec.md` |
| 11 | Thank you | §10 |

Энэ repo-д `presentation/slides.html` — Chrome fullscreen (F11) → screenshot эсвэл Figma-д зураг import.
