// Reads a page photo, in the reader's worker (OffscreenCanvas). Ported 1:1 from the Python prototype
// measured on 22 synthetic phone photos of Mongolian text: books 99.6%, 3-column newspapers 98.9%,
// labels 99.5% of characters right.
//   detection: PaddleOCR PP-OCRv4 mobile DB (the same /models/ocr_det.onnx as the bus sign reader)
//   recognition: PaddleOCR cyrillic_PP-OCRv5_mobile_rec (Apache-2.0; has ө ү ё), CTC
// Lines are found on the photo scaled to PAGE_DET, cut out of the full photo along their own angle,
// put in reading order (lib/reader/layout.ts) and recognised a few at a time.
import type * as Ort from "onnxruntime-web";
import { readingOrder, type Region } from "./layout";
import type { FrameCheck } from "./protocol";
import type { PageLine } from "./sentences";

type OrtModule = typeof Ort;
export type Source = ImageBitmap | OffscreenCanvas;
interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}
// Runs one model call when it's this job's turn (higher priority first): onnxruntime's WASM backend
// must never run two at once.
export type Gate = <T>(priority: number, job: () => Promise<T>) => Promise<T>;
export const AIM_PRIORITY = 2;
export const PAGE_PRIORITY = 1;

const MEAN = [0.485, 0.456, 0.406]; // B, G, R (models trained on OpenCV BGR images)
const STD = [0.229, 0.224, 0.225];
const BIN_THRESH = 0.3; // DB: pixel is text
const BOX_THRESH = 0.6; // DB: mean probability of a region to keep it
const UNCLIP = 1.5; // DB: grow each line by area * UNCLIP / perimeter (limited by the free space around it)
export const PAGE_DET = 1280; // longest side for detection on a captured page (measured best: 1120-1280)
// For aiming: where the text is. Measured on whole-page frames: 480 px finds 19% of the lines (small
// print vanishes), 800 px 88%, 960 px 99.9%.
export const AIM_DET = 960;
export const AIM_FRAME = 1920; // camera frames sent for aiming (detail for AIM_FINE)
const AIM_FINE = 1440; // a second look for small print when nothing was seen at AIM_DET
const ZOOM_BELOW = 12; // median line height (detection pixels) below which the text area is zoomed
const ZOOM_LINE = 22; // line height aimed for when zooming
const ZOOM_MAX = 2560; // longest side for the zoomed detection (time and memory on a phone)
const REC_H = 48;
const REC_MAX_W = 3200;
export const BATCH = 6;
const FIRST_BATCH = 4; // smaller: the first sentence is heard sooner

function canvas(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const c = new OffscreenCanvas(w, h);
  return c.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
}

// RGBA pixels -> planar BGR, normalised per channel.
function planarBgr(px: Uint8ClampedArray, n: number, mean: number[], std: number[], out: Float32Array, at: number): void {
  for (let i = 0; i < n; i++) {
    out[at + i] = (px[i * 4 + 2] / 255 - mean[0]) / std[0];
    out[at + n + i] = (px[i * 4 + 1] / 255 - mean[1]) / std[1];
    out[at + 2 * n + i] = (px[i * 4] / 255 - mean[2]) / std[2];
  }
}

export class PageOcr {
  private ort: OrtModule;
  private det: Ort.InferenceSession;
  private rec: Ort.InferenceSession;
  private keys: string[];
  private gate: Gate;
  private misses = 0; // aiming frames with no text seen
  private fine = false; // small print: aiming frames are looked at with AIM_FINE pixels

  constructor(ort: OrtModule, det: Ort.InferenceSession, rec: Ort.InferenceSession, keysText: string, gate: Gate) {
    this.ort = ort;
    this.det = det;
    this.rec = rec;
    this.keys = ["blank"].concat(keysText.split("\n"), [" "]);
    this.gate = gate;
  }

