// On-device reading of one LED sign crop, racing Azure (components/BusScanner.tsx). Recognition only:
// the LED blob detector (lib/crop-led.ts) already cut the sign, so no text detector is needed.
// Model: PaddleOCR cyrillic_PP-OCRv5_mobile_rec (Apache-2.0, 8 MB; its dictionary has Ө ө Ү ү Ё), the
// same file as the Reader's, taken from the same Cache Storage (lib/reader/modelStore.ts): a phone that
// opened the Reader downloads nothing. WebGPU where the phone has it, else WASM SIMD (threads: the site
// is cross-origin isolated, next.config.ts); iPhone: WASM, one thread (Safari reloads pages that hold
// several runtimes). A plain file at /sign-ocr-worker.js (scripts/build-sign-ocr-worker.mjs).
import { isIOS } from "./device";
import { modelFile } from "./reader/modelStore";

interface OrtLike {
  env: { wasm: { wasmPaths: string; numThreads: number } };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
  InferenceSession: {
    create: (bytes: Uint8Array, opts: { executionProviders: string[]; logSeverityLevel?: number }) => Promise<Session>;
  };
}

interface Session {
  inputNames: string[];
  outputNames: string[];
  run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array; dims: number[] }>>;
}

const MODEL = "/models/reader/rec_cyrillic.onnx";
const KEYS = "/models/reader/rec_cyrillic_keys.txt";
const REC_H = 48;
// Widths are padded up to one of these, so WebGPU builds its shaders for a few sizes, not every crop.
const WIDTHS = [160, 320, 480, 640, 960, 1280];

let ort: OrtLike | null = null;
let session: Session | null = null;
let keys: string[] = [];
let backend = "";
let chain: Promise<void> = Promise.resolve(); // one inference at a time

function post(msg: unknown): void {
  (self as unknown as Worker).postMessage(msg);
}

async function create(providers: string[], bytes: Uint8Array): Promise<Session> {
  return (ort as OrtLike).InferenceSession.create(bytes, { executionProviders: providers, logSeverityLevel: 3 });
}

async function load(): Promise<void> {
  const ios = isIOS();
  if (ios) {
    (globalThis as { ortMaxPages?: number }).ortMaxPages = 8192; // 512 MB, as the other iPhone workers
  }
  const o = (
    ios
      ? await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "/ort/ort.wasm.min.mjs" as string)
      : await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "/ort/ort.webgpu.min.mjs" as string)
  ) as OrtLike;
  o.env.wasm.wasmPaths = "/ort/";
  o.env.wasm.numThreads = ios ? 1 : self.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 1, 4) : 1;
  ort = o;
  const nothing = function (): void {};
  const [bytes, text] = await Promise.all([modelFile(MODEL, nothing), modelFile(KEYS, nothing)]);
  keys = ["blank"].concat(new TextDecoder().decode(text).split("\n"), [" "]);
  const gpu = !ios && "gpu" in navigator && Boolean(await (navigator as unknown as { gpu: { requestAdapter: () => Promise<unknown> } }).gpu.requestAdapter().catch(function () {
    return null;
  }));
  if (gpu) {
    try {
      session = await create(["webgpu", "wasm"], bytes);
      backend = "webgpu";
    } catch {
      session = null;
    }
  }
  if (!session) {
    session = await create(["wasm"], bytes);
    backend = "wasm";
  }
  // Warm-up: the first run prepares the kernels; done for the commonest widths.
  for (const w of [320, 640]) {
    await infer(new Float32Array(3 * REC_H * w), w);
  }
}

