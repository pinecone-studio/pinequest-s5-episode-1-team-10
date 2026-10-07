# CLAUDE.md — Bus Boarding Guide (Team 10)

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

## Deadlines
- **Fri 2026-10-09** — idea pitch (no deploy needed)
- **Sat 2026-10-10** — agree on data contract
- **Mon 2026-10-12** — full flow working on recorded video
- **Thu 2026-10-15 noon** — feature freeze
- **Fri 2026-10-16** — deployed app + final presentation

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

## Accuracy, speed, safety
Goal: **never confidently wrong.** Prefer "not sure" over guessing.
- Two sources must agree (camera + bus API). One source only → "Probably Bus 7, please confirm."
- Frame voting: a reading counts only if ≥5 of the last 7 frames agree.
- Confidence threshold below which → "Not sure, please ask someone." Tune until wrong "yes" = 0.
- Measure wrong "yes" (must be 0) and missed bus (safe) separately.

Speed targets: detection 5+ FPS on phone; sign readable → verdict < 2 s; guidance updates every 0.5 s; arrival alert ≥1 stop before ours.

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
| Coder 1 | Lead + app | Next.js app, camera, voice input, integration, scope |
| Coder 2 | Model | Frames, Roboflow dataset, YOLO11n training, ONNX export, frame voting, accuracy |
| Coder 3 | Backend + AI | FastAPI, bus API, PaddleOCR, fusion, destination suggestion, AI assistant |
| Coder 4 | Guidance + safety | Beacon, clock directions, steps, compass lock, moving-bus warning, bus-leaving, SOS |
| Coder 5 | Data | Filming, labeling, Mongolian voice lines, 10 assistant test questions |
| Coder 6 | Users + pitch | Blind-user interviews, tests, timing, decks, demo videos |

## Rules for AI-written code
1. **One owner per module** — only that person has AI change it.
2. **Respect the data contract** above in every change.
3. **Small steps** — one feature at a time, test on a real phone, commit.
4. **Commit working versions only**, with clear messages; revert to last working commit if broken.
5. **Test on the phone daily**, not just the laptop.
6. Everyone can explain their module in 2 minutes without notes.

## Final presentation numbers to collect
Route number correct (X/Y), wrong "yes" (must be 0), mismatches caught, door reached (X/Y), avg time bus-stop → door, assistant X/10 correct, beacon vs clock directions, one blind tester quote.

## Notes log
After writing or changing any file, add a dated entry to `NOTES.md` (newest first): what changed, which file, and why.

## Plan before work
Before writing or changing code/files: show a short plan (steps, files to touch) and ask any open questions. Wait for the user's answers/approval before starting.