  // Text lines on the source, in source pixels; also the scaled pixels (for brightness / sharpness).
  // `area`: only this part of the source (the text, zoomed in); regions are still in source pixels.
  async detect(source: Source, maxSide: number, priority: number, area?: Area): Promise<{ regions: Region[]; px: Uint8ClampedArray; w: number; h: number }> {
    const a = area ?? { x: 0, y: 0, w: source.width, h: source.height };
    const sw = a.w;
    const sh = a.h;
    const s = maxSide / Math.max(sw, sh);
    const w = Math.max(32, Math.round((sw * s) / 32) * 32);
    const h = Math.max(32, Math.round((sh * s) / 32) * 32);
    const ctx = canvas(w, h);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, a.x, a.y, a.w, a.h, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const data = new Float32Array(3 * w * h);
    planarBgr(px, w * h, MEAN, STD, data, 0);
    const det = this.det;
    const input = new this.ort.Tensor("float32", data, [1, 3, h, w]);
    const out = await this.gate(priority, function () {
      return det.run({ [det.inputNames[0]]: input });
    });
    const prob = out[this.det.outputNames[0]].data as Float32Array;
    const regions = regionsOf(prob, w, h, sw / w, sh / h);
    if (a.x || a.y) {
      regions.forEach(function (item) {
        item.cx += a.x;
        item.cy += a.y;
      });
    }
    return { regions, px, w, h };
  }

  // Small print (a page held far away, or a newspaper): lines only a few pixels high at PAGE_DET are
  // found in broken pieces, and the reading order falls apart. Then the lines are found again on the
  // text area only, enlarged so a line is ~ZOOM_LINE pixels high (at most ZOOM_MAX; never past the
  // photo's own pixels). Measured on a book page photographed small (4K frame, 22 px print): words
  // were right but split and out of order at 1280 px.
  async detectPage(source: Source): Promise<Region[]> {
    const found = await this.detect(source, PAGE_DET, PAGE_PRIORITY);
    const text = found.regions.filter(function (item) {
      return item.len > 2 * item.thick;
    });
    if (text.length < 3) {
      return found.regions;
    }
    const scale = found.w / source.width; // detection pixels per photo pixel
    const thick = text
      .map(function (item) {
        return item.thick;
      })
      .sort(function (a, b) {
        return a - b;
      })[Math.floor(text.length / 2)];
    if (thick * scale >= ZOOM_BELOW) {
      return found.regions;
    }
    let x0 = source.width;
    let y0 = source.height;
    let x1 = 0;
    let y1 = 0;
    text.forEach(function (item) {
      const b = corners(item);
      x0 = Math.min(x0, b.x0);
      y0 = Math.min(y0, b.y0);
      x1 = Math.max(x1, b.x1);
      y1 = Math.max(y1, b.y1);
    });
    const pad = 3 * thick;
    const area = {
      x: Math.max(0, Math.floor(x0 - pad)),
      y: Math.max(0, Math.floor(y0 - pad)),
      w: 0,
      h: 0,
    };
    area.w = Math.min(source.width, Math.ceil(x1 + pad)) - area.x;
    area.h = Math.min(source.height, Math.ceil(y1 + pad)) - area.y;
    const longest = Math.max(area.w, area.h);
    const side = Math.min(ZOOM_MAX, longest, Math.max(PAGE_DET, (longest * ZOOM_LINE) / thick));
    if (side <= (longest * scale) * 1.15) {
      return found.regions; // no real gain
    }
    const zoomed = await this.detect(source, side, PAGE_PRIORITY, area);
    return zoomed.regions.length ? zoomed.regions : found.regions;
  }

  // One camera frame, for aiming.
  async check(frame: Source): Promise<FrameCheck> {
    // Small print is too fine to see at AIM_DET: every other frame with no text is looked at again with
    // more pixels (AIM_FINE), and once that found the text, the next frames are looked at that way too
    // (otherwise a book held at arm's length is never "in view" and the photo never taken).
    const fineFirst = this.fine && frame.width > AIM_DET;
    let { regions, px, w, h } = await this.detect(frame, fineFirst ? AIM_FINE : AIM_DET, AIM_PRIORITY);
    const fw = frame.width;
    const fh = frame.height;
    function long(list: Region[]): Region[] {
      return list.filter(function (item) {
        return item.len > 2 * item.thick;
      });
    }
    let text = long(regions);
    this.fine = fineFirst && text.length >= 2;
    if (!fineFirst && text.length < 2 && frame.width > AIM_DET && ++this.misses % 2 === 0) {
      const fine = await this.detect(frame, AIM_FINE, AIM_PRIORITY);
      if (long(fine.regions).length >= 2) {
        ({ regions, px, w, h } = fine);
        text = long(regions);
        this.fine = true;
      }
    }
    let x0 = 1;
    let y0 = 1;
    let x1 = 0;
    let y1 = 0;
    const cut = { left: false, right: false, top: false, bottom: false };
    const mx = 0.02 * fw;
    const my = 0.02 * fh;
    text.forEach(function (item) {
      const b = corners(item);
      x0 = Math.min(x0, b.x0 / fw);
      y0 = Math.min(y0, b.y0 / fh);
      x1 = Math.max(x1, b.x1 / fw);
      y1 = Math.max(y1, b.y1 / fh);
      cut.left = cut.left || b.x0 < mx;
      cut.right = cut.right || b.x1 > fw - mx;
      cut.top = cut.top || b.y0 < my;
      cut.bottom = cut.bottom || b.y1 > fh - my;
    });
    const thick = text
      .map(function (item) {
        return item.thick;
      })
      .sort(function (a, b) {
        return a - b;
      });
    return {
      lines: text.length,
      box: [x0, y0, x1, y1],
      cut,
      lineHeight: thick.length ? thick[Math.floor(thick.length / 2)] / fh : 0,
      brightness: brightness(px),
      sharpness: sharpness(px, w, h),
    };
  }

