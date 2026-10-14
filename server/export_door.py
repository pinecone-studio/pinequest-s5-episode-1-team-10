"""Builds app/public/models/door.onnx: YOLOE-11s (open-vocabulary YOLO) with the text prompts baked in,
so the phone finds bus doors without a trained door class. Run once (downloads ~30 MB of weights):

  cd server && .venv/bin/python export_door.py
"""
import shutil
from pathlib import Path

from ultralytics import YOLOE

PROMPTS = ["bus door", "entrance door"]  # "door" alone scored lower on tov_nomyn_san_*.png
OUT = Path(__file__).parent.parent / "app" / "public" / "models" / "door.onnx"

model = YOLOE("yoloe-11s-seg.pt")
model.set_classes(PROMPTS, model.get_text_pe(PROMPTS))
onnx = model.export(format="onnx", imgsz=320, simplify=True, opset=17)  # 320: it only sees the bus's front end
shutil.copy(onnx, OUT)
print("saved", OUT)
