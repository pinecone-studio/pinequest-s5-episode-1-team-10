// Reads the route sign on the phone (free hosting has no OCR server): PaddleOCR PP-OCRv4 mobile models
// in ONNX (from RapidOCR, Apache-2.0), run with the same onnxruntime as the bus detector.
//   1. text detection (DB): probability map at SIGN_H px high -> connected regions -> boxes
//   2. text recognition (CTC) on each box -> text + confidence
// Ported 1:1 from a NumPy prototype checked on tov_nomyn_san_{1,2}.png: photo 1 reads
// "455 H 1000-E" (0.91), photo 2 has no route number -- the same verdicts as the server's PaddleOCR.
// Channels go in BGR order, like the OpenCV images the models were trained on.
import type * as Ort from "onnxruntime-web";
import { exclusive, modelBytes, runtime } from "./detector";

const DET_URL = "/models/ocr_det.onnx";
const REC_URL = "/models/ocr_rec.onnx";
const KEYS_URL = "/models/ocr_keys.txt";
const SIGN_H = 320; // detection height (a multiple of 32); measured: same reads as 480-640, 2-4x faster
const REC_H = 48;
const BIN_THRESH = 0.3; // DB: pixel is text
const BOX_THRESH = 0.5; // DB: mean probability of a region to keep it
const UNCLIP = 1.6; // DB: grow each region by area * UNCLIP / perimeter
// Words: the text model's map is solid across a whole sign line, so "455 ЭЙН 1000-Е" came out as one
// read, and with Cyrillic Э read as "3" the route number was lost ("4553H1000-E"). A line is split at
// columns much darker than its lit ones (the space between LED words), and each word is read alone.
// Measured on the sign: word gap ~35 brightness, gaps inside a number ~80-95, lit LEDs 120-200.
const GAP_DARK = 0.35; // a column darker than this share of the line's bright columns is a gap
const GAP_MIN = 0.15; // ...and a gap at least this share of the line height separates words
const MEAN = [0.485, 0.456, 0.406]; // B, G, R
const STD = [0.229, 0.224, 0.225];

let det: Ort.InferenceSession | null = null;
let rec: Ort.InferenceSession | null = null;
let keys: string[] = [];
let loading: Promise<boolean> | null = null;

// Loads once (15 MB); resolves false if it can't (then the camera just says "not sure").
export function loadOcr(): Promise<boolean> {
  if (!loading) {
    loading = (async function () {
      const [rt, detBytes, recBytes, text] = await Promise.all([
        runtime(),
        modelBytes(DET_URL),
        modelBytes(REC_URL),
        fetch(KEYS_URL).then(function (item) {
          return item.text();
        }),
      ]);
      keys = ["blank"].concat(text.split("\n"), [" "]);
      det = await exclusive(function () {
        return rt.ort.InferenceSession.create(detBytes, { executionProviders: rt.providers });
      });
      rec = await exclusive(function () {
        return rt.ort.InferenceSession.create(recBytes, { executionProviders: rt.providers });
      });
      return true;
    })().catch(function (e) {
      loading = null;
      console.warn("sign reading not available", e);
      return false;
    });
  }
  return loading;
}

function scaled(source: HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number, w: number, h: number): Uint8ClampedArray {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

// RGBA pixels -> planar BGR float tensor data, normalised per channel.
function planarBgr(px: Uint8ClampedArray, n: number, mean: number[], std: number[]): Float32Array {
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = (px[i * 4 + 2] / 255 - mean[0]) / std[0];
    out[n + i] = (px[i * 4 + 1] / 255 - mean[1]) / std[1];
    out[2 * n + i] = (px[i * 4] / 255 - mean[2]) / std[2];
  }
  return out;
}

interface Region {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// Text regions in the probability map (W x H), as boxes in source pixels.
function regions(prob: Float32Array, w: number, h: number, sw: number, sh: number): Region[] {
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const out: Region[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || prob[start] <= BIN_THRESH) {
      continue;
    }
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let sum = 0;
    let x1 = w;
    let y1 = h;
    let x2 = 0;
    let y2 = 0;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      const y = (p - x) / w;
      sum += prob[p];
      x1 = Math.min(x1, x);
      x2 = Math.max(x2, x + 1);
      y1 = Math.min(y1, y);
      y2 = Math.max(y2, y + 1);
      const next = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of next) {
        if (q >= 0 && !seen[q] && prob[q] > BIN_THRESH) {
          seen[q] = 1;
          queue[tail++] = q;
        }
      }
    }
    const bw = x2 - x1;
    const bh = y2 - y1;
    if (sum / tail < BOX_THRESH || bw < 3 || bh < 3) {
      continue;
    }
    const d = (bw * bh * UNCLIP) / (2 * (bw + bh));
    out.push({
      x1: Math.max(0, ((x1 - d) / w) * sw),
      y1: Math.max(0, ((y1 - d) / h) * sh),
      x2: Math.min(sw, ((x2 + d) / w) * sw),
      y2: Math.min(sh, ((y2 + d) / h) * sh),
    });
  }
  return out;
}

