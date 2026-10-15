# Route numbers as the voice says them

Samples made with the local OronTTS voice (female, 32 steps, the same settings as the pre-made route clips):
`tts.synthesize(planner.take_speech(route), live=False)`, copied from `server/tts_cache/female/<clip key>.wav`.
Letters are the plain letters from `shared/route_speech.json` (TODO: confirm how they should be said).

| File | Route | Text spoken |
|---|---|---|
| CH-29B.wav | Ч:29Б | Ч хорин ес Б автобусанд суугаарай. |
| CH-57.wav | Ч:57 | Ч тавин долоо автобусанд суугаарай. |
| CH-16A.wav | Ч:16А | Ч арван зургаа А автобусанд суугаарай. |
| CH-40.wav | Ч:40 | Ч дөч автобусанд суугаарай. |
| SHU-1.wav | ШҮ:1 | ШҮ нэг автобусанд суугаарай. |

`routes.expected.json`: the spoken form of every route in `data/routes.json`. Both `app/lib/route.test.ts`
(routeSpeech) and `server/test_numwords_route.py` (route_words) compare against it, so the app and the voice
say a route the same way. After changing `shared/route_speech.json`, make it again:

```sh
cd server && .venv/bin/python -c "import json, numwords; from pathlib import Path; r = Path('..'); out = {x['key']: numwords.route_words(x['key']) for x in json.loads((r / 'data/routes.json').read_text(encoding='utf-8'))}; (r / 'test-fixtures/speech/routes.expected.json').write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')"
```

then check the diff, and remake the route clips (`server/make_speech.py`).
