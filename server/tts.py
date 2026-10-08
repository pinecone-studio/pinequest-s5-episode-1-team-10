"""Mongolian speech with OronTTS (F5-TTS finetune, huggingface.co/btsee/oron-tts, CC BY 4.0).

Slow: ~0.55 s per step on an M4 (MPS) whatever the sentence length, because the 6 s reference
voice clip is part of every generation. So every clip is cached as a WAV by its text:
fixed phrases (shared/phrases.json) are made in the background at startup, per-route phrases by
make_speech.py, and only stop names are made live, with fewer steps.
"""
import hashlib
import json
import os
import re
import threading
from functools import cache
from pathlib import Path

import gpu

CACHE_DIR = Path(__file__).parent / "tts_cache"
PHRASES = Path(__file__).parent.parent / "shared" / "phrases.json"
VOICE = os.environ.get("TTS_VOICE", "female")  # "female" or "male"
REPO = "btsee/oron-tts"
MAX_CHARS = 300
STEPS = int(os.environ.get("TTS_STEPS", "32"))  # background clips: model card quality, ~16 s each
LIVE_STEPS = int(os.environ.get("TTS_LIVE_STEPS", "16"))  # a rider is waiting: ~8 s each



@cache
def _model():
    from f5_tts.api import F5TTS
    from huggingface_hub import hf_hub_download

    ckpt = hf_hub_download(REPO, "model.safetensors")
    vocab = hf_hub_download(REPO, "vocab.txt")
    ref = hf_hub_download(REPO, f"voices/{VOICE}.wav")
    ref_text = Path(hf_hub_download(REPO, f"voices/{VOICE}.txt")).read_text(encoding="utf-8").strip()
    # use_ema=False: the EMA weights speak fluent non-words (model card).
    return F5TTS(model="F5TTS_v1_Base", ckpt_file=ckpt, vocab_file=vocab, use_ema=False), ref, ref_text


@cache
def _normalizer():
    from oron_tts.text import MongolianNormalizer

    return MongolianNormalizer()


def speakable(text):
    """Text the model can read. Anything outside its vocabulary would silently become a space."""
    text = re.sub(r"[/\\|_*#\"«»“”]", " ", text)
    text = " ".join(text.split())[:MAX_CHARS]
    try:
        return _normalizer().normalize(text, strict=True)
    except ValueError:
        return _normalizer().normalize(text)


def _path(spoken):
    return CACHE_DIR / VOICE / (hashlib.sha1(spoken.encode()).hexdigest()[:20] + ".wav")


def is_cached(text):
    return _path(speakable(text)).exists()


def synthesize(text, live=True):
    """WAV file path for text, made once and then served from the cache."""
    spoken = speakable(text)
    if not spoken.strip():
        raise ValueError("nothing to say")
    path = _path(spoken)
    if path.exists():
        return path
    import soundfile as sf

    with gpu.use(gpu.LIVE_TTS if live else gpu.BACKGROUND):
        if path.exists():  # made by another request while we waited
            return path
        model, ref, ref_text = _model()
        wav, sr, _ = model.infer(ref_file=ref, ref_text=ref_text, gen_text=spoken,
                                 nfe_step=LIVE_STEPS if live else STEPS, cfg_strength=2.0,
                                 sway_sampling_coef=-1.0, seed=0, show_info=lambda *a: None)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp.wav")
        sf.write(tmp, wav, sr)
        tmp.replace(path)
    return path


def fixed_phrases():
    return list(json.loads(PHRASES.read_text(encoding="utf-8")).values())


def prefetch(texts, live=False):
    """Make clips ahead of time; failures are skipped so one bad text can't stop the rest."""
    for t in texts:
        try:
            synthesize(t, live=live)
        except Exception as e:  # noqa: BLE001 - background warm-up, never fatal
            print(f"tts prefetch failed for {t!r}: {e}")


def prefetch_in_background(texts, live=False):
    """live=True: a rider will ask for these within seconds, so make them fast and before other background work."""
    threading.Thread(target=prefetch, args=(list(texts), live), daemon=True).start()
