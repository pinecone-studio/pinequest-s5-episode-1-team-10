// Messages between the reader's page (lib/reader/engine.ts) and its worker (engine.worker.ts).
import type { PageLine } from "./sentences";

export type Part = "ocr" | "voice";

// What one camera frame shows, for aiming by sound (lib/reader/aim.ts).
export interface FrameCheck {
  lines: number; // text lines found
  box: [number, number, number, number]; // text area: x0, y0, x1, y1 as fractions of the frame
  cut: { left: boolean; right: boolean; top: boolean; bottom: boolean }; // text runs off that edge
  lineHeight: number; // median line height / frame height
  brightness: number; // 0..1
  sharpness: number; // Laplacian variance of the frame (relative; compared frame to frame)
}

export type ToEngine =
  // lowMemory: iPhone/iPad (Safari closes a tab that uses too much memory): one thread per runtime
  | { type: "load"; parts: Part[]; debug: boolean; voiceGpu: boolean; lowMemory: boolean }
  | { type: "analyze"; id: number; frame: ImageBitmap }
  | { type: "read"; id: number; photo: ImageBitmap }
  | { type: "cancel"; id: number }
  | { type: "speak"; id: number; text: string; urgent: boolean }; // urgent: the sentence being read now

export type FromEngine =
  | { type: "progress"; part: Part; loaded: number; total: number }
  | { type: "ready"; part: Part; ok: boolean; error?: string }
  | { type: "analysis"; id: number; check: FrameCheck | null }
  // Lines in reading order, a few at a time; `turned`: the photo was turned by this many degrees.
  | { type: "lines"; id: number; lines: PageLine[]; done: boolean; turned: number; total: number }
  // A sentence's audio, piece by piece (split at punctuation); `last` ends it (samples may be null).
  | { type: "audio"; id: number; samples: Float32Array | null; rate: number; last: boolean }
  | { type: "log"; text: string } // timings, with ?debug=1
  | { type: "files"; urls: string[] } // files the worker loaded (kept for offline use by public/read-sw.js)
  | { type: "failed"; id: number; message: string };
