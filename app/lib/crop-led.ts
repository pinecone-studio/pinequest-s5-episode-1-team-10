// Finds lit LED route signs in a camera frame without any model: pixels in LED colours on a 320 px copy,
// letters joined into lines, wide boxes kept, and the 2 largest cut from the full-resolution frame.
// No route number read for 2 s: one whole frame (1280 px wide), so a sign in another colour, or a bus
// sign next to brighter coloured boards (a yellow advert, a red shop name: they win the 2 largest), is
// still read. Measured on test photo 1: the 2 crops were an advert and "Plaza", never the bus sign;
// Azure on the whole frame read "455 КИЙН 1000-Е" (Ч:55).
import type { Box } from "./box.ts";

const SMALL_W = 320;
const FALLBACK_MS = 2000;
const FULL_W = 1280; // a whole frame is the backup read: it must read on the first try (960 px / q 0.5 made "455" unsure)
const MAX_CROPS = 2;
const PAD = 0.15; // of the box width / height, on each side
const MIN_ASPECT = 2.0; // a sign line is wide; lamps and traffic lights are round
const MIN_LIT = 8; // lit pixels (at 320 px) for a box to count
const JOIN_X = 2; // px at 320: LED letters and dots a little apart become one line
const JOIN_Y = 1;
const MIN_SIDE = 64; // crops are scaled up to at least this (the reader needs >= 50 x 50 px)
const MAX_SCALE = 4;
const ROUND = 16; // canvas sizes rounded up so the next frames reuse it (iPhone canvas memory)

export interface LedCrop {
  canvas: HTMLCanvasElement; // reused on the next call: encode it before then
  box: Box; // where it is in the full-resolution frame
  kind: "led" | "frame";
}

export interface LedCropper {
  next(video: HTMLVideoElement, now: number): LedCrop[];
  routeRead(now: number): void; // a route number was read: whole frames wait again
  frameSent(now: number): void; // the due whole frame was sent (until then it stays due: a frame skipped
  // for the call budget must not lose its turn to the LED crops)
}

// Red / amber (hue 0-45 and 330-360) or green (90-160), saturation > 0.4, brightness > 0.5.
export function isLedColor(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max <= 127.5 || max === 0 || (max - min) / max <= 0.4) {
    return false;
  }
  const d = max - min;
  let hue: number;
  if (max === r) {
    hue = 60 * (((g - b) / d + 6) % 6);
  } else if (max === g) {
    hue = 60 * ((b - r) / d + 2);
  } else {
    hue = 60 * ((r - g) / d + 4);
  }
  return hue <= 45 || hue >= 330 || (hue >= 90 && hue <= 160);
}

function grow(mask: Uint8Array, w: number, h: number): Uint8Array {
  const wide = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        for (let dx = Math.max(0, x - JOIN_X); dx <= Math.min(w - 1, x + JOIN_X); dx++) {
          wide[y * w + dx] = 1;
        }
      }
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (wide[y * w + x]) {
        for (let dy = Math.max(0, y - JOIN_Y); dy <= Math.min(h - 1, y + JOIN_Y); dy++) {
          out[dy * w + x] = 1;
        }
      }
    }
  }
  return out;
}

// Wide boxes of LED-coloured pixels in an RGBA image, largest first, in that image's pixels.
export function ledBoxes(rgba: Uint8ClampedArray, w: number, h: number): Box[] {
  const lit = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lit[i] = isLedColor(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) ? 1 : 0;
  }
  const joined = grow(lit, w, h);
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const boxes: Box[] = [];
  function visit(at: number): void {
    if (joined[at] && !seen[at]) {
      seen[at] = 1;
      stack.push(at);
    }
  }
  for (let start = 0; start < w * h; start++) {
    if (!joined[start] || seen[start]) {
      continue;
    }
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    let count = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const at = stack.pop() as number;
      const x = at % w;
      const y = (at - x) / w;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      count += lit[at];
      if (x > 0) {
        visit(at - 1);
      }
      if (x < w - 1) {
        visit(at + 1);
      }
      if (y > 0) {
        visit(at - w);
      }
      if (y < h - 1) {
        visit(at + w);
      }
    }
    // Undo the joining margin, which widened every box by JOIN_X / JOIN_Y on each side.
    const bx = Math.min(x0 + JOIN_X, x1);
    const by = Math.min(y0 + JOIN_Y, y1);
    const bw = Math.max(1, x1 - x0 + 1 - 2 * JOIN_X);
    const bh = Math.max(1, y1 - y0 + 1 - 2 * JOIN_Y);
    if (count >= MIN_LIT && bw / bh > MIN_ASPECT) {
      boxes.push({ x: bx, y: by, w: bw, h: bh, score: count / (bw * bh) });
    }
  }
  return boxes.sort(function (a, b) {
    return b.w * b.h - a.w * a.h;
  });
}

