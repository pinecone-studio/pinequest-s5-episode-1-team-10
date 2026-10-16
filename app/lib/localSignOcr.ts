// The page's side of the on-device sign reader (lib/signOcr.worker.ts): loaded when the bus screen
// opens, races Azure on each LED crop (components/BusScanner.tsx). Turns itself off on a phone where it
// is slow (median over SLOW_MS after SAMPLES reads), remembered on that phone: Azure only there.
const WORKER_URL = "/sign-ocr-worker.js";
const SLOW_MS = 150;
const SAMPLES = 5;
const OFF_KEY = "avtobus.localSignOcr";

export interface LocalRead {
  text: string;
  conf: number;
  ms: number; // inference in the worker
}

let worker: Worker | null = null;
let ready = false;
let backend = "";
let nextId = 1;
const waiting = new Map<number, (r: LocalRead | null) => void>();
const times: number[] = [];

function remembered(): boolean {
  try {
    return window.localStorage.getItem(OFF_KEY) === "off";
  } catch {
    return false;
  }
}

let off = typeof window !== "undefined" && (remembered() || new URLSearchParams(window.location.search).get("localocr") === "0");

export function localOcrState(): string {
  return off ? "off" : ready ? backend : worker ? "loading" : "not started";
}

export function localOcrReady(): boolean {
  return ready && !off;
}

export function loadLocalOcr(): void {
  if (worker || off || typeof Worker === "undefined") {
    return;
  }
  try {
    worker = new Worker(WORKER_URL);
  } catch {
    return;
  }
  worker.onmessage = function (e: MessageEvent<{ type: string; ok?: boolean; backend?: string; id?: number; text?: string; conf?: number; ms?: number; error?: string }>) {
    const d = e.data;
    if (d.type === "ready") {
      ready = !!d.ok;
      backend = d.backend ?? "";
      console.info("[local-ocr] " + (ready ? "ready on " + backend : "failed: " + d.error));
      return;
    }
    const done = waiting.get(d.id as number);
    waiting.delete(d.id as number);
    if (!done) {
      return;
    }
    if (d.error) {
      done(null);
      return;
    }
    record(d.ms ?? 0);
    done({ text: d.text ?? "", conf: d.conf ?? 0, ms: d.ms ?? 0 });
  };
  worker.onerror = function () {
    ready = false;
  };
  worker.postMessage({ type: "load" });
}

function record(ms: number): void {
  times.push(ms);
  if (times.length > 50) {
    times.shift();
  }
  if (times.length >= SAMPLES && median(times) > SLOW_MS && !off) {
    off = true;
    console.info("[local-ocr] median " + median(times) + " ms > " + SLOW_MS + " ms on this phone: off, Azure only");
    try {
      window.localStorage.setItem(OFF_KEY, "off");
    } catch {
      // storage blocked: off for this visit only
    }
  }
}

function median(values: number[]): number {
  const s = values.slice().sort(function (a, b) {
    return a - b;
  });
  return s[Math.floor(s.length / 2)];
}

// One crop read on the phone; null if not ready, failed, or `signal` aborted (the other read won).
export function readLocal(source: HTMLCanvasElement, signal?: AbortSignal): Promise<LocalRead | null> {
  if (!localOcrReady() || !worker) {
    return Promise.resolve(null);
  }
  const w = worker;
  return createImageBitmap(source)
    .then(function (bitmap) {
      return new Promise<LocalRead | null>(function (resolve) {
        const id = nextId++;
        waiting.set(id, resolve);
        if (signal) {
          signal.addEventListener("abort", function () {
            if (waiting.delete(id)) {
              resolve(null);
            }
          });
        }
        w.postMessage({ type: "read", id, bitmap }, [bitmap]);
      });
    })
    .catch(function () {
      return null;
    });
}
