# Work Notes — Handoff

Read this first every session. Before `/clear`, update all three sections:
"Update NOTES.md with what we did, the decisions, and what's next."

## Next
- [ ] Task tracker (who does what, status): https://claude.ai/code/artifact/677ebbd7-ff83-4db8-9599-3a0facb1cf15 — share with team.
- [ ] **Pitch (Fri 2026-10-09, 8 min + 7 min Q&A, Mongolian)** — draft deck done: https://claude.ai/artifact/E5hjBwBFZyLGkcdB4dDT2i (private; share via Share menu). TODO: add interview quote (Chuluunbat/Otgonjargal), rehearse timing. Q&A prep doc (15 Qs, fill [Бөглөх] #4 #10 #11 #15): https://claude.ai/code/artifact/e64aaa89-46f5-4b75-8028-757df59dcbbc
- [ ] **Live ETA — PARKED (user, 2026-10-08)**: emailed ICT Group (Hamuga) info@ + cc sales@ on 2026-10-08 asking to enable `POST /api/bus/v1/cluster` (503 for our key) + free/discounted hackathon access. No reply by 2026-10-09 → call them. Until then `eta_seconds` = null.
- [ ] Check Hamuga "Үнэ" tab: API calls are billed monthly (QPay). Server makes 2 calls per start.
- [ ] Tell Chuluunbat about new `GET /stops/nearest?lat=&lon=` (contract addition) before Sat sign-off.
- [ ] **Deploy host for server needs ≥1 GB RAM** — PaddleOCR peaks ~590 MB; Render free (512 MB) will OOM. Pick before Thu 10/15 (Render Standard / Railway / Fly 1 GB).
- [ ] Tune `fusion.CONF_MIN` (0.8) on real sign photos from Otgonjargal's filming; test Cyrillic suffixes (7а, 3Ма) on real signs.
- [ ] Share data contract with team (`server/contract.py`, `shared/contract.ts`) and get agreement — due Sat 2026-10-10. 
- [ ] Commit/PR the memory-cycle change when the user says so (not pushed yet).

## Decisions
- **2026-10-08** /verify fusion: "yes" only if OCR reads the wanted number (conf ≥ 0.8) AND Hamuga says the route stops here AND no sibling route here shares/extends the number (Ч:7 vs Ч:7а/Х:7 → unsure). Other confident number → "no". Else "unsure". OCR = PaddleOCR 3.3.3 en + PP-OCRv5_mobile_det (same reads as server det, 73 ms vs 175 ms warm, less RAM). OCR + stop list warmed at startup.
- **2026-10-08** Live bus positions parked — build on static Hamuga data (stops, routes) first; `eta_seconds` stays null.
- **2026-10-08** Bus data = **Hamuga API** (`https://gateway.hamuga.mn/transport`, `x-api-key`). `stop_id` = Hamuga `busStopId` ("000000529"), `wanted_route` = full `busRouteNo` ("Ч:81") — server matches OCR "81" against it. City app name is **UB card** (ubcard.mn, 7004-4040), not "UB Smart Bus".
- **2026-10-08** Pitch stat = **11,125** visually impaired (2025, 1212.mn — checked by user; no 2026 data). Share ~11% is 2022 (12,696 / 115k, eagle.mn) — labelled as 2022 on slide. 11,100 dropped. Bus problems for blind riders: no published data → use interview quotes.
- **2026-10-08** `sign_crop` = base64 JPEG in JSON (small crops, simplest). `eta_seconds` is null when unknown. Stub `/verify` always says "unsure" until OCR + fusion exist (never confidently wrong).
- **2026-10-08** TS contract lives in `shared/contract.ts` (not `app/`) so Chuluunbat's `create-next-app` isn't blocked by an existing folder.
- **2026-10-08** Team is 5 (not 6). Lead = backend (server, OCR, fusion, assistant backend). Khaliun = model + assistant UI. Chuluunbat = app/flow. Uranzul = guidance + safety. Otgonjargal (weaker) = data, voice lines, test questions. Full stack kept (YOLO + PaddleOCR), no simplification.
- **2026-10-08** Repo layout: one repo, `app/` (Next.js PWA) + `server/` (FastAPI).
- **2026-10-08** Pitch deck in Mongolian, 11 slides, speaker notes ≈7.5 min.
- **2026-10-08** User is **Coder 1 (lead + app)**.
- **2026-10-08** Pitch before code.
- **2026-10-08** Bus API unknown → mock it until we find the real one.
- **2026-10-08** Don't push without the user asking.
- **2026-10-08** `NOTES.md` is the session handoff file (Done / Decisions / Next). Memory cycle: work → update notes → clear → read notes → continue.
- **2026-10-07** `main` is protected → work on branches, merge through PRs.
- **2026-10-07** Plan before work: show plan + questions, wait for approval.