  // Line images in REC_H-high strips, recognised together: [(text, confidence)].
  async recognise(source: Source, regions: Region[], flip: boolean, priority: number): Promise<[string, number][]> {
    const crops = regions.map(function (item) {
      return cropLine(source, item, flip);
    });
    const width = Math.min(
      REC_MAX_W,
      Math.max.apply(
        null,
        crops.map(function (item) {
          return item.w;
        }),
      ),
    );
    const n = REC_H * width;
    const data = new Float32Array(crops.length * 3 * n); // zero = mid grey after normalising
    crops.forEach(function (item, i) {
      for (let c = 0; c < 3; c++) {
        for (let y = 0; y < REC_H; y++) {
          const from = c * REC_H * item.w + y * item.w;
          data.set(item.data.subarray(from, from + Math.min(item.w, width)), i * 3 * n + c * n + y * width);
        }
      }
    });
    const rec = this.rec;
    const input = new this.ort.Tensor("float32", data, [crops.length, 3, REC_H, width]);
    const out = await this.gate(priority, function () {
      return rec.run({ [rec.inputNames[0]]: input });
    });
    const t = out[this.rec.outputNames[0]];
    const steps = t.dims[1];
    const classes = t.dims[2];
    const p = t.data as Float32Array;
    const keys = this.keys;
    return crops.map(function (_item, i) {
      // CTC: best class per step, repeats and blanks dropped; confidence = mean over kept characters.
      let text = "";
      let conf = 0;
      let kept = 0;
      let prev = -1;
      for (let s = 0; s < steps; s++) {
        let best = 0;
        let bestP = -1;
        const at = (i * steps + s) * classes;
        for (let c = 0; c < classes; c++) {
          if (p[at + c] > bestP) {
            bestP = p[at + c];
            best = c;
          }
        }
        if (best !== prev && best !== 0) {
          text += keys[best] ?? "";
          conf += bestP;
          kept++;
        }
        prev = best;
      }
      return [text, kept ? conf / kept : 0] as [string, number];
    });
  }

  // A captured page: turned upright if needed, lines in reading order, recognised BATCH at a time.
  // `each` gets the lines as they're read; return false from it to stop (a new page was asked for).
  async read(photo: ImageBitmap, each: (lines: PageLine[], done: boolean, turned: number, total: number) => Promise<boolean>): Promise<void> {
    let source: Source = photo;
    let turned = 0;
    let regions = await this.detectPage(source);
    // Sideways (lines run up and down): turn a quarter and look again.
    const long = regions.filter(function (item) {
      return item.len > 3 * item.thick;
    });
    const upright = long.filter(function (item) {
      return Math.abs(Math.sin(item.angle)) > 0.7;
    });
    if (long.length >= 3 && upright.length > 0.6 * long.length) {
      source = turn(source, 90);
      turned = 90;
      regions = await this.detectPage(source);
    }
    let { order, breakAfter } = readingOrder(regions);
    // The first lines are needed anyway; if they read poorly, the page may be upside down: try them
    // turned around (only then: a normal page pays nothing for the check).
    let first: [string, number][] | null = null;
    if (order.length) {
      const lines = order.slice(0, FIRST_BATCH).map(function (item) {
        return regions[item];
      });
      first = await this.recognise(source, lines, false, PAGE_PRIORITY);
      if (mean(first) < 0.85 && mean(await this.recognise(source, lines, true, PAGE_PRIORITY)) > mean(first) + 0.15) {
        const w = source.width;
        const h = source.height;
        source = turn(source, 180);
        turned += 180;
        regions = regions.map(function (item) {
          return { ...item, cx: w - item.cx, cy: h - item.cy };
        });
        ({ order, breakAfter } = readingOrder(regions));
        first = null;
      }
    }
    for (let k = 0; k < order.length; ) {
      const size = k === 0 ? FIRST_BATCH : BATCH;
      const batch = order.slice(k, k + size);
      const read =
        k === 0 && first
          ? first
          : await this.recognise(
              source,
              batch.map(function (item) {
                return regions[item];
              }),
              false,
              PAGE_PRIORITY,
            );
      const lines = read.map(function (item, j) {
        return { text: item[0], conf: item[1], breakAfter: breakAfter[k + j] };
      });
      k += size;
      const more = await each(lines, k >= order.length, turned, order.length);
      if (!more) {
        return;
      }
    }
    if (!order.length) {
      await each([], true, turned, 0);
    }
  }
}

