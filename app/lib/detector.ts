// YOLO11n (COCO, ONNX) in the browser: finds buses in a video frame.
// ponytail: pretrained COCO "bus" class until our fine-tuned bus/door/route_sign model exists.
import type * as Ort from "onnxruntime-web";
import { iou, type Box } from "./box";
import { isIOS } from "./device";

// Where the box type and overlap live now (lib/box.ts); re-exported so other files keep importing from here.
export { iou };
export type { Box };

const MODEL_URL = "/models/yolo11n.onnx";
// The model's input is fixed at export time (public/models/yolo11n.onnx is 640 x 640, 8400 anchors). The
// size actually used is read from the loaded model (inputSize), never assumed: a size that differs from
// the model's makes onnxruntime throw on every frame and the camera dies. This is only the fallback.
const DEFAULT_SIZE = 640;
let size = DEFAULT_SIZE;
const BUS_CLASS = 5; // COCO "bus"
const BUS_MIN = 0.1; // >= 0.5 may start a track; 0.1-0.5 only continues one (lib/tracker.ts)
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

// onnxruntime-web's WASM backend (phones without WebGPU) crashes ("memory access out of bounds") when
// two sessions run at once (the door model warming up while the bus model detects). Every model load
// and run, of both models, goes through this one queue.
let queue: Promise<unknown> = Promise.resolve();
export function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const result = queue.then(job, job);
  queue = result.catch(function () {});
  return result;
}

// Model files are downloaded outside the queue: on a slow phone connection the door model (40 MB)
// took ~45 s, and while it downloaded inside the queue the bus model and sign reading had to wait.
// Low priority: they download in the background while the rider uses the app, and must never hold up
// its own requests (measured on a slow line: a trip plan took 17 s instead of 1 s behind them).
export async function modelBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { priority: "low" } as RequestInit);
  if (!response.ok) {
    throw new Error(url + ": " + response.status);
  }
  return new Uint8Array(await response.arrayBuffer());
}

// WebGPU where it is proven. iPhone stays on WASM: a WebGPU session there has built and then returned
// nothing (no bus, ever), and that runtime is the larger build that made Safari reload the page.
// ?cpu forces WASM anywhere (testing).
function webgpuWanted(): boolean {
  return !isIOS() && "gpu" in navigator && !new URLSearchParams(window.location.search).has("cpu");
}

function wasmThreads(o: OrtModule): number {
  // iPhone: one thread. Each extra thread is another copy of the runtime, and Safari reloads the page.
  // Elsewhere, threaded WASM needs cross-origin isolation (next.config.ts sends COOP + COEP).
  const threads = isIOS() || typeof self === "undefined" || !self.crossOriginIsolated ? 1 : Math.min(navigator.hardwareConcurrency || 1, 4);
  o.env.wasm.numThreads = threads;
  return threads;
}

// The side of the model's square input, from the loaded model itself. A model exported with a dynamic
// size (names, not numbers) or without metadata falls back to DEFAULT_SIZE.
export function inputSize(s: Pick<Ort.InferenceSession, "inputMetadata">): number {
  const meta = s.inputMetadata && s.inputMetadata[0];
  if (meta && meta.isTensor && meta.shape.length === 4) {
    const h = meta.shape[2];
    const w = meta.shape[3];
    if (typeof h === "number" && typeof w === "number" && h > 0 && h === w) {
      return h;
    }
  }
  return DEFAULT_SIZE;
}

// Session + a first run (compiles the GPU shaders, ~1 s on a phone, now instead of on the first camera
// frame) on a plain grey frame, whose output must be real numbers: a broken GPU path fails here.
async function build(o: OrtModule, bytes: Uint8Array, providers: string[]): Promise<Ort.InferenceSession> {
  const s = await exclusive(function () {
    return o.InferenceSession.create(bytes, { executionProviders: providers });
  });
  const side = inputSize(s);
  const grey = new Float32Array(3 * side * side).fill(114 / 255);
  const out = await exclusive(function () {
    return s.run({ [s.inputNames[0]]: new o.Tensor("float32", grey, [1, 3, side, side]) });
  });
  const values = out[s.outputNames[0]].data as Float32Array;
  let finite = values.length > 0;
  for (let i = 0; i < values.length && finite; i += 97) {
    finite = Number.isFinite(values[i]);
  }
  if (!finite) {
    s.release().catch(function () {});
    throw new Error("detector output is not numbers on " + providers[0]);
  }
  size = side;
  return s;
}

async function load(): Promise<string> {
  const download = modelBytes(MODEL_URL);
  // Loaded from public/ort as-is (copied by scripts/copy-ort.mjs) so the bundler never touches it.
  // iPhone: the plain WASM build (14 MB, not the 27 MB WebGPU one) and one thread (each extra thread is
  // another copy of the runtime): Safari reloads the page when the camera step used too much memory.
  const ios = isIOS();
  const entry = ios ? "/ort/ort.wasm.min.mjs" : "/ort/ort.webgpu.min.mjs";
  ort = (await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ entry)) as OrtModule;
  ort.env.wasm.wasmPaths = "/ort/";
  if (ios) {
    ort.env.wasm.numThreads = 1;
    // The runtime reserves memory up front (scripts/copy-ort.mjs tries 4 GB first): on iPhone start at
    // 512 MB, plenty for the bus model + sign reader (~250 MB), so Safari isn't pushed to reload.
    (globalThis as { ortMaxPages?: number }).ortMaxPages = 8192;
  }
  const o = ort;
  const threads = wasmThreads(o);
  const bytes = await download;
  if (webgpuWanted()) {
    try {
      session = await build(o, bytes, ["webgpu", "wasm"]);
      return "webgpu";
    } catch (e) {
      console.warn("bus detector: WebGPU failed, using WASM", e);
    }
  }
  session = await build(o, bytes, ["wasm"]);
  return threads > 1 ? "wasm/" + threads : "wasm";
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

// The loaded onnxruntime module and its execution providers, for the door model (lib/doorDetector.ts).
export async function runtime(): Promise<{ ort: OrtModule; providers: string[] }> {
  const provider = await loadDetector();
  return { ort: ort as OrtModule, providers: provider === "webgpu" ? ["webgpu", "wasm"] : ["wasm"] };
}

// Letterbox the frame into size x size (the model's input), keeping aspect ratio, as YOLO was trained.
function toTensor(video: HTMLVideoElement): { data: Float32Array; scale: number; padX: number; padY: number } {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(size / vw, size / vh);
  const padX = (size - vw * scale) / 2;
  const padY = (size - vh * scale) / 2;
  const c = canvas as HTMLCanvasElement;
  if (c.width !== size || c.height !== size) {
    c.width = size; // once: re-sizing every frame re-allocates the canvas (iPhone memory)
    c.height = size;
  }
  const ctx = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(video, padX, padY, vw * scale, vh * scale);
  const pixels = ctx.getImageData(0, 0, size, size).data;
  const area = size * size;
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
  const input = new ort.Tensor("float32", data, [1, 3, size, size]);
  const s = session;
  const output = await exclusive(function () {
    return s.run({ [s.inputNames[0]]: input });
  });
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
    if (busScore < BUS_MIN && maskScore < MASK_SCORE) {
      continue;
    }
    const w = values[2 * n + i] / scale;
    const h = values[3 * n + i] / scale;
    const box = { x: (values[i] - padX) / scale - w / 2, y: (values[n + i] - padY) / scale - h / 2, w, h, score: busScore };
    if (busScore >= BUS_MIN) {
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
