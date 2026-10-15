// The reader's workers, off the main thread so taps, gestures and audio stay instant while a page is
// being read. Two of them, started from this one file (lib/reader/engine.ts):
//   "ocr"    aiming and page recognition
//   "voice"  the reading voice
// Separate, so the voice is made while the page is still being recognised (one thread would make each
// wait for the other: measured, the voice took 4 s longer to load while a page was read). Each has its
// own onnxruntime (WASM, multi-threaded when cross-origin isolated); in each, model calls run one at a
// time, highest priority first (aiming before the rest of the page).
import type * as Ort from "onnxruntime-web";
import { modelFile } from "./modelStore";
import { AIM_PRIORITY, PageOcr } from "./pageOcr";
import type { FromEngine, ToEngine } from "./protocol";
import { VOICE_RATE, VoiceModel } from "./voiceModel";

type OrtModule = typeof Ort;

const ROLE = (self as unknown as { name: string }).name === "voice" ? "voice" : "ocr";

const MODELS = {
  det: "/models/ocr_det.onnx", // shared with the bus sign reader
  rec: "/models/reader/rec_cyrillic.onnx",
  keys: "/models/reader/rec_cyrillic_keys.txt",
  voiceGraph: "/models/reader/voice_mn.onnx",
  voicePack: "/models/reader/voice_mn.pack",
};

function post(msg: FromEngine, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

let ortModule: Promise<OrtModule> | null = null;
function runtime(): Promise<OrtModule> {
  if (!ortModule) {
    ortModule = (async function () {
      if (lowMemory) {
        // 1 GB at most for this runtime's memory (scripts/copy-ort.mjs): measured ~240 MB needed
        (self as unknown as { ortMaxPages: number }).ortMaxPages = 16384;
      }
      const ort = (await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "/ort/ort.webgpu.min.mjs" as string)) as OrtModule;
      ort.env.wasm.wasmPaths = "/ort/";
      if (lowMemory) {
        // Each WASM thread is another worker with its own copy of the runtime: on iPhones two
        // runtimes x several threads, plus the voice's weights, get the tab closed.
        ort.env.wasm.numThreads = 1;
      }
      return ort;
    })();
  }
  return ortModule;
}

// One model call at a time; waiting calls go highest priority first, then first come.
let running = false;
let order = 0;
const waiting: { priority: number; n: number; go: () => void }[] = [];
function gate<T>(priority: number, job: () => Promise<T>): Promise<T> {
  return new Promise<void>(function (resolve) {
    waiting.push({ priority, n: order++, go: resolve });
    next();
  }).then(function () {
    return job().finally(function () {
      running = false;
      next();
    });
  });
}
function next(): void {
  if (running || !waiting.length) {
    return;
  }
  waiting.sort(function (a, b) {
    return b.priority - a.priority || a.n - b.n;
  });
  running = true;
  (waiting.shift() as { go: () => void }).go();
}

let debug = false;
let voiceGpu = true;
let lowMemory = false;
function log(what: string, since: number): void {
  if (debug) {
    post({ type: "log", text: what + " " + Math.round(performance.now() - since) + " ms" });
  }
}

// One model call through the gate, timed with ?debug=1.
function timedGate<T>(priority: number, job: () => Promise<T>): Promise<T> {
  const asked = performance.now();
  return gate(priority, function () {
    const started = performance.now();
    return job().then(function (out) {
      log("model call p" + priority + " (waited " + Math.round(started - asked) + " ms)", started);
      return out;
    });
  });
}

let ocr: PageOcr | null = null;
let voice: VoiceModel | null = null;
let ocrLoading: Promise<void> | null = null;
let voiceLoading: Promise<void> | null = null;

function loadOcr(): Promise<void> {
  if (!ocrLoading) {
    ocrLoading = (async function () {
      const sizes = [0, 0, 0];
      const totals = [4745517, 8048799, 2780]; // bytes, if the server doesn't say
      const report = function (i: number) {
        return function (loaded: number, total: number) {
          sizes[i] = loaded;
          totals[i] = total || totals[i];
          post({ type: "progress", part: "ocr", loaded: sizes[0] + sizes[1] + sizes[2], total: totals[0] + totals[1] + totals[2] });
        };
      };
      const [ort, det, rec, keys] = await Promise.all([runtime(), modelFile(MODELS.det, report(0)), modelFile(MODELS.rec, report(1)), modelFile(MODELS.keys, report(2))]);
      const options = { executionProviders: ["wasm"], logSeverityLevel: 3 as const };
      const t = performance.now();
      const detSession = await gate(AIM_PRIORITY, function () {
        return ort.InferenceSession.create(det, options);
      });
      const recSession = await gate(AIM_PRIORITY, function () {
        return ort.InferenceSession.create(rec, options);
      });
      log("ocr sessions (threads " + (ort.env.wasm.numThreads ?? "default") + ")", t);
      ocr = new PageOcr(ort, detSession, recSession, new TextDecoder().decode(keys), timedGate);
      post({ type: "ready", part: "ocr", ok: true });
      postFiles();
    })().catch(function (e: unknown) {
      ocrLoading = null;
      post({ type: "ready", part: "ocr", ok: false, error: String(e) });
    });
  }
  return ocrLoading;
}