function mean(read: [string, number][]): number {
  let s = 0;
  read.forEach(function (item) {
    s += item[1];
  });
  return read.length ? s / read.length : 0;
}

function turn(source: Source, degrees: 90 | 180): OffscreenCanvas {
  const w = source.width;
  const h = source.height;
  const c = new OffscreenCanvas(degrees === 90 ? h : w, degrees === 90 ? w : h);
  const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  if (degrees === 90) {
    ctx.setTransform(0, 1, -1, 0, h, 0); // clockwise
  } else {
    ctx.setTransform(-1, 0, 0, -1, w, h);
  }
  ctx.drawImage(source, 0, 0);
  return c;
}

// Axis-aligned bounds of a line's rectangle.
function corners(r: Region): { x0: number; y0: number; x1: number; y1: number } {
  const ux = Math.cos(r.angle);
  const uy = Math.sin(r.angle);
  const dx = Math.abs(ux) * r.len / 2 + Math.abs(uy) * r.thick / 2;
  const dy = Math.abs(uy) * r.len / 2 + Math.abs(ux) * r.thick / 2;
  return { x0: r.cx - dx, y0: r.cy - dy, x1: r.cx + dx, y1: r.cy + dy };
}

// DB probability map (w x h) -> text lines as rotated rectangles in source pixels (sx, sy per map pixel).
let seen = new Uint8Array(0);
let queue = new Int32Array(0);
function regionsOf(prob: Float32Array, w: number, h: number, sx: number, sy: number): Region[] {
  if (seen.length < w * h) {
    seen = new Uint8Array(w * h);
    queue = new Int32Array(w * h);
  } else {
    seen.fill(0, 0, w * h);
  }
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
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      sum += prob[p];
      if (x > 0 && !seen[p - 1] && prob[p - 1] > BIN_THRESH) {
        seen[p - 1] = 1;
        queue[tail++] = p - 1;
      }
      if (x < w - 1 && !seen[p + 1] && prob[p + 1] > BIN_THRESH) {
        seen[p + 1] = 1;
        queue[tail++] = p + 1;
      }
      if (p >= w && !seen[p - w] && prob[p - w] > BIN_THRESH) {
        seen[p - w] = 1;
        queue[tail++] = p - w;
      }
      if (p + w < w * h && !seen[p + w] && prob[p + w] > BIN_THRESH) {
        seen[p + w] = 1;
        queue[tail++] = p + w;
      }
    }
    if (tail < 6 || sum / tail < BOX_THRESH) {
      continue;
    }
    const r = rectangle(queue, tail, w, sx, sy);
    if (r) {
      out.push(r);
    }
  }
  return out;
}

// Principal axis of the region's pixels = direction of the line; extents along and across it.
function rectangle(pixels: Int32Array, n: number, w: number, sx: number, sy: number): Region | null {
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    const p = pixels[i];
    mx += ((p % w) + 0.5) * sx;
    my += (Math.floor(p / w) + 0.5) * sy;
  }
  mx /= n;
  my /= n;
  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (let i = 0; i < n; i++) {
    const p = pixels[i];
    const dx = ((p % w) + 0.5) * sx - mx;
    const dy = (Math.floor(p / w) + 0.5) * sy - my;
    cxx += dx * dx;
    cyy += dy * dy;
    cxy += dx * dy;
  }
  let angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  let e = extents(pixels, n, w, sx, sy, mx, my, angle);
  if (e.b1 - e.b0 > e.a1 - e.a0) {
    angle += angle < 0 ? Math.PI / 2 : -Math.PI / 2;
    e = extents(pixels, n, w, sx, sy, mx, my, angle);
  }
  const len = e.a1 - e.a0;
  const thick = e.b1 - e.b0;
  if (thick < 3 * sy || len < 3 * sx) {
    return null;
  }
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const ca = (e.a0 + e.a1) / 2;
  const cb = (e.b0 + e.b1) / 2;
  return { cx: mx + ux * ca - uy * cb, cy: my + uy * ca + ux * cb, len, thick, angle, score: 1, freeUp: 1e9, freeDown: 1e9 };
}

