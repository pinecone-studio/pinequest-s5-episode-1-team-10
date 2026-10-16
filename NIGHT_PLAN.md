# Night plan: bus-khutuch (branch app-shell)

## Hard rules

- Work only on branch app-shell. Never touch main. Never deploy to Production. Preview deploys are allowed.
- Never edit .env\* files or API keys.
- Don't change matcher safety: MARGIN, prefix rule, no-insert/no-delete rule. Never delete, skip or weaken a test to make it pass.
- Mock Azure and Gemini in tests. Live calls must stay under free-tier limits (Azure 20/min).
- Don't write new spoken announcement wording. Leave TODOs for me in NOTES.md.
- Small commit per change. If something needs my decision, write it in NOTES.md and move on.

## 1. One app, start to end

- Home screen with two large labeled buttons: "Автобус" and "Ном унших". VoiceOver/TalkBack: each reachable in 2 swipes or fewer, labeled back button on every screen.
- Full bus journey works end to end: choose destination → nearest stop + route chosen → guidance to the stop → bus scanner detects the right bus → riding / stop announcements → arrival.
- Book reader: photo → OCR (Gemini) → read aloud, reachable from home and back.

## 2. Route numbers must be SPOKEN correctly

Speech recognition already understands my route number. The problem is how the app SAYS it.

- Before any text goes to TTS, convert route codes to Mongolian words. Never send raw "Ч:29Б" or digits to TTS.
- Numbers in Mongolian words (attributive form for tens): 29Б → "хорин ес Б", 57 → "тавин долоо", 16А → "арван зургаа А", 81 → "наян нэг", 10 → "арав", 40 → "дөч".
- Letter suffixes and prefixes (Ч, М, Ү, Х, Д, ШҮ, and suffixes like Б, А, ӨВ): put their spoken form in one config file with TODO values for me to confirm. Use the plain letter until I fill them in.
- Unit tests for every route in data/routes.ts producing a spoken form. Generate audio samples for 5 routes into test-fixtures/speech/ so I can listen in the morning.

## 3. Bus camera: ultra-wide

- Prefer the ultra-wide back camera (iOS: device label "Ultra Wide"; Android: zoom capability min < 1), fall back to the normal back camera. Log which one was chosen.

## 4. Reading camera looks weird: fix it

- Inspect the book reader camera and list what's wrong in NOTES.md (stretched aspect ratio, mirrored, wrong camera, low resolution, zoom).
- Use the MAIN back camera for reading, never ultra-wide (it distorts pages up close and focuses badly).
- No mirroring, correct aspect ratio (object-fit), capture the photo at full resolution, not a downscaled video frame.

## 5. Nearest stop and route

- From GPS, find the nearest stop that has a route to the chosen destination. If several, prefer the shortest walk, then fewest stops.
- Announce which stop and which route, using existing wording or a TODO.
- No GPS → ask the user to choose a stop by voice.

## 6. PWA

- Installable PWA: name "bus-khutuch", manifest, icons, iPhone meta tags, service worker that never caches /api/\*.
- Android: accessible "Апп болгож суулгах" button (beforeinstallprompt). iPhone: "Хэрхэн суулгах вэ" button with spoken steps (wording TODO). Nothing shown when already installed.

## 7. Proof it works WHEN DEPLOYED

- `npm run build`, `npx tsc --noEmit`, `npm run lint` all exit 0. All unit tests pass.
- Playwright e2e in mobile emulation (iPhone and Pixel), run against a Preview deployment, not just localhost: fake camera video for the bus flow, fixture page image for the book reader, emulated GPS for nearest stop. Zero console errors and zero failed requests on every page.
- If the Preview is password-protected, set up Vercel's protection bypass for automation. If that's impossible, test locally and note it.
- Offline matcher report on test-fixtures/bus (cached OCR): zero wrong "yes".

## 8. Morning report

NOTES.md → "Morning report": what changed, Preview link, test results, what's left, every TODO and decision for me.
