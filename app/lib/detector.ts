// YOLO11n (COCO, ONNX) in the browser: finds buses in a video frame.
// ponytail: pretrained COCO "bus" class until our fine-tuned bus/door/route_sign model exists.
import type * as Ort from "onnxruntime-web";

export interface Box {
  x: number; // left, video pixels
  y: number; // top
  w: number;
  h: number;
  score: number;
}

const MODEL_URL = "/models/yolo11n.onnx";
const SIZE = 640; // model input is SIZE x SIZE
const BUS_CLASS = 5; // COCO "bus"
const MIN_SCORE = 0.4;
// Weaker hits (a bus half out of frame, a car) aren't tracked, but their area is blacked out of
// other buses' sign crops so a neighbour's sign is never read as this bus's (tov_nomyn_san_2.png).
const MASK_CLASSES = [2, 5, 7]; // car, bus, truck
const MASK_SCORE = 0.2;

export interface Detections {
  buses: Box[]; // tracked
  others: Box[]; // masked out of sign crops
}
const NMS_IOU = 0.5;

type OrtModule = typeof Ort;

let session: Ort.InferenceSession | null = null;
let ort: OrtModule | null = null;
const canvas = typeof document === "undefined" ? null : document.createElement("canvas");

let loading: Promise<string> | null = null;

async function load(): Promise<string> {
  // Loaded from public/ort as-is (copied by scripts/copy-ort.mjs) so the bundler never touches it.
  ort = (await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "/ort/ort.webgpu.min.mjs" as string)) as OrtModule;
  ort.env.wasm.wasmPaths = "/ort/";
  const providers = "gpu" in navigator ? ["webgpu", "wasm"] : ["wasm"];
  session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: providers });
  return providers[0];
}

// One shared load: the model is 10 MB and a second session would double GPU memory.
export function loadDetector(): Promise<string> {
  if (!loading) {
    loading = load().catch(function (e) {
      loading = null; // let the next attempt retry
      throw e;
    });
  }
  return loading;
}

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

// Letterbox the frame into SIZE x SIZE, keeping aspect ratio, as YOLO was trained.
function toTensor(video: HTMLVideoElement): { data: Float32Array; scale: number; padX: number; padY: number } {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(SIZE / vw, SIZE / vh);
  const padX = (SIZE - vw * scale) / 2;
  const padY = (SIZE - vh * scale) / 2;
  const c = canvas as HTMLCanvasElement;
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(video, padX, padY, vw * scale, vh * scale);
  const pixels = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const area = SIZE * SIZE;
  const data = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    data[i] = pixels[i * 4] / 255;
    data[area + i] = pixels[i * 4 + 1] / 255;
    data[2 * area + i] = pixels[i * 4 + 2] / 255;
  }
  return { data, scale, padX, padY };
}

function nms(boxes: Box[]): Box[] {
  const kept: Box[] = [];
  boxes
    .sort(function (a, b) {
      return b.score - a.score;
    })
    .forEach(function (item) {
      for (const k of kept) {
        if (iou(k, item) > NMS_IOU) {
          return;
        }
      }
      kept.push(item);
    });
  return kept;
}

export async function detectBuses(video: HTMLVideoElement): Promise<Detections> {
  if (!session || !ort || !video.videoWidth) {
    return { buses: [], others: [] };
  }
  const { data, scale, padX, padY } = toTensor(video);
  const input = new ort.Tensor("float32", data, [1, 3, SIZE, SIZE]);
  const output = await session.run({ [session.inputNames[0]]: input });
  // Output [1, 84, N]: rows 0-3 = cx, cy, w, h; rows 4.. = class scores.
  const out = output[session.outputNames[0]];
  const values = out.data as Float32Array;
  const n = out.dims[2];
  const buses: Box[] = [];
  const weak: Box[] = [];
  for (let i = 0; i < n; i++) {
    const busScore = values[(4 + BUS_CLASS) * n + i];
    let maskScore = 0;
    MASK_CLASSES.forEach(function (item) {
      maskScore = Math.max(maskScore, values[(4 + item) * n + i]);
    });
    if (maskScore < MASK_SCORE) {
      continue;
    }
    const w = values[2 * n + i] / scale;
    const h = values[3 * n + i] / scale;
    const box = { x: (values[i] - padX) / scale - w / 2, y: (values[n + i] - padY) / scale - h / 2, w, h, score: busScore };
    if (busScore >= MIN_SCORE) {
      buses.push(box);
    } else {
      weak.push({ ...box, score: maskScore });
    }
  }
  const kept = nms(buses);
  const others = nms(weak).filter(function (item) {
    for (const b of kept) {
      // The same bus seen weakly, or a big piece of it (its front half): masking it would hide its own sign.
      const inside = iou(b, item) * (b.w * b.h + item.w * item.h) / (1 + iou(b, item)) / (item.w * item.h);
      if (iou(b, item) > NMS_IOU || (inside > 0.8 && item.w * item.h > 0.3 * b.w * b.h)) {
        return false;
      }
    }
    return true;
  });
  return { buses: kept, others };
}
