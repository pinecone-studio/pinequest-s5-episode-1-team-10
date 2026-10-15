# Figma Slides — animation заавар (Баг 10)

Reference: **`presentation/deck/index.html`** — Chrome fullscreen (`F`) + `?autoplay=1&sec=6` — яг ийм **хөдөлгөөн, темп**-ийг Figma-д давт.

Figma файл: [TEAM-10 PineQuest S5](https://www.figma.com/slides/ChPKS5zsggUFVVsWGtGFfQ/TEAM-10---PineQuest-Season5?node-id=1-151)

---

## 1. Нэг удаагийн тохиргоо

| Зүйл | Утга |
|------|------|
| Frame | **1920 × 1080** |
| Font | **Outfit** (Google Fonts → Figma Fonts plugin) |
| Primary | `#2563EB` |
| Deep | `#1E3A8A` |
| Glow blur | `#60A5FA`, blur **80**, opacity **40%** |
| Text | `#0B1220` / muted `#64748B` |

**Variables** үүсгэ: `color/primary`, `color/ink`, `color/muted`.

---

## 2. Slide хоорондын transition (Present mode)

Figma Slides → slide сонгоод баруун **Animate**:

| Slide руу | Transition | Duration | Easing |
|-----------|------------|----------|--------|
| Ихэнх | **Dissolve** эсвэл **Move in** (from right 40px) | **650 ms** | Ease out |
| Section (panel) | **Move in** (content only) | **850 ms** | Custom cubic ≈ ease-out expo |

**Бүү хэрэглэ:** Bounce, Flip, 1s+ удаан transition.

---

## 3. Element animation (slide бүр дээр)

Figma Slides → object сонго → **Animate** → **On enter**:

| Element | Animation | Delay | Duration |
|---------|-----------|-------|----------|
| Гарчиг (h1) | **Fade + Move up** 28px | 0 ms | 900 ms |
| Tag / eyebrow | Fade up | 80 ms | 900 ms |
| Subtext | Fade up | 160 ms | 900 ms |
| Blue panel (section) | **Move in** from left | 0 ms | 850 ms |
| Timeline card ×3 | Scale 92%→100% + fade | 150 / 280 / 410 ms | 750 ms |
| Metric glass cards ×3 | Pop scale | 120 / 220 / 320 ms | 700 ms |
| Team avatar ×6 | Fade up + slight scale | 100–500 ms (80 ms алхам) | 800 ms |
| Bullets | Move in from left 16px | 150 / 280 / 410 ms | 650 ms |

**Team slide:** Avatar ring = ellipse stroke gradient `#2563EB` → `#A5B4FC` (Figma-д **Rotate** animation 8s loop — optional, present дээр subtle).

---

## 4. Background orbs (title + demo)

1. 2–3 ellipse, fill `#60A5FA`, blur 80, opacity 35%.
2. **Prototype** (хэрэв Slides дэмжвэл) эсвэл **Smart animate** 2 frame:
   - Frame A: position (0,0)
   - Frame B: position (−24, 18), scale 108%
   - Loop **12s**, ease in-out.

HTML reference: `deck/index.html` `.orb` + `@keyframes drift`.

---

## 5. Slide бүрийн checklist (13)

| # | Нэр | On-enter гол animation |
|---|-----|-------------------------|
| 1 | Title | Orbs loop + title stagger |
| 2 | Асуудал | Panel slide left + body fade up |
| 3 | Stat 0 | Gradient text scale 104→100% |
| 4 | Зам | 3 card stagger |
| 5 | Тоо | 3 metric pop |
| 6 | Шийдэл | Panel left |
| 7 | 5/7 | Big stat fade |
| 8 | Аюулгүй | 3 bullet slide-in |
| 9 | Demo | URL fade + glow pulse (opacity keyframe 3s) |
| 10 | Баг | 6 card stagger |
| 11 | Quote | Border-left + fade |
| 12 | Хэмжүүр | Bullets |
| 13 | Баярлалаа | Title + tag |

Текст: `slides-content-mn.md`.

---

## 6. Хурдан rebuild (Figma-д зураг + animation)

1. `deck/index.html` нээ → **F** fullscreen.
2. Slide бүр дээр **1 секунд хүлээ** (animation дуустал) → screenshot **1920×1080**.
3. Figma-д image background болгон тавина.
4. Дээр нь **text layer** (editable) + §3 animation нэмнэ.

Эсвэл plugin **html.to.design** (optional) — layout import, animation гараар.

---

## 7. Present rehearsal

- Нийт **~8 min** → slide бүр ~35–40 s ярил + transition.
- Autoplay rehearsal: `deck/index.html?autoplay=1&sec=8`

---

## 8. Хуучин PPTX

`Team10-Avtobus-Khotoch.pptx` — static, animationгүй. Final pitch = **Figma Slides** эсвэл **deck/index.html** fullscreen.
