// Finds the bus's FRONT door: an open-vocabulary YOLO (YOLOE-11s, text prompts "bus door" /
// "entrance door", exported to ONNX by server/export_door.py) looks only at the front end of the
// confirmed bus, so the middle door is never in its view.
// Checked on tov_nomyn_san_{1,2}.png: front door 0.28 / 0.20, middle door <= 0.10, rear end none.
import type * as Ort from "onnxruntime-web";
import { exclusive, modelBytes, runtime, type Box } from "./detector";
import { isIOS } from "./device";

// int8 copy (server/quantize_models.py): 40 -> 11 MB, door box within 10% of the full model.
const MODEL_URL = "/models/door_int8.onnx";
const SIZE = 320; // model input is SIZE x SIZE (the crop is small, 320 keeps it fast)
const MIN_SCORE = 0.15; // the neighbouring bus's front scored 0.17, but it's outside our bus box
const FRONT_PART = 0.45; // search the front 45% of the bus (front door sits at 85-97% of its length)
const MIN_HEIGHT = 0.45; // a door is at least this share of the bus height (windows are shorter)

let session: Ort.InferenceSession | null = null;
let loading: Promise<void> | null = null;
const canvas = typeof document === "undefined" ? null : document.createElement("canvas");

// Loads once in the background while the camera looks for the bus, so it's ready when the bus is found.
export function loadDoorDetector(): Promise<void> {
  // iPhone: no door model. Loading another model right after the bus is found is the next memory
  // spike that makes Safari reload the page; the door direction comes from the bus box instead.
  if (isIOS()) {
    return Promise.resolve();
  }
  if (!loading) {
    loading = Promise.all([runtime(), modelBytes(MODEL_URL)])
      .then(function ([rt, bytes]) {
        return exclusive(function () {
          return rt.ort.InferenceSession.create(bytes, { executionProviders: rt.providers });
        });
      })
      .then(async function (s) {
        const { ort } = await runtime();
        // Compile the GPU shaders now, so the first door frame isn't slow.
        await exclusive(function () {
          return s.run({ [s.inputNames[0]]: new ort.Tensor("float32", new Float32Array(3 * SIZE * SIZE), [1, 3, SIZE, SIZE]) });
        });
        session = s;
      })
      .catch(function (e) {
        loading = null;
        console.warn("door model not loaded, using geometry", e);
      });
  }
  return loading;
}

// The front door box in video pixels, or null (not in view / not sure -> caller falls back to geometry).
export async function detectFrontDoor(video: HTMLVideoElement, bus: Box, frontRight: boolean): Promise<Box | null> {
  if (!session || !canvas || !video.videoWidth) {
    return null;
  }
  const { ort } = await runtime();
  // Front end of the bus, plus a little margin past its front edge, clipped to the frame.
  const left = Math.max(0, frontRight ? bus.x + (1 - FRONT_PART) * bus.w : bus.x - 0.05 * bus.w);
  const right = Math.min(video.videoWidth, frontRight ? bus.x + 1.05 * bus.w : bus.x + FRONT_PART * bus.w);
  const top = Math.max(0, bus.y);
  const bottom = Math.min(video.videoHeight, bus.y + bus.h);
  const cw = right - left;
  const ch = bottom - top;
  if (cw < 20 || ch < 40) {
    return null;
  }
  const scale = Math.min(SIZE / cw, SIZE / ch);
  const padX = (SIZE - cw * scale) / 2;
  const padY = (SIZE - ch * scale) / 2;
  if (canvas.width !== SIZE || canvas.height !== SIZE) {
    canvas.width = SIZE;
    canvas.height = SIZE;
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(video, left, top, cw, ch, padX, padY, cw * scale, ch * scale);
  const pixels = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const area = SIZE * SIZE;
  const data = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    data[i] = pixels[i * 4] / 255;
    data[area + i] = pixels[i * 4 + 1] / 255;
    data[2 * area + i] = pixels[i * 4 + 2] / 255;
  }
  const s = session;
  const output = await exclusive(function () {
    return s.run({ [s.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, SIZE, SIZE]) });
  });
  // output0 [1, 4 + 2 classes + 32 mask coefficients, N]; the mask output is ignored.
  const out = output[session.outputNames[0]];
  const values = out.data as Float32Array;
  const n = out.dims[2];
  const frontEdge = frontRight ? bus.x + bus.w : bus.x;
  const candidates: Box[] = [];
  for (let i = 0; i < n; i++) {
    const score = Math.max(values[4 * n + i], values[5 * n + i]);
    if (score < MIN_SCORE) {
      continue;
    }
    const w = values[2 * n + i] / scale;
    const h = values[3 * n + i] / scale;
    const cx = (values[i] - padX) / scale + left;
    const cy = (values[n + i] - padY) / scale + top;
    // Inside our bus (not the neighbour's front), in its front part, and door-tall.
    const fromFront = Math.abs(frontEdge - cx) / bus.w;
    if (cx < bus.x || cx > bus.x + bus.w || fromFront > FRONT_PART || h < MIN_HEIGHT * bus.h) {
      continue;
    }
    candidates.push({ x: cx - w / 2, y: cy - h / 2, w, h, score });
  }
  if (!candidates.length) {
    return null;
  }
  candidates.sort(function (a, b) {
    return b.score - a.score;
  });
  // A double-leaf door can come back as two leaves: merge boxes overlapping the best one.
  const best = candidates[0];
  let x1 = best.x;
  let x2 = best.x + best.w;
  candidates.forEach(function (item) {
    const overlapX = Math.min(x2, item.x + item.w) - Math.max(x1, item.x);
    if (item !== best && item.score > best.score * 0.6 && overlapX > -0.03 * bus.w) {
      x1 = Math.min(x1, item.x);
      x2 = Math.max(x2, item.x + item.w);
    }
  });
  return { x: x1, y: best.y, w: x2 - x1, h: best.h, score: best.score };
}
