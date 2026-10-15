"""Builds the reader's model files (app/public/models/reader/), reproducibly.

  rec_cyrillic.onnx, rec_cyrillic_keys.txt   PaddleOCR cyrillic_PP-OCRv5_mobile_rec (Apache-2.0), as published
  voice_mn.onnx, voice_mn.pack               Meta MMS-TTS "mon" (facebook/mms-tts-mon, CC-BY-NC-4.0)

The voice is exported to ONNX (input_ids [1, L] int64 -> waveform [1, samples] float32, 16 kHz) and its
weights are packed 114 MB -> 35 MB: int8 per row for the decoder and flow, fp16 for the text encoder and
duration predictor (measured: log-mel difference 0.02-0.04, while two runs of the model itself differ by
0.5). The app rebuilds the fp32 weights (lib/reader/voiceModel.ts) and passes them to onnxruntime as
external data "voice_mn.weights", so it computes exactly the exported graph.

Run with the server venv plus onnx (not a server dependency):
  server/.venv/bin/python -m pip install onnx      (or: PYTHONPATH=<dir with onnx> ...)
  server/.venv/bin/python deploy/reader_models.py
"""
import json
import struct
import sys
import urllib.request
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent.parent / "app" / "public" / "models" / "reader"
WORK = Path(__file__).resolve().parent / "reader_work"
REC = "https://huggingface.co/PaddlePaddle/cyrillic_PP-OCRv5_mobile_rec_onnx/resolve/main/"
MMS = "https://huggingface.co/facebook/mms-tts-mon/resolve/main/"
NAME = "voice_mn"


def fetch(url, path):
    if not path.exists():
        print("download", url)
        req = urllib.request.Request(url, headers={"User-Agent": "team10-reader-build"})
        path.write_bytes(urllib.request.urlopen(req, timeout=600).read())
    return path


def ocr():
    import yaml

    fetch(REC + "inference.onnx", OUT / "rec_cyrillic.onnx")
    spec = yaml.safe_load(fetch(REC + "inference.yml", WORK / "rec.yml").read_text(encoding="utf-8"))
    keys = spec["PostProcess"]["character_dict"]
    assert all(c in keys for c in "өүӨҮёЁ"), "the dictionary lost Mongolian letters"
    (OUT / "rec_cyrillic_keys.txt").write_text("\n".join(keys), encoding="utf-8")


def export_voice():
    import torch
    from transformers import VitsModel

    src = WORK / "mms"
    src.mkdir(parents=True, exist_ok=True)
    for f in ("config.json", "vocab.json", "tokenizer_config.json", "special_tokens_map.json", "model.safetensors"):
        fetch(MMS + f, src / f)
    model = VitsModel.from_pretrained(src).eval()

    class Wrapper(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, input_ids):
            return self.m(input_ids=input_ids).waveform

    ids = torch.tensor([[0, 3, 0, 1, 0, 7, 0, 3, 0, 63, 0, 16, 0, 1, 0, 12, 0, 3, 0, 1, 0]], dtype=torch.long)
    full = WORK / "voice_full.onnx"
    with torch.no_grad():
        torch.onnx.export(Wrapper(model).eval(), (ids,), full, input_names=["input_ids"], output_names=["waveform"],
                          dynamic_axes={"input_ids": {1: "text"}, "waveform": {1: "samples"}},
                          opset_version=17, dynamo=False, do_constant_folding=True)
    return full


def pack_voice(full):
    import onnx
    from onnx import TensorProto, numpy_helper

    m = onnx.load(full)
    consumers = {}
    for n in m.graph.node:
        for i in n.input:
            consumers.setdefault(i, []).append(n)
    int8_parts = ("/m/decoder/", "/m/flow/")
    entries, chunks, layout, data = [], [], 0, 0
    for init in m.graph.initializer:
        if init.data_type != TensorProto.FLOAT:
            continue
        arr = numpy_helper.to_array(init).astype(np.float32)
        if arr.size < 1024:
            continue
        users = consumers.get(init.name, [])
        if users and arr.ndim >= 2 and all(u.name.startswith(int8_parts) and u.op_type in ("Conv", "ConvTranspose", "MatMul") for u in users):
            rows = arr.reshape(arr.shape[0], -1)
            scale = np.maximum(np.abs(rows).max(axis=1), 1e-12) / 127.0
            q = np.clip(np.round(rows / scale[:, None]), -127, 127).astype(np.int8)
            payload, extra = scale.astype(np.float32).tobytes() + q.tobytes(), {"kind": "i8", "rows": int(rows.shape[0])}
        else:
            payload, extra = arr.astype(np.float16).tobytes(), {"kind": "f16"}
        pad = (-len(payload)) % 4
        chunks.append(payload + b"\0" * pad)
        entries.append({**extra, "count": int(arr.size), "data": data, "bytes": len(payload), "at": layout})
        init.ClearField("raw_data")
        del init.float_data[:]
        init.data_location = TensorProto.EXTERNAL
        del init.external_data[:]
        for k, v in (("location", NAME + ".weights"), ("offset", str(layout)), ("length", str(arr.size * 4))):
            e = init.external_data.add()
            e.key, e.value = k, v
        layout += arr.size * 4
        data += len(payload) + pad
    onnx.save(m, OUT / (NAME + ".onnx"))
    header = json.dumps({"format": 1, "weights": NAME + ".weights", "size": layout, "tensors": entries}).encode()
    with open(OUT / (NAME + ".pack"), "wb") as f:
        f.write(b"WPK1" + struct.pack("<I", len(header)) + header + b"\0" * ((-(8 + len(header))) % 4))
        for c in chunks:
            f.write(c)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    ocr()
    if "--ocr-only" not in sys.argv:
        pack_voice(export_voice())
    for f in sorted(OUT.iterdir()):
        print(f"{f.stat().st_size / 1e6:7.1f} MB  {f.name}")
