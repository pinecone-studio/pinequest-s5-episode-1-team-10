// The page's side of the reader's workers (engine.worker.ts), started on first use, so the models load
// once and stay loaded while the rider reads page after page.
import type { FrameCheck, FromEngine, Part, ToEngine } from "./protocol";
import type { PageLine } from "./sentences";

type Listener = (msg: FromEngine) => void;

const workers: Record<Part, Worker | null> = { ocr: null, voice: null };
const listeners = new Set<Listener>();
let nextId = 1;
const ready: Record<Part, boolean> = { ocr: false, voice: false };

// The worker is a plain script built from engine.worker.ts (scripts/build-reader-worker.mjs), not the
// bundler's own worker: its settings travel in the URL's #params= fragment, which Safari on an iPhone
// lost ("Missing worker bootstrap config"), so nothing ever loaded.
export const WORKER_URL = "/reader-worker.js";

interface Settings {
  debug: boolean;
  voiceGpu: boolean;
  lowMemory: boolean;
}

function settings(): Settings {
  const q = new URLSearchParams(window.location.search);
  // ?voice=cpu: the CPU voice (comparing, or a GPU that misbehaves)
  // iPad says it's a Mac; the touch points give it away. ?threads=1 tries the same on any phone.
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // ?log=1 (phone testing, lib/reader/remoteLog.ts) also wants the workers' step timings
  return { debug: q.get("debug") === "1" || q.get("log") === "1", voiceGpu: q.get("voice") !== "cpu", lowMemory: ios || q.get("threads") === "1" };
}

// Two workers from one file (engine.worker.ts): page recognition and the voice run side by side.
function engine(part: Part): Worker {
  let w = workers[part];
  if (!w) {
    w = new Worker(WORKER_URL, { name: part });
    // A worker that never started (or died) is dropped, so the next message makes a fresh one; the
    // page hears "not ready" instead of waiting for it forever.
    const dead = w;
    w.onerror = function (e: ErrorEvent) {
      console.warn("[reader] " + part + " worker failed: " + (e.message || "could not start"));
      if (workers[part] === dead) {
        workers[part] = null;
        ready[part] = false;
      }
      const msg: FromEngine = { type: "ready", part, ok: false, error: e.message || "worker failed" };
      listeners.forEach(function (item) {
        item(msg);
      });
    };
    // Settings first, so a worker made later (after a failure) knows it's on an iPhone.
    w.postMessage({ type: "load", parts: [], ...settings() } satisfies ToEngine);
    w.onmessage = function (e: MessageEvent<FromEngine>) {
      const msg = e.data;
      if (msg.type === "ready") {
        ready[msg.part] = msg.ok;
        if (!msg.ok) {
          console.warn("[reader] " + msg.part + " not loaded: " + msg.error);
        }
      } else if (msg.type === "log") {
        console.log("[reader] " + part + ": " + msg.text);
      } else if (msg.type === "files") {
        keepOffline(msg.urls.concat([WORKER_URL]));
      }
      listeners.forEach(function (item) {
        item(msg);
      });
    };
    workers[part] = w;
  }
  return w;
}

// Asks the service worker (public/sw.js) to keep these files for offline use.
export function keepOffline(urls: string[]): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  navigator.serviceWorker.ready
    .then(function (reg) {
      if (reg.active) {
        reg.active.postMessage({ type: "keep", urls });
      }
    })
    .catch(function () {});
}

function send(part: Part, msg: ToEngine, transfer?: Transferable[]): void {
  engine(part).postMessage(msg, transfer ?? []);
}

export function listen(fn: Listener): () => void {
  listeners.add(fn);
  return function () {
    listeners.delete(fn);
  };
}

export function isReady(part: Part): boolean {
  return ready[part] || (part === "voice" && cloud);
}

// The ElevenLabs voice (server/elevenlabs.py, Eleven v4 Mongolian): soft, reads a sentence as part of the
// story (the sentences around it are sent too). Used while the server has a key and answers; the first
// failure (offline, credit used up) switches to the phone's own voice for the rest of the visit.
let cloud = false;
export function setCloudVoice(on: boolean): void {
  cloud = on;
}
export function cloudVoice(): boolean {
  return cloud;
}

// Drops a worker and the ONNX runtime inside it. On an iPhone the page reader is dropped before the
// voice starts: the two together are what gets the tab killed.
export function releasePart(part: Part): void {
  const w = workers[part];
  if (w) {
    w.onmessage = null;
    w.onerror = null;
    w.terminate();
    workers[part] = null;
  }
  ready[part] = false;
}