## Done
### 2026-10-08
- Real `/verify`: `server/ocr.py` (PaddleOCR), `server/fusion.py` (decision logic), `bus_api.routes_at_stop`, startup warm-up in `main.py`; paddlepaddle 3.2.2 + paddleocr 3.3.3 pinned. 24 tests pass. Live: sign "81"/Ч:81 → yes 0.11 s on first call after start; "53" → no; "7"/Ч:7 at 000000529 → unsure. Models (~92 MB) cache in `~/.paddlex/`.
- Deck v8: stats slide 11,125 (2025, 1212.mn), % labelled 2022.
- Deck v7: plan slide 6 → 5 people + 5 roles, stats placeholder → Chuluunbat/Otgonjargal, tech slide + notes name Hamuga API, close slide drops "bus API access" ask.
- Read Hamuga docs (developer portal manual, Hamuga ID login docs): calls billed per endpoint, key regen kills old key, empty IP list = any IP. Hamuga ID login not needed for our app. Emailed ICT Group about `/cluster`.
- Hamuga client in `server/bus_api.py` (stops + routes cached once, nearest stop by haversine; key from `HAMUGA_API_KEY` in gitignored `server/.env`), new `GET /stops/nearest` in `main.py`, `NearestStop` in `contract.py` + `shared/contract.ts`. 6 offline tests pass; live: Sükhbaatar Sq → "Сүхбаатарын талбайн төв зогсоол" 67 m, cold 0.71 s / warm 2 ms. Run locally: `cd server && set -a && . ./.env && set +a && .venv/bin/uvicorn main:app --reload`.
- Contract examples switched to Hamuga IDs (`server/contract.py`, `shared/contract.ts`, `server/bus_api.py` mock, `server/test_main.py`); 3 tests pass.
- Deck stats slide: 11,100 → 12,696, ~11% of 115k, source line + speaker notes updated.
- Research: found Hamuga transport API (stops, routes, stops-by-route, shapes; live `/cluster` hidden). UB card has live map but no public API.
- Branch `feat/data-contract`: `server/` FastAPI (`contract.py` Pydantic models, `main.py` `/health` + stub `/verify`, `bus_api.py` mock ETAs, `test_main.py` 3 tests passing), `shared/contract.ts` TS mirror, Python ignores in `.gitignore`. Run: `cd server && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/uvicorn main:app --reload`.
- Built clickable pitch demo (phone mockup, Mongolian, choose → wait → verify with wrong-bus catch → door beacon → moving-bus alarm): https://claude.ai/artifact/UuNBiDkm8cjibr4umnXjCh — no Cloudinary (it only hosts media).
- Updated `CLAUDE.md` roles table to the 5 real names. Added `CLAUDE.local.md` (lead's personal notes + links, gitignored) and `.gitignore`.
- Created team task-split doc (roles + 22-task tracker).
- Drafted Q&A prep doc (15 questions, Mongolian answers) as a Claude Doc.
- Built pitch deck (11 slides, Mongolian, speaker notes) as a Slides artifact.
- Restructured `NOTES.md` into handoff format (Next / Decisions / Done).
- Added "Memory cycle" rule to `CLAUDE.md`.

### 2026-10-07
- Moved `CLAUDE.md` and `NOTES.md` into the git repo; pushed branch `docs/claude-guide` for a PR (merged).
- Added "Plan before work" rule to `CLAUDE.md`.
- Created `CLAUDE.md` from the Google Doc hackathon plan.
- Created `NOTES.md`.
