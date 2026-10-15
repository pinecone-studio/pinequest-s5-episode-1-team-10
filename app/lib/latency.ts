// How long from "this is your bus" (the match decided) to the first sound the rider hears, and from
// the camera frame that decided it to that sound (OCR included). Target: decided -> first sound under
// 50 ms. Logged as "[latency] ..." (console); the last one is kept on window.__latency for tests.
let pending: { what: string; decidedAt: number; frameAt: number | null; firstAt: number | null } | null = null;

export function markDecided(what: string, decidedAt: number, frameAt: number | null): void {
  pending = { what, decidedAt, frameAt, firstAt: null };
}

// Called by lib/speech.ts when a sound really starts: "tone" (Web Audio cue) or "voice" (a clip).
export function soundStarted(kind: "tone" | "voice"): void {
  const p = pending;
  if (!p) {
    return;
  }
  const now = performance.now();
  const decided = Math.round(now - p.decidedAt);
  const frame = p.frameAt === null ? null : Math.round(now - p.frameAt);
  if (p.firstAt === null) {
    p.firstAt = now;
    console.info("[latency] " + p.what + ": decided -> first sound (" + kind + ") " + decided + " ms" + (frame === null ? "" : ", frame -> first sound " + frame + " ms") + (decided > 50 ? " (over the 50 ms target)" : ""));
    (window as unknown as { __latency: unknown }).__latency = { what: p.what, firstSound: kind, decidedMs: decided, frameMs: frame };
  }
  if (kind === "voice") {
    console.info("[latency] " + p.what + ": decided -> first word " + decided + " ms" + (frame === null ? "" : ", frame -> first word " + frame + " ms"));
    (window as unknown as { __latency: Record<string, unknown> }).__latency.firstWordMs = decided;
    pending = null;
  }
}