// iPhone / iPad: the page reader and the voice are not kept in memory together (see Reader.tsx).
export function lowMemoryPhone(): boolean {
  return settings().lowMemory;
}

// Starts downloading (or reading from the phone's cache) and loading the models.
export function loadModels(parts: Part[]): void {
  const { debug, voiceGpu, lowMemory } = settings();
  if (lowMemory && parts.indexOf("ocr") >= 0 && parts.indexOf("voice") >= 0 && !ready.ocr) {
    // One after the other: each needs ~200 MB while it loads, and an older iPhone closes the tab
    // when both peak together. The voice follows as soon as the page reader is ready (or failed).
    send("ocr", { type: "load", parts: ["ocr"], debug, voiceGpu, lowMemory });
    const stop = listen(function (msg) {
      if (msg.type === "ready" && msg.part === "ocr") {
        stop();
        send("voice", { type: "load", parts: ["voice"], debug, voiceGpu, lowMemory });
      }
    });
    return;
  }
  parts.forEach(function (item) {
    send(item, { type: "load", parts, debug, voiceGpu, lowMemory });
  });
}

// One downscaled camera frame -> where the text is (null: the models aren't loaded, or the worker
// didn't answer in time: aiming goes on and asks again).
export function analyze(frame: ImageBitmap): Promise<FrameCheck | null> {
  const id = nextId++;
  return new Promise(function (resolve) {
    const timer = setTimeout(function () {
      stop();
      resolve(null);
    }, 15000);
    const stop = listen(function (msg) {
      if (msg.type === "analysis" && msg.id === id) {
        clearTimeout(timer);
        stop();
        resolve(msg.check);
      } else if (msg.type === "ready" && msg.part === "ocr" && !msg.ok) {
        clearTimeout(timer);
        stop();
        resolve(null);
      }
    });
    send("ocr", { type: "analyze", id, frame }, [frame]);
  });
}

export interface Reading {
  cancel: () => void;
}

// Google Cloud Vision for the page text (server/vision.py): reads Mongolian letters (ө, ү) and
// punctuation more reliably than the phone's small model. Used while the server has a key; the first
// failure (offline, quota) switches to the phone's reader for the rest of the visit.
let cloudText = false;
export function setCloudOcr(on: boolean): void {
  cloudText = on;
}
export function cloudOcr(): boolean {
  return cloudText;
}

// The photo as JPEG, small enough for the server (<= 4 MB).
async function jpegOf(photo: ImageBitmap): Promise<Blob> {
  const c = new OffscreenCanvas(photo.width, photo.height);
  (c.getContext("2d") as OffscreenCanvasRenderingContext2D).drawImage(photo, 0, 0);
  let blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  if (blob.size > 3.5 * 1024 * 1024) {
    blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.75 });
  }
  return blob;
}

// The page's lines from the cloud, in reading order; null if that failed (the phone then reads it).
export async function readPageCloud(photo: ImageBitmap): Promise<PageLine[] | null> {
  try {
    const t = performance.now();
    const jpeg = await jpegOf(photo);
    const res = await fetch("/api/reader/ocr", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: jpeg });
    if (!res.ok) {
      throw new Error("reader ocr " + res.status);
    }
    const body = (await res.json()) as { lines: PageLine[] };
    console.log("[reader] cloud ocr: " + body.lines.length + " lines, " + Math.round(jpeg.size / 1024) + " KB, " + Math.round(performance.now() - t) + " ms");
    return body.lines;
  } catch (e) {
    console.warn("[reader] cloud ocr failed, the phone reads pages from now on", e);
    cloudText = false;
    return null;
  }
}

// A captured page: lines arrive in reading order, a few at a time, until `done`.
export function readPage(
  photo: ImageBitmap,
  onLines: (lines: PageLine[], done: boolean, turned: number, total: number) => void,
  onFailed: () => void,
): Reading {
  const id = nextId++;
  const stop = listen(function (msg) {
    if (msg.type === "lines" && msg.id === id) {
      if (msg.done) {
        stop();
      }
      onLines(msg.lines, msg.done, msg.turned, msg.total);
    } else if (msg.type === "failed" && msg.id === id) {
      stop();
      onFailed();
    }
  });
  send("ocr", { type: "read", id, photo }, [photo]);
  return {
    cancel: function () {
      stop();
      send("ocr", { type: "cancel", id });
    },
  };
}