// One text line -> its words (or the line itself when it has no clear gaps).
function splitWords(crop: HTMLCanvasElement, box: Region): Region[] {
  const x1 = Math.max(0, Math.floor(box.x1));
  const y1 = Math.max(0, Math.floor(box.y1));
  const w = Math.min(crop.width, Math.ceil(box.x2)) - x1;
  const h = Math.min(crop.height, Math.ceil(box.y2)) - y1;
  if (w < 8 || h < 8) {
    return [box];
  }
  const ctx = crop.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  const px = ctx.getImageData(x1, y1, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  }
  const bg = Float32Array.from(gray).sort()[Math.floor((w * h) / 2)]; // the sign's background
  const ink = new Float32Array(w); // per column: the strongest difference from the background
  for (let x = 0; x < w; x++) {
    let m = 0;
    for (let y = 0; y < h; y++) {
      m = Math.max(m, Math.abs(gray[y * w + x] - bg));
    }
    ink[x] = m;
  }
  const bright = Float32Array.from(ink).sort()[Math.floor(w * 0.9)];
  const minRun = Math.max(2, Math.floor(GAP_MIN * h));
  const cuts: number[] = [];
  let x = 0;
  while (x < w) {
    if (ink[x] < GAP_DARK * bright) {
      let end = x;
      while (end < w && ink[end] < GAP_DARK * bright) {
        end++;
      }
      if (end - x >= minRun && x > 0 && end < w) {
        cuts.push(Math.floor((x + end) / 2));
      }
      x = end;
    } else {
      x++;
    }
  }
  if (!cuts.length) {
    return [box];
  }
  const edges = [0].concat(cuts, [w]);
  const words: Region[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    if (edges[i + 1] - edges[i] >= 0.3 * h) {
      words.push({ x1: x1 + edges[i], y1: box.y1, x2: x1 + edges[i + 1], y2: box.y2 });
    }
  }
  return words.length ? words : [box];
}

// [(text, confidence)] read on the sign crop; [] if the models aren't loaded.
export async function readSign(crop: HTMLCanvasElement): Promise<[string, number][]> {
  if (!(await loadOcr()) || !det || !rec) {
    return [];
  }
  const { ort } = await runtime();
  const sw = crop.width;
  const sh = crop.height;
  const h = SIGN_H;
  const w = Math.max(32, Math.round((sw * (h / sh)) / 32) * 32);
  const detInput = new ort.Tensor("float32", planarBgr(scaled(crop, 0, 0, sw, sh, w, h), w * h, MEAN, STD), [1, 3, h, w]);
  const d = det;
  const detOut = await exclusive(function () {
    return d.run({ [d.inputNames[0]]: detInput });
  });
  const prob = detOut[d.outputNames[0]].data as Float32Array;
  const texts: [string, number][] = [];
  const lines = regions(prob, w, h, sw, sh);
  const boxes = lines.flatMap(function (item) {
    return splitWords(crop, item);
  });
  for (const box of boxes) {
    const bw = box.x2 - box.x1;
    const bh = box.y2 - box.y1;
    if (bw < 2 || bh < 2) {
      continue;
    }
    const rw = Math.max(8, Math.round((REC_H * bw) / bh));
    const recInput = new ort.Tensor("float32", planarBgr(scaled(crop, box.x1, box.y1, bw, bh, rw, REC_H), rw * REC_H, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), [1, 3, REC_H, rw]);
    const r = rec;
    const recOut = await exclusive(function () {
      return r.run({ [r.inputNames[0]]: recInput });
    });
    const out = recOut[r.outputNames[0]];
    const steps = out.dims[1];
    const classes = out.dims[2];
    const p = out.data as Float32Array;
    // CTC: best class per step, repeats and blanks dropped.
    let text = "";
    let conf = 0;
    let n = 0;
    let prev = -1;
    for (let t = 0; t < steps; t++) {
      let best = 0;
      let bestP = -1;
      for (let c = 0; c < classes; c++) {
        const v = p[t * classes + c];
        if (v > bestP) {
          bestP = v;
          best = c;
        }
      }
      if (best !== prev && best !== 0) {
        text += keys[best] ?? "";
        conf += bestP;
        n++;
      }
      prev = best;
    }
    if (text) {
      texts.push([text, conf / n]);
    }
  }
  return texts;
}
