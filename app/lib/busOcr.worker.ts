// Sign reading off the camera thread. Detection never waits for this.
// A plain file at /bus-ocr-worker.js (scripts/build-bus-ocr-worker.mjs): Safari drops a bundler's worker URL.
import { isIOS } from "./device";
import { recognize } from "./ocrPixels";

interface OrtLike {
  env: { wasm: { wasmPaths: string; numThreads: number } };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
  InferenceSession: {
    create: (bytes: Uint8Array, opts: { executionProviders: string[] }) => Promise<Session>;
  };
}

interface Session {
  inputNames: string[];
  outputNames: string[];
  run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array; dims: number[] }>>;
}

let det: Session | null = null;
let rec: Session | null = null;
let keys: string[] = [];
let ort: OrtLike | null = null;
let chain: Promise<void> = Promise.resolve();

function threads(): number {
  // iPhone: one thread. Each extra thread is another copy of the runtime, and Safari reloads the page.
  if (isIOS()) {
    return 1;
  }
  return typeof self !== "undefined" && self.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 1, 4) : 1;
}

async function model(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(url + ": " + res.status);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function load(): Promise<void> {
  if (isIOS()) {
    // Same cap as the detector: the runtime otherwise tries to reserve 4 GB and Safari reloads the page.
    (globalThis as { ortMaxPages?: number }).ortMaxPages = 8192;
  }
  const o = (await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "/ort/ort.wasm.min.mjs" as string)) as OrtLike;
  o.env.wasm.wasmPaths = "/ort/";
  o.env.wasm.numThreads = threads();
  ort = o;
  const [detBytes, recBytes, text] = await Promise.all([
    model("/models/ocr_det_int8.onnx"),
    model("/models/ocr_rec_int8.onnx"),
    fetch("/models/ocr_keys.txt").then(function (item) {
      return item.text();
    }),
  ]);
  keys = ["blank"].concat(text.split(/\r?\n/), [" "]);
  det = await o.InferenceSession.create(detBytes, { executionProviders: ["wasm"] });
  rec = await o.InferenceSession.create(recBytes, { executionProviders: ["wasm"] });
  const warm = det;
  await warm.run({ [warm.inputNames[0]]: new o.Tensor("float32", new Float32Array(3 * 32 * 320), [1, 3, 320, 32]) });
}

async function handle(data: { type: string; trackId?: number; frame?: number; width?: number; height?: number; pixels?: ArrayBuffer }): Promise<void> {
  if (data.type === "load") {
    try {
      await load();
      postMessage({ type: "ready", ok: true });
    } catch (e) {
      console.warn("[bus] sign worker failed", e);
      postMessage({ type: "ready", ok: false });
    }
    return;
  }
  if (data.type !== "read" || !det || !rec || !ort || !data.pixels || !data.width || !data.height) {
    return;
  }
  const started = performance.now();
  const d = det;
  const r = rec;
  const o = ort;
  try {
    const texts = await recognize(new Uint8ClampedArray(data.pixels), data.width, data.height, {
      keys: keys,
      detect: function (pixels, height, width) {
        return d.run({ [d.inputNames[0]]: new o.Tensor("float32", pixels, [1, 3, height, width]) }).then(function (out) {
          return out[d.outputNames[0]].data;
        });
      },
      recognise: function (pixels, width) {
        return r.run({ [r.inputNames[0]]: new o.Tensor("float32", pixels, [1, 3, 48, width]) }).then(function (out) {
          const tensor = out[r.outputNames[0]];
          return { steps: tensor.dims[1], classes: tensor.dims[2], data: tensor.data };
        });
      },
    });
    postMessage({ type: "read", trackId: data.trackId, frame: data.frame, texts: texts, ms: Math.round(performance.now() - started) });
  } catch (e) {
    console.warn("[bus] sign read failed", e);
    postMessage({ type: "read", trackId: data.trackId, frame: data.frame, texts: [], ms: Math.round(performance.now() - started) });
  }
}

self.onmessage = function (e: MessageEvent) {
  chain = chain.then(function () {
    return handle(e.data);
  });
};
