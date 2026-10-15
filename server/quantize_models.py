"""Makes int8 versions of the phone's camera models and checks they give the same answers as fp32.

  python quantize_models.py            # quantize + check, writes app/public/models/*_int8.onnx
  python quantize_models.py --check    # only check the existing *_int8.onnx files

Needs: onnx, onnxruntime, numpy, pillow (not in requirements.txt: the server doesn't use them).
Test photos (private, gitignored) in app/public/test/: tov_nomyn_san_1.png (bus Ч:55),
tov_nomyn_san_2.png (a bus without a 55 sign), cam_720p.png (1280x720 frame of Ч:55).

The pipeline below is a NumPy copy of the browser's (lib/detector.ts, lib/crop.ts, lib/ocr.ts,
lib/doorDetector.ts), so fp32 and int8 are compared on the same inputs the phone would give them.
A model is kept only if it passes every rule in check(); otherwise the phone keeps fp32.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import onnx
import onnx.numpy_helper
import onnx.version_converter
import onnxruntime as ort
from onnxruntime.quantization import (CalibrationDataReader, CalibrationMethod, QuantFormat, QuantType,
                                      quantize_dynamic, quantize_static)
from onnxruntime.quantization.shape_inference import quant_pre_process
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import fusion  # noqa: E402

ROOT = Path(__file__).parent.parent
MODELS = ROOT / "app" / "public" / "models"
TEST = ROOT / "app" / "public" / "test"
PHOTOS = ["tov_nomyn_san_1.png", "tov_nomyn_san_2.png", "cam_720p.png"]
OUR_BUS = {"tov_nomyn_san_1.png": True, "tov_nomyn_san_2.png": False, "cam_720p.png": True}

# Same numbers as the browser code.
DET_SIZE, BUS_CLASS, MIN_SCORE, MASK_CLASSES, MASK_SCORE, NMS_IOU = 640, 5, 0.4, [2, 5, 7], 0.2, 0.5
SIGN_PART, MAX_WIDTH = 0.45, 1600
SIGN_H, REC_H, BIN_THRESH, BOX_THRESH, UNCLIP, GAP_DARK, GAP_MIN = 320, 48, 0.3, 0.5, 1.6, 0.35, 0.15
MEAN, STD = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]
DOOR_SIZE, DOOR_MIN, FRONT_PART, MIN_HEIGHT = 320, 0.15, 0.45, 0.45

# Keep rules (task 5).
IOU_MIN, SCORE_DROP, SIGN_CONF, ROUTE_CONF, DOOR_TOL = 0.9, 0.05, 0.85, 0.8, 0.10

KEYS = ["blank"] + (MODELS / "ocr_keys.txt").read_text(encoding="utf-8").split("\n") + [" "]


def session(path):
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    return ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])


def run(s, x):
    return s.run(None, {s.get_inputs()[0].name: x})


# ---------- bus detector (lib/detector.ts) ----------

def letterbox(img, size, box=None):
    """img region (left, top, w, h) -> size x size grey-padded RGB float tensor, plus scale/pad."""
    left, top, w, h = box if box else (0, 0, img.width, img.height)
    scale = min(size / w, size / h)
    nw, nh = w * scale, h * scale
    pad_x, pad_y = (size - nw) / 2, (size - nh) / 2
    part = img.resize((max(1, round(nw)), max(1, round(nh))), Image.BILINEAR, box=(left, top, left + w, top + h))
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    canvas.paste(part, (round(pad_x), round(pad_y)))
    x = np.asarray(canvas, np.float32).transpose(2, 0, 1)[None] / 255
    return x, scale, pad_x, pad_y


def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0


def nms(boxes):
    kept = []
    for item in sorted(boxes, key=lambda b: -b[4]):
        if all(iou(k, item) <= NMS_IOU for k in kept):
            kept.append(item)
    return kept


def detect(s, img):
    x, scale, pad_x, pad_y = letterbox(img, DET_SIZE)
    v = run(s, x)[0][0]  # [84, N]
    buses, weak = [], []
    for i in range(v.shape[1]):
        mask = max(v[4 + c, i] for c in MASK_CLASSES)
        if mask < MASK_SCORE:
            continue
        w, h = v[2, i] / scale, v[3, i] / scale
        box = [(v[0, i] - pad_x) / scale - w / 2, (v[1, i] - pad_y) / scale - h / 2, w, h]
        if v[4 + BUS_CLASS, i] >= MIN_SCORE:
            buses.append(box + [float(v[4 + BUS_CLASS, i])])
        else:
            weak.append(box + [float(mask)])
    kept = nms(buses)
    others = []
    for item in nms(weak):
        hide = False
        for b in kept:
            o = iou(b, item)
            inside = o * (b[2] * b[3] + item[2] * item[3]) / (1 + o) / (item[2] * item[3])
            if o > NMS_IOU or (inside > 0.8 and item[2] * item[3] > 0.3 * b[2] * b[3]):
                hide = True
        if not hide:
            others.append(item)
    return kept, others


# ---------- sign crop (lib/crop.ts) + reader (lib/ocr.ts) ----------

def sign_crop(img, box, others):
    x, y = max(0, box[0]), max(0, box[1])
    w, h = min(img.width - x, box[2]), min(img.height - y, box[3] * SIGN_PART)
    scale = min(1, MAX_WIDTH / w)
    crop = img.resize((round(w * scale), round(h * scale)), Image.BILINEAR, box=(x, y, x + w, y + h))
    a = np.asarray(crop).copy()
    for o in others:
        x1, y1 = int(max(0, (o[0] - x) * scale)), int(max(0, (o[1] - y) * scale))
        x2, y2 = int((o[0] + o[2] - x) * scale), int((o[1] + o[3] - y) * scale)
        if x2 > x1 and y2 > y1:
            a[y1:y2, x1:x2] = 0
    return Image.fromarray(a)


def planar_bgr(img, mean, std):
    a = np.asarray(img, np.float32)[:, :, ::-1] / 255  # RGB -> BGR
    return ((a - np.array(mean, np.float32)) / np.array(std, np.float32)).transpose(2, 0, 1)[None].astype(np.float32)


def regions(prob, w, h, sw, sh):
    seen = np.zeros((h, w), bool)
    on = prob > BIN_THRESH
    out = []
    for sy, sx in zip(*np.nonzero(on)):
        if seen[sy, sx]:
            continue
        stack, pts = [(sy, sx)], []
        seen[sy, sx] = True
        while stack:
            y, x = stack.pop()
            pts.append((y, x))
            for ny, nx in ((y, x - 1), (y, x + 1), (y - 1, x), (y + 1, x)):
                if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx] and on[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        ys, xs = np.array(pts).T
        x1, x2, y1, y2 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        bw, bh = x2 - x1, y2 - y1
        if prob[ys, xs].mean() < BOX_THRESH or bw < 3 or bh < 3:
            continue
        d = bw * bh * UNCLIP / (2 * (bw + bh))
        out.append([max(0, (x1 - d) / w * sw), max(0, (y1 - d) / h * sh), min(sw, (x2 + d) / w * sw), min(sh, (y2 + d) / h * sh)])
    return out


def split_words(crop, box):
    a = np.asarray(crop, np.float32)
    x1, y1 = max(0, int(np.floor(box[0]))), max(0, int(np.floor(box[1])))
    w, h = min(crop.width, int(np.ceil(box[2]))) - x1, min(crop.height, int(np.ceil(box[3]))) - y1
    if w < 8 or h < 8:
        return [box]
    px = a[y1:y1 + h, x1:x1 + w]
    gray = 0.299 * px[:, :, 0] + 0.587 * px[:, :, 1] + 0.114 * px[:, :, 2]
    bg = np.sort(gray.ravel())[(w * h) // 2]
    ink = np.abs(gray - bg).max(axis=0)
    bright = np.sort(ink)[int(w * 0.9)]
    min_run = max(2, int(GAP_MIN * h))
    cuts, x = [], 0
    while x < w:
        if ink[x] < GAP_DARK * bright:
            end = x
            while end < w and ink[end] < GAP_DARK * bright:
                end += 1
            if end - x >= min_run and x > 0 and end < w:
                cuts.append((x + end) // 2)
            x = end
        else:
            x += 1
    if not cuts:
        return [box]
    edges = [0] + cuts + [w]
    words = [[x1 + edges[i], box[1], x1 + edges[i + 1], box[3]] for i in range(len(edges) - 1) if edges[i + 1] - edges[i] >= 0.3 * h]
    return words or [box]


def read_sign(det, rec, crop):
    sw, sh = crop.size
    h = SIGN_H
    w = max(32, round(sw * (h / sh) / 32) * 32)
    prob = run(det, planar_bgr(crop.resize((w, h), Image.BILINEAR), MEAN, STD))[0][0, 0]
    texts = []
    for line in regions(prob, w, h, sw, sh):
        for b in split_words(crop, line):
            bw, bh = b[2] - b[0], b[3] - b[1]
            if bw < 2 or bh < 2:
                continue
            rw = max(8, round(REC_H * bw / bh))
            word = crop.resize((rw, REC_H), Image.BILINEAR, box=tuple(b))
            p = run(rec, planar_bgr(word, [0.5] * 3, [0.5] * 3))[0][0]
            best, best_p = p.argmax(1), p.max(1)
            text, conf, prev = "", [], -1
            for c, v in zip(best, best_p):
                if c != prev and c != 0:
                    text += KEYS[c] if c < len(KEYS) else ""
                    conf.append(v)
                prev = c
            if text:
                texts.append((text, float(np.mean(conf))))
    return texts


# ---------- front door (lib/doorDetector.ts) ----------

def detect_door(s, img, bus, front_right=True):
    left = max(0, bus[0] + (1 - FRONT_PART) * bus[2] if front_right else bus[0] - 0.05 * bus[2])
    right = min(img.width, bus[0] + 1.05 * bus[2] if front_right else bus[0] + FRONT_PART * bus[2])
    top, bottom = max(0, bus[1]), min(img.height, bus[1] + bus[3])
    x, scale, pad_x, pad_y = letterbox(img, DOOR_SIZE, (left, top, right - left, bottom - top))
    v = run(s, x)[0][0]
    front = bus[0] + bus[2] if front_right else bus[0]
    cands = []
    for i in range(v.shape[1]):
        score = max(v[4, i], v[5, i])
        if score < DOOR_MIN:
            continue
        w, h = v[2, i] / scale, v[3, i] / scale
        cx, cy = (v[0, i] - pad_x) / scale + left, (v[1, i] - pad_y) / scale + top
        if cx < bus[0] or cx > bus[0] + bus[2] or abs(front - cx) / bus[2] > FRONT_PART or h < MIN_HEIGHT * bus[3]:
            continue
        cands.append([cx - w / 2, cy - h / 2, w, h, float(score)])
    if not cands:
        return None
    cands.sort(key=lambda b: -b[4])
    best = cands[0]
    x1, x2 = best[0], best[0] + best[2]
    for item in cands[1:]:
        if item[4] > best[4] * 0.6 and min(x2, item[0] + item[2]) - max(x1, item[0]) > -0.03 * bus[2]:
            x1, x2 = min(x1, item[0]), max(x2, item[0] + item[2])
    return [x1, best[1], x2 - x1, best[3], best[4]]


# ---------- whole pipeline ----------

def pipeline(paths):
    """paths: {'yolo11n': ..., 'ocr_det': ..., 'ocr_rec': ..., 'door': ...} -> outputs per photo + timings."""
    t0 = time.perf_counter()
    s = {k: session(v) for k, v in paths.items()}
    load_ms = (time.perf_counter() - t0) * 1000
    out = {}
    for name in PHOTOS:
        img = Image.open(TEST / name).convert("RGB")
        buses, others = detect(s["yolo11n"], img)
        if not buses:
            out[name] = {"bus": None, "texts": [], "door": None}
            continue
        # The camera reads every tracked bus; the widest is the one in front of the rider.
        bus = max(buses, key=lambda b: b[2])
        masked = others + [b for b in buses if b is not bus]
        texts = read_sign(s["ocr_det"], s["ocr_rec"], sign_crop(img, bus, masked))
        door = detect_door(s["door"], img, bus)
        out[name] = {"bus": [round(float(v), 3) for v in bus], "texts": [(t, round(c, 3)) for t, c in texts],
                     "door": [round(float(v), 3) for v in door] if door else None}
    return out, load_ms


def route_reads(texts):
    """Route-number tokens read at >= 0.8 (fusion's own rule), e.g. {'455': 0.91}."""
    return fusion.candidates(texts)


def verdict(texts):
    """What the phone would say for wanted route Ч:55 at a stop served by Ч:55."""
    return fusion.decide(texts, "Ч:55", ["Ч:55"], city_numbers=set())[0]


def check(model, ref, got):
    """Problems (empty = keep) for one model swapped to int8, others fp32."""
    bad = []
    for name in PHOTOS:
        r, g = ref[name], got[name]
        if model == "yolo11n" and r["bus"]:
            if not g["bus"] or iou(r["bus"], g["bus"]) <= IOU_MIN or r["bus"][4] - g["bus"][4] >= SCORE_DROP:
                bad.append(f"{name}: bus {g['bus']} vs fp32 {r['bus']}")
        if OUR_BUS[name]:
            conf = route_reads(g["texts"]).get("455", 0)
            if conf < SIGN_CONF:
                bad.append(f"{name}: '455' at {conf:.3f} < {SIGN_CONF} ({g['texts']})")
            if verdict(g["texts"]) != "yes":
                bad.append(f"{name}: verdict {verdict(g['texts'])}, not yes")
        else:
            if route_reads(g["texts"]):
                bad.append(f"{name}: route number read {route_reads(g['texts'])}")
            if verdict(g["texts"]) == "yes":
                bad.append(f"{name}: WRONG YES")
        if model == "door" and r["door"]:
            if not g["door"]:
                bad.append(f"{name}: door lost")
            else:
                bw = r["bus"][2]
                shift = max(abs(r["door"][0] - g["door"][0]), abs(r["door"][0] + r["door"][2] - g["door"][0] - g["door"][2])) / bw
                if shift > DOOR_TOL:
                    bad.append(f"{name}: door moved {shift:.0%} of bus width")
        elif model == "door" and not r["door"] and g["door"]:
            bad.append(f"{name}: door appeared where fp32 saw none")
    return bad


# ---------- quantization ----------

class Frames(CalibrationDataReader):
    """Calibration inputs: exactly what each model sees on the test photos (several crops/scales)."""

    def __init__(self, model, fp32):
        det = session(fp32["yolo11n"])
        self.items = []
        for name in PHOTOS:
            img = Image.open(TEST / name).convert("RGB")
            for flip in (False, True):
                im = img.transpose(Image.FLIP_LEFT_RIGHT) if flip else img
                if model == "yolo11n":
                    self.items.append(letterbox(im, DET_SIZE)[0])
                    continue
                buses, others = detect(det, im)
                for bus in buses:
                    if model == "ocr_det":
                        crop = sign_crop(im, bus, others)
                        sw, sh = crop.size
                        w = max(32, round(sw * (SIGN_H / sh) / 32) * 32)
                        self.items.append(planar_bgr(crop.resize((w, SIGN_H), Image.BILINEAR), MEAN, STD))
                    elif model == "door":
                        for fr in (True, False):
                            left = bus[0] + (1 - FRONT_PART) * bus[2] if fr else max(0, bus[0] - 0.05 * bus[2])
                            right = min(im.width, bus[0] + 1.05 * bus[2]) if fr else bus[0] + FRONT_PART * bus[2]
                            top, bottom = max(0, bus[1]), min(im.height, bus[1] + bus[3])
                            self.items.append(letterbox(im, DOOR_SIZE, (max(0, left), top, right - max(0, left), bottom - top))[0])
        self.name = session(fp32[model]).get_inputs()[0].name
        self.it = iter(self.items)

    def get_next(self):
        x = next(self.it, None)
        return {self.name: x} if x is not None else None


def weights_only(src, dst, keep_float=()):
    """int8 weights, float maths: every Conv/MatMul weight becomes int8 (per output channel, symmetric)
    + DequantizeLinear, so the download is ~4x smaller while activations stay fp32 (no calibration, the
    answers barely move). Runs anywhere DequantizeLinear does (onnxruntime-web WASM and WebGPU).
    keep_float: node names left fp32 (YOLO's first conv and detection head: they move the box most)."""
    m = onnx.load(str(src))
    if m.opset_import[0].version < 13:  # per-channel DequantizeLinear needs opset 13
        m = onnx.version_converter.convert_version(m, 13)
    # Paddle exports hold weights in Constant nodes: make them initializers so they can be quantized.
    for n in list(m.graph.node):
        if n.op_type == "Constant" and n.attribute and n.attribute[0].name == "value":
            t = onnx.numpy_helper.to_array(n.attribute[0].t)
            m.graph.initializer.append(onnx.numpy_helper.from_array(t, n.output[0]))
            m.graph.node.remove(n)
    inits = {i.name: i for i in m.graph.initializer}
    users = {}
    for n in m.graph.node:
        for i in n.input:
            users.setdefault(i, []).append(n)
    new_nodes = []
    for n in m.graph.node:
        if n.op_type not in ("Conv", "ConvTranspose", "MatMul") or len(n.input) < 2 or n.input[1] not in inits or n.name in keep_float:
            continue
        name = n.input[1]
        w = onnx.numpy_helper.to_array(inits[name]).astype(np.float32)
        if w.size < 1024 or len(users[name]) != 1:
            continue
        # Output channel: axis 0 for Conv, 1 for ConvTranspose and MatMul (K x N).
        axis = 0 if n.op_type == "Conv" else 1
        red = tuple(a for a in range(w.ndim) if a != axis)
        scale = np.abs(w).max(axis=red) / 127
        scale[scale == 0] = 1
        shape = [1] * w.ndim
        shape[axis] = -1
        q = np.clip(np.round(w / scale.reshape(shape)), -127, 127).astype(np.int8)
        m.graph.initializer.remove(inits[name])
        m.graph.initializer.extend([onnx.numpy_helper.from_array(q, name + "_q"),
                                    onnx.numpy_helper.from_array(scale.astype(np.float32), name + "_s"),
                                    onnx.numpy_helper.from_array(np.zeros_like(scale, np.int8), name + "_z")])
        new_nodes.append(onnx.helper.make_node("DequantizeLinear", [name + "_q", name + "_s", name + "_z"], [name],
                                               name=name + "_dq", axis=axis))
    # DequantizeLinear nodes first: their outputs feed the Conv/MatMul nodes (topological order).
    nodes = new_nodes + list(m.graph.node)
    del m.graph.node[:]
    m.graph.node.extend(nodes)
    onnx.checker.check_model(m)
    onnx.save(m, str(dst))


def quantize(model, fp32, method):
    src, dst = fp32[model], MODELS / f"{model}_int8.onnx"
    if method == "weights":
        weights_only(src, dst)
        return dst
    if method == "weights_head":
        m = onnx.load(str(src))
        convs = [n.name for n in m.graph.node if n.op_type == "Conv"]
        weights_only(src, dst, keep_float=set(convs[:1] + head_nodes(m)))
        return dst
    pre = MODELS / f"_{model}_pre.onnx"
    up = MODELS / f"_{model}_op13.onnx"
    m = onnx.load(str(src))
    if m.opset_import[0].version < 13:  # per-channel QDQ needs opset 13 (Paddle exports are 12)
        onnx.save(onnx.version_converter.convert_version(m, 13), str(up))
        src = up
    try:
        quant_pre_process(str(src), str(pre), skip_symbolic_shape=model.startswith("ocr"))
    except Exception as e:  # noqa: BLE001
        print("  pre-process skipped:", e)
        pre.write_bytes(src.read_bytes())
    up.unlink(missing_ok=True)
    try:
        if method == "dynamic":
            quantize_dynamic(str(pre), str(dst), weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul"])
        else:
            # QDQ, int8 weights per channel; the final box/score head (Concat/Sigmoid at the end of
            # YOLO) is left in float: quantizing it shifts boxes and scores.
            exclude = tail_nodes(pre) if model in ("yolo11n", "door") else []
            quantize_static(str(pre), str(dst), Frames(model, fp32), quant_format=QuantFormat.QDQ,
                            activation_type=QuantType.QUInt8, weight_type=QuantType.QInt8, per_channel=True,
                            calibrate_method=CalibrationMethod.MinMax, nodes_to_exclude=exclude,
                            extra_options={"ActivationSymmetric": False, "WeightSymmetric": True})
    finally:
        pre.unlink(missing_ok=True)
    return dst


def head_nodes(m):
    """Names of the nodes in YOLO's detection head (the last /model.N/ module)."""
    names = [n.name for n in m.graph.node]
    head = max({n.split("/")[1] for n in names if n.startswith("/model.")}, key=lambda s: int(s.split(".")[1]))
    return [n for n in names if n.startswith(f"/{head}/")]


def tail_nodes(path):
    """YOLO's decode head: every node after the last Conv of the detection branches (/model.23/...
    for yolo11n, last module for YOLOE) — box decoding, DFL softmax, sigmoid, concat."""
    m = onnx.load(str(path))
    ops = {n.name: n.op_type for n in m.graph.node}
    return [n for n in head_nodes(m) if ops[n] != "Conv"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="only check existing *_int8.onnx")
    ap.add_argument("--report", default=str(Path(__file__).parent / "quantize_report.json"))
    args = ap.parse_args()
    for name in PHOTOS:
        if not (TEST / name).exists():
            sys.exit(f"missing test photo {TEST / name}")
    fp32 = {m: MODELS / f"{m}.onnx" for m in ("yolo11n", "ocr_det", "ocr_rec", "door")}
    # Tried in order; the first that passes every rule is kept (smallest first). ocr_rec: weights-only
    # int8 (~2.8 MB, Conv + MatMul) is tried before the dynamic MatMul-only one (7.8 MB).
    methods = {"yolo11n": ["static", "weights", "weights_head"], "ocr_det": ["static", "weights"],
               "ocr_rec": ["weights", "dynamic"], "door": ["static", "weights"]}
    ref, ref_ms = pipeline(fp32)
    report = {"fp32": {"outputs": ref, "load_ms": round(ref_ms)}, "models": {}}
    print("fp32:", json.dumps(ref, ensure_ascii=False))
    for model, tries in methods.items():
        dst = MODELS / f"{model}_int8.onnx"
        report["models"][model] = {"fp32_bytes": fp32[model].stat().st_size, "keep": False, "tries": {}}
        for method in ([None] if args.check else tries):
            print(f"\n{model} ({method or 'existing'})")
            if method:
                quantize(model, fp32, method)
            if not dst.exists():
                break
            got, _ = pipeline(dict(fp32, **{model: dst}))
            bad = check(model, ref, got)
            size = dst.stat().st_size
            print(f"  {fp32[model].stat().st_size / 1e6:.1f} MB -> {size / 1e6:.1f} MB; {'KEEP' if not bad else 'REJECT'}")
            for b in bad:
                print("   -", b)
            report["models"][model]["tries"][method or "existing"] = {"int8_bytes": size, "problems": bad, "outputs": got}
            if not bad:
                report["models"][model].update(keep=True, method=method or "existing", int8_bytes=size)
                break
        if not report["models"][model]["keep"]:
            dst.unlink(missing_ok=True)  # nothing passed: the phone keeps fp32
    # All kept int8 models together, as the phone runs them.
    kept = {m: MODELS / f"{m}_int8.onnx" for m, r in report["models"].items() if r["keep"]}
    got, _ = pipeline(dict(fp32, **kept))
    bad = [p for m in kept for p in check(m, ref, got)]
    print(f"\ntogether ({', '.join(kept)}): {'PASS' if not bad else 'FAIL'}")
    for b in bad:
        print("   -", b)
    report["together"] = {"models": list(kept), "problems": bad, "outputs": got}
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\nreport:", args.report)


if __name__ == "__main__":
    main()
