# CLAUDE.md — Bus Boarding Guide + Reader (Team 10)

Source plan: https://docs.google.com/document/d/14jDpekE13HNaziL-rDOitgeaXnd_pFiQS-rD-mCVX54/edit

## What we're building
A phone app (PWA) that takes a blind rider from "where do I want to go?" to the front door of the right bus.
Pitch: *The bus API knows roughly where the bus is. The camera knows exactly which bus it is and where the door is.*

Rider journey:
1. **Choose** — say a destination (app suggests a bus) or a bus number ("Bus 7").
2. **Get ready** — "Bus 7 in 3 minutes", "Bus 7 left the previous stop, get ready."
3. **Verify** — camera reads each arriving bus's route sign; "This is your bus" only when sign AND bus API agree.
4. **Board** — sound beacon + clock directions to the front door.
5. **Ask** — voice questions answered by an LLM using real bus API data.
6. **Stay safe** — warnings and help run in the background.

**Second part — Reader (next version, after the 10/16 final):** the same app reads printed text aloud: books, newspapers, letters, labels, medicine boxes. Free, on the phone, works offline.
Reader journey:
1. **Open** — hold and say "унш" (or the "Унших" button in screen-reader mode).
2. **Aim by sound** — the camera finds the page; short directions ("дээшээ", "холдуул", "зүүн тийш хазайлга", "хөдлөхгүй байгаарай") until the whole page is in frame and sharp.
3. **Auto-capture** — the app takes a full-resolution photo itself; the rider never has to find a shutter button.
4. **Read** — text is read in reading order (columns for newspapers), starting within ~2 s while the rest is still being recognised.
5. **Control** — double tap = pause/resume; swipe right/left = next/previous sentence; hold and say "дараагийн хуудас", "дахин", "хаана хүрсэн бэ".

## Deadlines
- **Fri 2026-10-09** — idea pitch (no deploy needed)
- **Sat 2026-10-10** — agree on data contract
- **Mon 2026-10-12** — full flow working on recorded video
- **Thu 2026-10-15 noon** — feature freeze
- **Fri 2026-10-16** — deployed app + final presentation
- **After 10/16** — Reader (next version); pitch it as the roadmap on 10/16, don't build it before the final

## Priorities
| Feature | Priority |
|---|---|
| Choose by bus number | Must |
| Arrival alert from bus API | Must |
| Camera sign verification | Must |
| Door guidance | Must |
| Moving-bus warning + "not sure" fallback | Must |
| Destination → bus suggestion (direct routes only) | Should |
| AI voice assistant for bus questions | Should |
| SOS: send location to family contact | Could |

**Cut (next version):** night, snow/rain, transfers, rear doors, on-bus stop announcements. Don't build these.

Reader priorities (next version, after 10/16):
| Feature | Priority |
|---|---|
| Guided auto-capture by sound (page in frame + sharp → photo) | Must |
| On-phone Mongolian Cyrillic OCR + reading order | Must |
| On-phone Mongolian voice for any text | Must |
| Pause / resume / next / previous sentence, multi-page | Must |
| "Unclear" for low-confidence lines (never guessed) | Must |
| Short text live (labels, prices, medicine, door signs) | Should |
| Summary / questions about the page (free LLM tier, optional, online only) | Could |
| Handwriting, banknotes, colours | Next-next version |

## Accuracy, speed, safety
Goal: **never confidently wrong.** Prefer "not sure" over guessing.
- Two sources must agree (camera + bus API). One source only → "Probably Bus 7, please confirm."
- Frame voting: a reading counts only if ≥5 of the last 7 frames agree.
- Confidence threshold below which → "Not sure, please ask someone." Tune until wrong "yes" = 0.
- Measure wrong "yes" (must be 0) and missed bus (safe) separately.

Speed targets: detection 5+ FPS on phone; sign readable → verdict < 2 s; guidance updates every 0.5 s; arrival alert ≥1 stop before ours.

Reader accuracy (same rule: **never confidently wrong**):
- Read only what OCR saw: no LLM "fixing" of the text that is read aloud. Lines below the confidence threshold → "энэ мөр тодорхойгүй", never a guess.
- Targets, measured on a fixed test set (20 book pages, 10 newspaper pages, 10 labels photographed by the auto-capture): **≥95% characters correct on book pages, ≥90% on newspapers**, 0 invented words; reading order correct on ≥9/10 newspaper pages.
- Speed: first sentence spoken ≤2 s after capture; capture guidance updates every 0.5 s; everything works offline after the first download.

Safety: "Step back, bus moving" overrides all other audio; "Stop, bus leaving" if bus moves during boarding; one earbud / bone conduction only; cane first (app guides direction, cane handles obstacles); SOS long-press if time.

## Tech stack
Two languages only: **TypeScript** (app) and **Python** (model + server).

