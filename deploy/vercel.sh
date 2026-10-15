#!/bin/sh
# Free deploy, no laptop: builds deploy/out (the app + server/lite.py as a Vercel Python function +
# every pre-made voice clip as MP3) and deploys it to the Vercel project avtobus-khotoch.
#
#   deploy/vercel.sh            build + deploy to production
#   deploy/vercel.sh --build    build only (then: cd deploy/out && vercel deploy)
#
# Needs: the server venv (server/.venv, for the MP3 conversion and the vendored text normalizer),
# the clips in server/tts_cache/female (server/make_speech.py), `vercel login`, and the
# HAMUGA_API_KEY and SPEECHMATICS_API_KEY env vars set once in the Vercel project (never in these files).
# On the phone: sign reading runs in the browser (lib/ocr.ts), speech recognition is the browser's.
set -e
R=$(cd "$(dirname "$0")/.." && pwd)
D=$R/deploy/out
MP3=$R/deploy/mp3cache # converted once, reused
SP=$R/server/.venv/lib/python3.12/site-packages

rm -rf "$D.tmp" && mkdir -p "$D.tmp" "$MP3"
rsync -a --exclude node_modules --exclude .next --exclude public/test --exclude public/ort --exclude .vercel "$R/app/" "$D.tmp/"
[ -d "$D/.vercel" ] && cp -R "$D/.vercel" "$D.tmp/.vercel" # keep the project link
rm -rf "$D" && mv "$D.tmp" "$D"
cd "$D"

# shared/ (contract + phrases) goes inside the app
cp -R "$R/shared" shared
grep -rl '\.\./\.\./shared/' components lib app | xargs sed -i '' 's#\.\./\.\./shared/#../shared/#g'

# /api/* = lite server
mkdir -p api/_server/oron_tts api/_server/data/oron_mn_pinyin public/tts
for f in lite planner bus_api numwords fusion assistant contract tts gpu speechmatics chimege elevenlabs vision gemini_ocr; do cp "$R/server/$f.py" api/_server/; done
cp -R "$R/server/hamuga_cache" api/_server/
# Station + stop lists as of now (2 Hamuga calls here instead of 2 per new Vercel instance)
(set -a && . "$R/.env" && set +a && cd "$R/server" && .venv/bin/python -c 'import sys, bus_api; bus_api.save_snapshot(sys.argv[1])' "$D/api/_server/stops_snapshot.json")
cp "$SP/oron_tts/__init__.py" api/_server/oron_tts/
cp -R "$SP/oron_tts/text" api/_server/oron_tts/ && rm -rf api/_server/oron_tts/text/__pycache__ # MIT
cp "$SP/data/oron_mn_pinyin/vocab.txt" api/_server/data/oron_mn_pinyin/
cat > api/index.py <<'PY'
# Vercel Python function: the lite server (see _server/lite.py).
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "_server"))

from lite import app  # noqa: E402,F401  (Vercel serves this ASGI app)
PY
printf 'fastapi==0.128.8\npydantic==2.13.5\nhttpx==0.28.1\n' > requirements.txt
# icn1 (Seoul): nearest Vercel region to the Hamuga API in Ulaanbaatar (US East added ~2 s per new stop)
# Clips are named by their content hash, so they never change: the phone keeps them for a year and
# never asks again. Models: kept a day, then refreshed in the background (no wait).
cat > vercel.json <<'JSON'
{
  "regions": ["icn1"],
  "functions": {
    "api/index.py": { "includeFiles": "api/_server/**", "maxDuration": 30 }
  },
  "headers": [
    { "source": "/tts/(.*)\\.mp3", "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] },
    { "source": "/models/(.*)", "headers": [{ "key": "Cache-Control", "value": "public, max-age=86400, stale-while-revalidate=604800" }] }
  ]
}
JSON
printf 'node_modules\n.next\npublic/ort\n.env*\n' > .vercelignore
python3 - <<'PY'
from pathlib import Path
p = Path("next.config.ts")
t = p.read_text()
t = t.replace('import path from "node:path";\n', "")
t = t.replace('turbopack: { root: path.join(process.cwd(), "..") }', "turbopack: { root: process.cwd() }")
t = t.replace('const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:8000";\n', "")
t = t.replace('destination: SERVER_URL + "/:path*"', 'destination: "/api/"')
assert 'destination: "/api/"' in t and "SERVER_URL" not in t, "next.config.ts changed: update deploy/vercel.sh"
p.write_text(t)
PY

# Voice clips: WAV -> MP3 (16 kHz mono), served as static files; /api/tts redirects to them.
"$R/server/.venv/bin/python" - "$R/server/tts_cache/female" "$MP3" <<'PY'
import json, sys
from pathlib import Path
import librosa, soundfile as sf
src, cache = Path(sys.argv[1]), Path(sys.argv[2])
keys = []
for wav in sorted(src.glob("*.wav")):
    if wav.name.endswith(".tmp.wav"):
        continue
    mp3 = cache / (wav.stem + ".mp3")
    if not mp3.exists():
        y, _ = librosa.load(wav, sr=16000)
        sf.write(mp3, y, 16000, format="MP3", subtype="MPEG_LAYER_III", compression_level=0.6)
    keys.append(wav.stem)
Path("api/_server/tts_manifest.json").write_text(json.dumps(keys))
print(len(keys), "voice clips")
PY
for k in $(python3 -c 'import json; print(" ".join(json.load(open("api/_server/tts_manifest.json"))))'); do cp "$MP3/$k.mp3" public/tts/; done
# Fixed phrase text -> clip name, so the app plays them without asking /api/tts first (lib/speech.ts)
(cd "$R/server" && .venv/bin/python - "$D" <<'PY'
import json, sys
from pathlib import Path
import tts
out = Path(sys.argv[1])
made = set(json.loads((out / "api/_server/tts_manifest.json").read_text()))
index = {t: tts.clip_key(t) for t in tts.fixed_phrases() if tts.clip_key(t) in made}
(out / "public/tts/index.json").write_text(json.dumps(index, ensure_ascii=False))
print(len(index), "of", len(tts.fixed_phrases()), "fixed phrases indexed")
PY
)
du -sh public/tts public/models

[ "$1" = "--build" ] && exit 0
[ -d .vercel ] || vercel link --yes --project avtobus-khotoch
vercel deploy --prod --yes
