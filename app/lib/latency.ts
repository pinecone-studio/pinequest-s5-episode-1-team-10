// How long from "this is your bus" (the match decided) to the first audio sample the rider hears, and
// from the camera frame that decided it (OCR included). Target: match -> first sample under 50 ms.
// Logged as "[latency] ..." (console), kept on window.__latency, and shown on the camera's ?debug=1 line.
let pending: { what: string; decidedAt: number; frameAt: number | null; firstAt: number | null } | null = null;
let shown = "";

export function markDecided(what: string, decidedAt: number, frameAt: number | null): void {
  pending = { what, decidedAt, frameAt, firstAt: null };
}

// For the debug overlay: the last measurement.
export function latencyText(): string {
  return shown;
}

function record(kind: string, at: number, first: boolean): void {
  const p = pending;
  if (!p) {
    return;
  }
  const decided = Math.round(at - p.decidedAt);
  const frame = p.frameAt === null ? null : Math.round(at - p.frameAt);
  const store = window as unknown as { __latency: Record<string, unknown> };
  if (first) {
    p.firstAt = at;
    shown = "match → sound " + decided + " ms" + (frame === null ? "" : " (frame → sound " + frame + " ms)");
    console.info("[latency] " + p.what + ": match -> first audio sample (" + kind + ") " + decided + " ms" + (frame === null ? "" : ", frame -> first sample " + frame + " ms") + (decided > 50 ? " (over the 50 ms target)" : ""));
    store.__latency = { what: p.what, firstSound: kind, decidedMs: decided, frameMs: frame };
  } else {
    shown += " · first word " + decided + " ms";
    console.info("[latency] " + p.what + ": match -> first word " + decided + " ms");
    store.__latency.firstWordMs = decided;
    pending = null;
  }
}

// When a sample scheduled on the Web Audio clock (`ctxTime`) reaches the speaker, in performance.now()
// time: through the context's output timestamp (which includes the output latency) when it has one.
export function audioOutputAt(c: AudioContext, ctxTime: number): number {
  const ts = typeof c.getOutputTimestamp === "function" ? c.getOutputTimestamp() : null;
  if (ts && ts.performanceTime && ts.contextTime !== undefined && c.state === "running") {
    return ts.performanceTime + (ctxTime - ts.contextTime) * 1000;
  }
  const out = (c as AudioContext & { outputLatency?: number }).outputLatency || c.baseLatency || 0;
  return performance.now() + (ctxTime - c.currentTime + out) * 1000;
}

// A Web Audio sound scheduled to start at `ctxTime` (earcon, or the first word).
export function soundScheduled(kind: "earcon" | "voice", c: AudioContext, ctxTime: number): void {
  if (pending) {
    record(kind, audioOutputAt(c, ctxTime), pending.firstAt === null);
  }
}

// An <audio> clip that just started playing (the fallback when a clip wasn't in memory).
export function soundStarted(kind: "tone" | "voice"): void {
  if (pending && (kind === "voice" || pending.firstAt === null)) {
    record(kind, performance.now(), pending.firstAt === null);
  }
}