// A sentence in the reading voice, arriving piece by piece (split at punctuation).
export class SpeechStream {
  private pieces: { samples: Float32Array; rate: number }[] = [];
  private done = false;
  private waiters: (() => void)[] = [];

  add(samples: Float32Array | null, rate: number, last: boolean): void {
    if (samples) {
      this.pieces.push({ samples, rate });
    }
    this.done = this.done || last;
    const w = this.waiters;
    this.waiters = [];
    w.forEach(function (item) {
      item();
    });
  }

  // Piece i once it's made; null when the sentence has fewer pieces.
  async piece(i: number): Promise<{ samples: Float32Array; rate: number } | null> {
    while (i >= this.pieces.length && !this.done) {
      const waiters = this.waiters;
      await new Promise<void>(function (resolve) {
        waiters.push(resolve);
      });
    }
    return this.pieces[i] ?? null;
  }
}

// null: no voice is ready (the reader then waits for it: never the phone's own Russian voice).
// `around`: the sentences before and after, for the cloud voice's flow.
export function synthesize(text: string, urgent: boolean, around?: { previous: string; next: string }): SpeechStream | null {
  if (cloud) {
    const stream = new SpeechStream();
    fromCloud(stream, text, urgent, around);
    return stream;
  }
  if (!ready.voice) {
    return null;
  }
  const stream = new SpeechStream();
  onPhone(stream, text, urgent);
  return stream;
}

let decoder: OfflineAudioContext | null = null;

// ElevenLabs takes 2 requests at a time on the free plan: the rest wait here, the sentence being read
// first (urgent) before the ones made ahead.
const CLOUD_AT_ONCE = 2;
let cloudBusy = 0;
const cloudWaiting: { urgent: boolean; go: () => void }[] = [];
function cloudTurn(urgent: boolean): Promise<void> {
  if (cloudBusy < CLOUD_AT_ONCE) {
    cloudBusy++;
    return Promise.resolve();
  }
  return new Promise<void>(function (resolve) {
    const job = { urgent, go: resolve };
    if (urgent) {
      cloudWaiting.unshift(job);
    } else {
      cloudWaiting.push(job);
    }
  });
}
function cloudDone(): void {
  const next = cloudWaiting.shift();
  if (next) {
    next.go(); // the place passes on
  } else {
    cloudBusy--;
  }
}

async function cloudMp3(text: string, urgent: boolean, around?: { previous: string; next: string }): Promise<ArrayBuffer> {
  for (let attempt = 0; ; attempt++) {
    await cloudTurn(urgent);
    let res: Response;
    try {
      res = await fetch("/api/reader/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, previous: around?.previous ?? "", next: around?.next ?? "" }),
      });
    } finally {
      cloudDone();
    }
    if (res.status === 429 && attempt < 4) {
      await new Promise(function (resolve) {
        setTimeout(resolve, 700 * (attempt + 1)); // another request still running there: ask again
      });
      continue;
    }
    if (!res.ok) {
      throw new Error("reader voice " + res.status);
    }
    return res.arrayBuffer();
  }
}

async function fromCloud(stream: SpeechStream, text: string, urgent: boolean, around?: { previous: string; next: string }): Promise<void> {
  try {
    const mp3 = await cloudMp3(text, urgent, around);
    if (!decoder) {
      decoder = new OfflineAudioContext(1, 1, 44100);
    }
    const audio = await decoder.decodeAudioData(mp3);
    stream.add(audio.getChannelData(0), audio.sampleRate, true);
  } catch (e) {
    console.warn("[reader] cloud voice failed, the phone's voice reads from now on", e);
    cloud = false;
    // This sentence too, once the phone's voice is loaded.
    if (ready.voice) {
      onPhone(stream, text, urgent);
      return;
    }
    const stop = listen(function (msg) {
      if (msg.type === "ready" && msg.part === "voice") {
        stop();
        if (msg.ok) {
          onPhone(stream, text, urgent);
        } else {
          stream.add(null, 16000, true);
        }
      }
    });
    loadModels(["voice"]);
  }
}

function onPhone(stream: SpeechStream, text: string, urgent: boolean): void {
  const id = nextId++;
  const stop = listen(function (msg) {
    if (msg.type === "audio" && msg.id === id) {
      if (msg.last) {
        stop();
      }
      stream.add(msg.samples, msg.rate, msg.last);
    }
  });
  send("voice", { type: "speak", id, text, urgent });
}
