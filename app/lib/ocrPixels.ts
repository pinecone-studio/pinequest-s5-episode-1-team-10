// Sign reading that does not touch the document, so a worker can run it while the camera keeps detecting.
// The steps match lib/ocr.ts: detect text, split LED words at dark gaps, recognise each word.

const SIGN_H = 320;
const REC_H = 48;
const BIN_THRESH = 0.3;
const BOX_THRESH = 0.5;
const UNCLIP = 1.6;
const GAP_DARK = 0.35;
const GAP_MIN = 0.15;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

interface Region {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface OcrRunner {
  detect: (data: Float32Array, height: number, width: number) => Promise<Float32Array>;
  recognise: (data: Float32Array, width: number) => Promise<{ steps: number; classes: number; data: Float32Array }>;
  keys: string[];
}

function canvasOf(width: number, height: number): OffscreenCanvasRenderingContext2D {
  const canvas = new OffscreenCanvas(width, height);
  return canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
}

function scale(px: Uint8ClampedArray, sw: number, sh: number, w: number, h: number): Uint8ClampedArray {
  const src = canvasOf(sw, sh);
  src.putImageData(new ImageData(new Uint8ClampedArray(px), sw, sh), 0, 0);
  const dst = canvasOf(w, h);
  dst.drawImage(src.canvas, 0, 0, w, h);
  return dst.getImageData(0, 0, w, h).data;
}

function cropOf(px: Uint8ClampedArray, sw: number, x: number, y: number, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * sw + x) * 4;
    out.set(px.subarray(from, from + w * 4), row * w * 4);
  }
  return out;
}

function planarBgr(px: Uint8ClampedArray, n: number, mean: number[], std: number[]): Float32Array {
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = (px[i * 4 + 2] / 255 - mean[0]) / std[0];
    out[n + i] = (px[i * 4 + 1] / 255 - mean[1]) / std[1];
    out[2 * n + i] = (px[i * 4] / 255 - mean[2]) / std[2];
  }
  return out;
}

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
      for (let n = 0; n < next.length; n++) {
        const q = next[n];
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

function splitWords(px: Uint8ClampedArray, sw: number, sh: number, box: Region): Region[] {
  const x1 = Math.max(0, Math.floor(box.x1));
  const y1 = Math.max(0, Math.floor(box.y1));
  const w = Math.min(sw, Math.ceil(box.x2)) - x1;
  const h = Math.min(sh, Math.ceil(box.y2)) - y1;
  if (w < 8 || h < 8) {
    return [box];
  }
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y1 + y) * sw + (x1 + x)) * 4;
      gray[y * w + x] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    }
  }
  const sorted = Array.from(gray).sort(function (a, b) {
    return a - b;
  });
  const bg = sorted[Math.floor((w * h) / 2)];
  const ink = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let m = 0;
    for (let y = 0; y < h; y++) {
      m = Math.max(m, Math.abs(gray[y * w + x] - bg));
    }
    ink[x] = m;
  }
  const inkSorted = Array.from(ink).sort(function (a, b) {
    return a - b;
  });
  const bright = inkSorted[Math.floor(w * 0.9)];
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

function decode(data: Float32Array, steps: number, classes: number, keys: string[]): [string, number] | null {
  let text = "";
  let conf = 0;
  let n = 0;
  let prev = -1;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    let bestP = -1;
    for (let c = 0; c < classes; c++) {
      const v = data[t * classes + c];
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
  return text ? [text, conf / n] : null;
}

export async function recognize(px: Uint8ClampedArray, sw: number, sh: number, run: OcrRunner): Promise<[string, number][]> {
  if (sw < 8 || sh < 8) {
    return [];
  }
  const h = SIGN_H;
  const w = Math.max(32, Math.round((sw * (h / sh)) / 32) * 32);
  const prob = await run.detect(planarBgr(scale(px, sw, sh, w, h), w * h, MEAN, STD), h, w);
  const lines = regions(prob, w, h, sw, sh);
  const boxes: Region[] = [];
  lines.forEach(function (item) {
    splitWords(px, sw, sh, item).forEach(function (word) {
      boxes.push(word);
    });
  });
  const texts: [string, number][] = [];
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const bw = Math.max(1, Math.round(box.x2 - box.x1));
    const bh = Math.max(1, Math.round(box.y2 - box.y1));
    if (bw < 2 || bh < 2) {
      continue;
    }
    const rw = Math.max(8, Math.round((REC_H * bw) / bh));
    const x = Math.max(0, Math.min(sw - 1, Math.floor(box.x1)));
    const y = Math.max(0, Math.min(sh - 1, Math.floor(box.y1)));
    const cw = Math.min(sw - x, bw);
    const ch = Math.min(sh - y, bh);
    const word = cropOf(px, sw, x, y, cw, ch);
    const rec = await run.recognise(planarBgr(scale(word, cw, ch, rw, REC_H), rw * REC_H, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), rw);
    const text = decode(rec.data, rec.steps, rec.classes, run.keys);
    if (text) {
      texts.push(text);
    }
  }
  return texts;
}