| Part | Tools | Runs on |
|---|---|---|
| Phone app | Next.js PWA, getUserMedia camera, DeviceOrientation compass | Phone browser (Android Chrome first), Vercel |
| Detection (bus, door, route_sign) | YOLO11n fine-tuned → ONNX → onnxruntime-web | Phone |
| Tracking + stopping logic | Own IoU box tracker | Phone |
| Guidance audio | Web Audio API (PannerNode), recorded Mongolian voice clips | Phone |
| Voice input (Mongolian) | Chrome speech recognition `mn-MN`; backup Chimege API; last resort tap zones + voice menu | Phone + cloud |
| Model training | Ultralytics YOLO11n, Colab/Kaggle GPU | Cloud notebook |
| Labeling | Roboflow | Browser |
| Route-number OCR | PaddleOCR on sign crops | Server |
| Bus API + fusion | FastAPI | Server (Render/Railway) |
| Destination → bus | Nearest stop from bus API stop list; direct routes | Server |
| AI assistant | LLM with tool calling over our bus API functions (no guessing) | Server |
| Reader: page capture | Text detection (PP-OCR det, already in `lib/ocr.ts`) for page coverage + edge contact; Laplacian sharpness; `ImageCapture.takePhoto()` full-res; deskew + contrast in canvas | Phone |
| Reader: OCR | **PaddleOCR `cyrillic_PP-OCRv5_mobile_rec` ONNX** (Apache-2.0, 8 MB, has ө/ү), same onnxruntime-web queue as bus signs; fallback/compare: Tesseract.js `mon` (tessdata_best, 8.6 MB) | Phone |
| Reader: reading order | Own column/line ordering from text boxes (cluster by x, then y); later PP-DocLayout if needed | Phone |
| Reader: voice | Pre-made OronTTS clips for app phrases (as now) + **Meta MMS-TTS `facebook/mms-tts-mon`** (VITS, CC-BY-NC-4.0: free, non-commercial) exported to ONNX, int8 (~40 MB), run on the phone sentence by sentence; its alphabet writes ө as ѳ, so map ө→ѳ first | Phone |
| Reader: summary / questions (optional) | Free LLM tier (e.g. Gemini Flash free tier; limits change, check AI Studio) — only when asked, never for the read-aloud text | Cloud |

## Architecture & data contract
Detection, tracking, and guidance run **on the phone** so guidance never waits on the network. The server only answers "is this our bus?"

```
App → Server: { sign_crop, stop_id, wanted_route }
Server → App: { verdict: "yes" | "no" | "unsure", confidence, eta_seconds }
```
If the server doesn't answer within **1 second**, the app says "Not sure, please check."

## Team roles
| Who | Role | Owns |
|---|---|---|
| Lead | Lead + backend | FastAPI, bus API, PaddleOCR, fusion, destination suggestion, AI assistant backend, data contract, integration, deploy |
| Khaliun | Model + AI UI | YOLO11n training, ONNX on phone, IoU tracker, 5-of-7 voting, accuracy; AI assistant voice UI |
| Chuluunbat | App | Next.js PWA screens, camera, Mongolian voice input, choose → wait → verify → board flow |
| Uranzul | Guidance + safety | Beacon, clock directions, compass lock, moving-bus warning, bus-leaving, SOS |
| Otgonjargal | Data + support | Filming, Roboflow labeling, Mongolian voice lines, 10 assistant test questions, help with user tests + demo video |
| *(TBD)* | Reader (next version) | Page capture guidance, OCR, reading order, on-phone voice, reader test set + accuracy numbers |

User interviews and pitch are shared by Chuluunbat and Otgonjargal. Task tracker: https://claude.ai/code/artifact/677ebbd7-ff83-4db8-9599-3a0facb1cf15

## Rules for AI-written code
1. **One owner per module** — only that person has AI change it.
2. **Respect the data contract** above in every change.
3. **Small steps** — one feature at a time, test on a real phone, commit.
4. **Commit working versions only**, with clear messages; revert to last working commit if broken.
5. **Test on the phone daily**, not just the laptop.
6. Everyone can explain their module in 2 minutes without notes.

## Code style 
-Use function(){}syntax. No arrow functions (ESLint checks).
-In array methods, name the parameter `item`.
-One component per file, in /components

## Every session
-Start: read NOTES.md
-Finish: run lint, check the page in chrome, update NOTES.md.

## Final presentation numbers to collect
Route number correct (X/Y), wrong "yes" (must be 0), mismatches caught, door reached (X/Y), avg time bus-stop → door, assistant X/10 correct, beacon vs clock directions, one blind tester quote.

## Memory cycle (handoff)
Work → update notes → `/clear` → read notes → continue. Every session.
- **Start of session:** read `NOTES.md` first (Next / Decisions / Done).
- **After changing files:** add a dated line under **Done** (what, which file, why).
- **Before `/clear`** ("Update NOTES.md with what we did, the decisions, and what's next."): update all three sections — Done, Decisions (with why), Next (open tasks, top = most urgent).

## Plan before work
Before writing or changing code/files: show a short plan (steps, files to touch) and ask any open questions. Wait for the user's answers/approval before starting.