function extents(pixels: Int32Array, n: number, w: number, sx: number, sy: number, mx: number, my: number, angle: number): { a0: number; a1: number; b0: number; b1: number } {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  let a0 = Infinity;
  let a1 = -Infinity;
  let b0 = Infinity;
  let b1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = pixels[i];
    const dx = ((p % w) + 0.5) * sx - mx;
    const dy = (Math.floor(p / w) + 0.5) * sy - my;
    const a = dx * ux + dy * uy;
    const b = -dx * uy + dy * ux;
    a0 = Math.min(a0, a);
    a1 = Math.max(a1, a);
    b0 = Math.min(b0, b);
    b1 = Math.max(b1, b);
  }
  return { a0: a0 - sx / 2, a1: a1 + sx / 2, b0: b0 - sy / 2, b1: b1 + sy / 2 };
}

// The line cut out along its angle, REC_H high: planar BGR normalised to [-1, 1]. Grows like DB's
// unclip, but never more than halfway into the free space above/below (tight newspaper lines would
// otherwise show their neighbours). `flip`: turned upside down (orientation check).
let lineCtx: OffscreenCanvasRenderingContext2D | null = null;
function cropLine(source: Source, r: Region, flip: boolean): { data: Float32Array; w: number } {
  const d = (r.len * r.thick * UNCLIP) / (2 * (r.len + r.thick));
  const up = Math.min(d, Math.max(0.1 * r.thick, r.freeUp / 2));
  const down = Math.min(d, Math.max(0.1 * r.thick, r.freeDown / 2));
  const len = r.len + 2 * d;
  const thick = r.thick + up + down;
  const ux = Math.cos(r.angle);
  const uy = Math.sin(r.angle);
  const shift = (down - up) / 2; // the centre moves toward the side that grew more
  const cx = r.cx - uy * shift;
  const cy = r.cy + ux * shift;
  const tlx = cx - (ux * len) / 2 + (uy * thick) / 2;
  const tly = cy - (uy * len) / 2 - (ux * thick) / 2;
  const w = Math.min(REC_MAX_W, Math.max(8, Math.round((REC_H * len) / thick)));
  // source = tl + X * u + Y * v  (u along the line per output pixel, v across it)
  const vx = (-uy * thick) / REC_H;
  const vy = (ux * thick) / REC_H;
  const uxp = (ux * len) / w;
  const uyp = (uy * len) / w;
  const det = uxp * vy - vx * uyp;
  const a = vy / det;
  const c = -vx / det;
  const b = -uyp / det;
  const dd = uxp / det;
  if (!lineCtx || lineCtx.canvas.width < w || lineCtx.canvas.height < REC_H) {
    // Only grow. Setting the size on every line re-allocates the canvas, and iPhone Safari then reloads.
    lineCtx = canvas(Math.max(w, lineCtx ? lineCtx.canvas.width : 0), REC_H);
  }
  const ctx = lineCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, REC_H);
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "rgb(128,128,128)";
  ctx.fillRect(0, 0, w, REC_H);
  ctx.setTransform(a, b, c, dd, -(a * tlx + c * tly), -(b * tlx + dd * tly));
  ctx.drawImage(source, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const px = ctx.getImageData(0, 0, w, REC_H).data;
  const n = w * REC_H;
  const data = new Float32Array(3 * n);
  planarBgr(px, n, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], data, 0);
  if (flip) {
    for (let ch = 0; ch < 3; ch++) {
      data.subarray(ch * n, (ch + 1) * n).reverse();
    }
  }
  return { data, w };
}

function brightness(px: Uint8ClampedArray): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 16) {
    s += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    n++;
  }
  return n ? s / n / 255 : 0;
}

// Variance of the Laplacian of the luminance: drops when the picture is blurred or moving.
function sharpness(px: Uint8ClampedArray, w: number, h: number): number {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  }
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      s += v;
      s2 += v * v;
      n++;
    }
  }
  return n ? s2 / n - (s / n) * (s / n) : 0;
}