function loadVoice(): Promise<void> {
  if (!voiceLoading) {
    voiceLoading = (async function () {
      const sizes = [0, 0];
      const totals = [1411721, 35126328];
      const report = function (i: number) {
        return function (loaded: number, total: number) {
          sizes[i] = loaded;
          totals[i] = total || totals[i];
          post({ type: "progress", part: "voice", loaded: sizes[0] + sizes[1], total: totals[0] + totals[1] });
        };
      };
      const [ort, graph, pack] = await Promise.all([runtime(), modelFile(MODELS.voiceGraph, report(0)), modelFile(MODELS.voicePack, report(1))]);
      const t = performance.now();
      log("voice files in hand", t);
      const gpu = voiceGpu && "gpu" in self.navigator && Boolean(await (self.navigator as unknown as { gpu: { requestAdapter: () => Promise<unknown> } }).gpu.requestAdapter().catch(function () {
        return null;
      }));
      log("voice: GPU " + (gpu ? "yes" : "no") + ", threads " + (ort.env.wasm.numThreads ?? "default"), t);
      voice = await VoiceModel.load(ort, graph, pack, timedGate, gpu, function (what: string) {
        log("voice: " + what, t);
      });
      log("voice model on " + voice.backend, t);
      post({ type: "ready", part: "voice", ok: true });
      postFiles();
    })().catch(function (e: unknown) {
      voiceLoading = null;
      post({ type: "ready", part: "voice", ok: false, error: String(e) });
    });
  }
  return voiceLoading;
}

// onnxruntime's files, as this worker (and its threads) loaded them: the page has them kept offline.
function postFiles(): void {
  post({
    type: "files",
    urls: performance.getEntriesByType("resource").map(function (item) {
      return item.name;
    }),
  });
}

const cancelled = new Set<number>();

async function handle(msg: ToEngine): Promise<void> {
  if (msg.type === "load") {
    debug = msg.debug;
    voiceGpu = msg.voiceGpu;
    lowMemory = msg.lowMemory;
    if (msg.parts.indexOf(ROLE) >= 0) {
      await (ROLE === "ocr" ? loadOcr() : loadVoice());
    }
  } else if (msg.type === "cancel") {
    cancelled.add(msg.id);
  } else if (msg.type === "analyze") {
    try {
      if (!ocr) {
        await loadOcr();
      }
      post({ type: "analysis", id: msg.id, check: ocr ? await ocr.check(msg.frame) : null });
    } finally {
      msg.frame.close();
    }
  } else if (msg.type === "read") {
    const id = msg.id;
    try {
      if (!ocr) {
        await loadOcr();
      }
      if (!ocr) {
        post({ type: "failed", id, message: "ocr" });
        return;
      }
      const t = performance.now();
      await ocr.read(msg.photo, async function (lines, done, turned, total) {
        log("page: " + lines.length + " more lines (" + total + " in all)", t);
        if (cancelled.has(id)) {
          return false;
        }
        post({ type: "lines", id, lines, done, turned, total });
        return true;
      });
    } catch (e) {
      post({ type: "failed", id, message: String(e) });
    } finally {
      msg.photo.close();
      cancelled.delete(id);
    }
  } else if (msg.type === "speak") {
    const id = msg.id;
    try {
      if (voice) {
        const t = performance.now();
        let seconds = 0;
        let first = 0;
        await voice.speak(msg.text, msg.urgent, function (audio) {
          seconds += audio.length / VOICE_RATE;
          first = first || performance.now() - t;
          post({ type: "audio", id, samples: audio, rate: VOICE_RATE, last: false }, [audio.buffer]);
        });
        log("voice: " + msg.text.length + " characters -> " + seconds.toFixed(1) + " s of speech (first piece " + Math.round(first) + " ms)", t);
      }
    } catch (e) {
      console.warn("reading voice failed", e);
    }
    post({ type: "audio", id, samples: null, rate: VOICE_RATE, last: true });
  }
}

self.onmessage = function (e: MessageEvent<ToEngine>) {
  handle(e.data).catch(function (err: unknown) {
    console.warn("reader worker", err);
  });
};