function roundUp(n: number): number {
  return Math.ceil(n / ROUND) * ROUND;
}

function sized(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return canvas.getContext("2d") as CanvasRenderingContext2D;
}

type Source = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;

function cut(src: Source, box: Box, into: HTMLCanvasElement): LedCrop {
  const scale = Math.min(MAX_SCALE, Math.max(1, MIN_SIDE / Math.min(box.w, box.h)));
  const ctx = sized(into, roundUp(box.w * scale), roundUp(box.h * scale));
  ctx.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, into.width, into.height);
  return { canvas: into, box: box, kind: "led" };
}

// The (up to MAX_CROPS) lit LED lines of a frame, cut from it at full resolution.
function ledCrops(src: Source, vw: number, vh: number, small: HTMLCanvasElement, into: HTMLCanvasElement[]): LedCrop[] {
  const sh = Math.max(1, Math.round((SMALL_W * vh) / vw));
  const sctx = small.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  if (small.width !== SMALL_W || small.height !== sh) {
    small.width = SMALL_W;
    small.height = sh;
  }
  sctx.drawImage(src, 0, 0, SMALL_W, sh);
  const found = ledBoxes(sctx.getImageData(0, 0, SMALL_W, sh).data, SMALL_W, sh).slice(0, MAX_CROPS);
  const sx = vw / SMALL_W;
  const sy = vh / sh;
  return found.map(function (item, i) {
    const x = Math.max(0, (item.x - item.w * PAD) * sx);
    const y = Math.max(0, (item.y - item.h * PAD) * sy);
    const right = Math.min(vw, (item.x + item.w * (1 + PAD)) * sx);
    const bottom = Math.min(vh, (item.y + item.h * (1 + PAD)) * sy);
    return cut(src, { x: x, y: y, w: right - x, h: bottom - y, score: item.score }, into[i]);
  });
}

// For a still picture (the OCR bench, /debug/ocr-bench): its LED sign crops, on new canvases.
export function ledCropsOf(src: HTMLImageElement | HTMLCanvasElement): LedCrop[] {
  const w = src instanceof HTMLImageElement ? src.naturalWidth : src.width;
  const h = src instanceof HTMLImageElement ? src.naturalHeight : src.height;
  return w && h ? ledCrops(src, w, h, document.createElement("canvas"), [document.createElement("canvas"), document.createElement("canvas")]) : [];
}

export function createLedCropper(): LedCropper {
  const small = document.createElement("canvas");
  const crops = [document.createElement("canvas"), document.createElement("canvas")];
  const frame = document.createElement("canvas");
  let lastRoute: number | null = null; // last time a route number was read (or the last whole frame)

  return {
    next: function (video: HTMLVideoElement, now: number): LedCrop[] {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) {
        return [];
      }
      if (lastRoute === null) {
        lastRoute = now - FALLBACK_MS; // the first read is a whole frame: the bus sign may not be the brightest colour
      }
      if (now - lastRoute >= FALLBACK_MS) {
        const scale = Math.min(1, FULL_W / vw);
        const ctx = sized(frame, Math.round(vw * scale), Math.round(vh * scale));
        ctx.drawImage(video, 0, 0, frame.width, frame.height);
        return [{ canvas: frame, box: { x: 0, y: 0, w: vw, h: vh, score: 0 }, kind: "frame" }];
      }
      return ledCrops(video, vw, vh, small, crops);
    },
    routeRead: function (now: number): void {
      lastRoute = now;
    },
    frameSent: function (now: number): void {
      lastRoute = now; // the next whole frame after another 2 s without a route number
    },
  };
}
