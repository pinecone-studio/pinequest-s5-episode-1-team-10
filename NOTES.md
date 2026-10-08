# Work Notes — Handoff

Read this first every session. Before `/clear`, update all three sections:
"Update NOTES.md with what we did, the decisions, and what's next."

## Next
- [ ] Task tracker (who does what, status): https://claude.ai/code/artifact/677ebbd7-ff83-4db8-9599-3a0facb1cf15 — share with team.
- [ ] **Pitch (Fri 2026-10-09, 8 min + 7 min Q&A, Mongolian)** — draft deck done: https://claude.ai/artifact/E5hjBwBFZyLGkcdB4dDT2i (private; share via Share menu). TODO: verify stats (11,100 = from Google AI overview, sources Өрөг.mn/EAGLE.mn), add interview quote from Coder 6, rehearse timing. Q&A prep doc (15 Qs, fill [Бөглөх] #4 #10 #11 #15): https://claude.ai/code/artifact/e64aaa89-46f5-4b75-8028-757df59dcbbc
- [ ] **Live ETA**: email Hamuga to enable `POST /api/bus/v1/cluster` (503 for our key; draft email in chat 2026-10-08). Until then `eta_seconds` = null.
- [ ] Tell Chuluunbat about new `GET /stops/nearest?lat=&lon=` (contract addition) before Sat sign-off.
- [ ] Pitch deck: fix "6 хүн" → 5 (plan slide) and "[Coder 6]" placeholder (stats slide) — waiting on user OK.
- [ ] Share data contract with team (`server/contract.py`, `shared/contract.ts`) and get agreement — due Sat 2026-10-10. Then: PaddleOCR on sign crop → real verdict.
- [ ] Commit/PR the memory-cycle change when the user says so (not pushed yet).

## Decisions
- **2026-10-08** Bus data = **Hamuga API** (`https://gateway.hamuga.mn/transport`, `x-api-key`). `stop_id` = Hamuga `busStopId` ("000000529"), `wanted_route` = full `busRouteNo` ("Ч:81") — server matches OCR "81" against it. City app name is **UB card** (ubcard.mn, 7004-4040), not "UB Smart Bus".
- **2026-10-08** Pitch stat = **12,696** visually impaired (end 2022, NSO via eagle.mn), not 11,100 (unsourced, older). Bus problems for blind riders: no published data → use interview quotes.
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
