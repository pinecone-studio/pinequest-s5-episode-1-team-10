"""Pre-make TTS clips so riders never wait for them (~16 s each on an M4; safe to stop and rerun).

The server already does this in the background at startup; use this script with the server
stopped (two TTS processes on one GPU slow each other down ~5x), e.g. before a deploy.

  set -a && . ../.env && set +a
  .venv/bin/python make_speech.py            # fixed phrases + "take"/"found" phrase for every route
  .venv/bin/python make_speech.py --fixed    # fixed phrases only
"""
import sys
import time

import planner
import tts


def main():
    texts = tts.fixed_phrases() + ([] if "--fixed" in sys.argv else planner.route_phrases())
    todo = [t for t in texts if not tts.is_cached(t)]
    print(f"{len(texts)} clips, {len(todo)} to make")
    start = time.time()
    for i, t in enumerate(todo, 1):
        tts.synthesize(t, live=False)
        left = (time.time() - start) / i * (len(todo) - i)
        print(f"[{i}/{len(todo)}] {t}  (~{left / 60:.0f} min left)", flush=True)


if __name__ == "__main__":
    main()