async function infer(data: Float32Array, width: number): Promise<{ text: string; conf: number }> {
  const s = session as Session;
  const o = ort as OrtLike;
  const out = await s.run({ [s.inputNames[0]]: new o.Tensor("float32", data, [1, 3, REC_H, width]) });
  const t = out[s.outputNames[0]];
  const steps = t.dims[1];
  const classes = t.dims[2];
  const p = t.data;
  // CTC: best class per step, repeats and blanks dropped; confidence = mean over kept characters.
  let text = "";
  let conf = 0;
  let kept = 0;
  let prev = -1;
  for (let i = 0; i < steps; i++) {
    let best = 0;
    let bestP = -1;
    const at = i * classes;
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
  return { text: text.trim(), conf: kept ? conf / kept : 0 };
}

// The bright text inside an LED crop: rows and columns with enough lit pixels (the crop's margins and
// the sign's dark frame are dropped), so the text fills the model's 48 px line height.
function textBox(gray: Uint8ClampedArray, w: number, h: number): { x: number; y: number; w: number; h: number } {
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < w * h; i++) {
    sum += gray[i];
    sq += gray[i] * gray[i];
  }
  const mean = sum / (w * h);
  const sd = Math.sqrt(Math.max(0, sq / (w * h) - mean * mean));
  const lit = Math.max(110, mean + sd);
  const rows: number[] = [];
  const cols = new Array<number>(w).fill(0);
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] > lit) {
        n++;
        cols[x]++;
      }
    }
    rows.push(n);
  }
  const rowMin = Math.max(2, w * 0.02);
  const colMin = 1;
  let y0 = rows.findIndex(function (item) {
    return item >= rowMin;
  });
  let y1 = h - 1 - rows.slice().reverse().findIndex(function (item) {
    return item >= rowMin;
  });
  let x0 = cols.findIndex(function (item) {
    return item >= colMin;
  });
  let x1 = w - 1 - cols.slice().reverse().findIndex(function (item) {
    return item >= colMin;
  });
  if (y0 < 0 || x0 < 0 || y1 - y0 < 6 || x1 - x0 < 6) {
    return { x: 0, y: 0, w, h }; // nothing clearly lit: the whole crop
  }
  const m = Math.round((y1 - y0) * 0.15);
  y0 = Math.max(0, y0 - m);
  y1 = Math.min(h - 1, y1 + m);
  x0 = Math.max(0, x0 - m);
  x1 = Math.min(w - 1, x1 + m);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// The text cut tight, inverted (an LED sign is light on dark; the model reads dark on light), scaled
// to 48 px high (planar BGR, (v / 255 - 0.5) / 0.5) and padded right with white up to one of WIDTHS.
function tensorOf(bitmap: ImageBitmap): { data: Float32Array; width: number } {
  const full = new OffscreenCanvas(bitmap.width, bitmap.height);
  const fctx = full.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  fctx.drawImage(bitmap, 0, 0);
  const px0 = fctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const gray = new Uint8ClampedArray(bitmap.width * bitmap.height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (px0[i * 4] * 77 + px0[i * 4 + 1] * 150 + px0[i * 4 + 2] * 29) >> 8;
  }
  const box = textBox(gray, bitmap.width, bitmap.height);
  const w = Math.max(8, Math.min(WIDTHS[WIDTHS.length - 1], Math.round((REC_H * box.w) / Math.max(1, box.h))));
  const width =
    WIDTHS.find(function (item) {
      return item >= w;
    }) ?? WIDTHS[WIDTHS.length - 1];
  const c = new OffscreenCanvas(width, REC_H);
  const ctx = c.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, REC_H);
  ctx.drawImage(bitmap, box.x, box.y, box.w, box.h, 0, 0, w, REC_H);
  const px = ctx.getImageData(0, 0, width, REC_H).data;
  const n = width * REC_H;
  const data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const v = 255 - ((px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8); // inverted gray
    const f = (v / 255 - 0.5) / 0.5;
    data[i] = f;
    data[n + i] = f;
    data[2 * n + i] = f;
  }
  return { data, width };
}

let loading: Promise<void> | null = null;

self.onmessage = function (e: MessageEvent<{ type: "load" } | { type: "read"; id: number; bitmap: ImageBitmap }>) {
  const msg = e.data;
  if (msg.type === "load") {
    if (!loading) {
      loading = load()
        .then(function () {
          post({ type: "ready", ok: true, backend });
        })
        .catch(function (err: unknown) {
          post({ type: "ready", ok: false, error: String(err) });
        });
    }
    return;
  }
  const { id, bitmap } = msg;
  chain = chain.then(async function () {
    try {
      if (!session) {
        await loading;
      }
      if (!session) {
        throw new Error("not loaded");
      }
      const t = performance.now();
      const { data, width } = tensorOf(bitmap);
      const read = await infer(data, width);
      post({ type: "read", id, text: read.text, conf: read.conf, ms: Math.round(performance.now() - t) });
    } catch (err) {
      post({ type: "read", id, text: "", conf: 0, ms: 0, error: String(err) });
    } finally {
      bitmap.close();
    }
  });
};
