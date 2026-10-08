"""Mongolian speech -> text with a Mongolian fine-tune of Whisper large-v3 turbo.

Default model: huggingface.co/Blgn94/whisper-large-v3-turbo-mn-lora (Apache 2.0, CER ~11%).
Set STT_MODEL to try another Whisper fine-tune (e.g. BuzzASR/mongolian: more accurate, slower).

Measured on an M4 with the GPU otherwise idle: ~1.2 s for a 1.5-5 s phrase in float32.
Half precision is unstable on MPS: float16 and bfloat16 with SDPA attention randomly output
"!!!!" (bfloat16 + eager attention works but is only ~0.1 s faster), so float32 it is.
"""
import io
import os
from functools import cache

import numpy as np

import gpu

MODEL_ID = os.environ.get("STT_MODEL", "Blgn94/whisper-large-v3-turbo-mn-lora")
RATE = 16000
MAX_SECONDS = 10  # a destination is a few words
TOKENS_PER_SECOND = 8  # cap on output length: stops runaway repeats ("хүн хүн хүн…") early


@cache
def _model():
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    dtype = torch.float32
    processor = WhisperProcessor.from_pretrained(MODEL_ID, language="mongolian", task="transcribe")
    model = WhisperForConditionalGeneration.from_pretrained(MODEL_ID, dtype=dtype).to(device).eval()
    return processor, model, device, dtype


def load_audio(data):
    """WAV/FLAC/OGG bytes -> mono float32 at 16 kHz, at most MAX_SECONDS."""
    import soundfile as sf

    audio, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if rate != RATE:
        import librosa

        audio = librosa.resample(audio, orig_sr=rate, target_sr=RATE)
    return audio[: RATE * MAX_SECONDS]


def transcribe(audio):
    """What was said, as Cyrillic text ('' for silence)."""
    import torch

    if len(audio) < RATE * 0.3 or float(np.abs(audio).max()) < 0.01:
        return ""
    processor, model, device, dtype = _model()
    feats = processor.feature_extractor(audio, sampling_rate=RATE, return_tensors="pt").input_features
    with gpu.use(gpu.SPEECH_IN), torch.no_grad():
        ids = model.generate(feats.to(device, dtype), language="mongolian", task="transcribe",
                             max_new_tokens=int(6 + TOKENS_PER_SECOND * len(audio) / RATE))
    try:
        return processor.batch_decode(ids, skip_special_tokens=True)[0].strip()
    except OverflowError:  # garbage token ids: treat as not heard rather than crash
        return ""


def warm():
    """Load the model and run it once so the first rider doesn't wait (~10 s)."""
    t = np.linspace(0, 1, RATE, dtype=np.float32)
    transcribe(0.1 * np.sin(2 * np.pi * 220 * t))
