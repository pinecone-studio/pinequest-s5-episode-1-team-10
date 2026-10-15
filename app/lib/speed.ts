// How long one spoken question takes, step by step: hold -> listening -> speech end -> text ->
// answer -> first audio. Logged as "[speed] ..." in the console; with ?speed=1 also shown on screen,
// so it can be read on a phone without a cable.

let start = 0; // when the hold fired; 0 = nothing being measured
let last = 0;
let parts: string[] = [];
let waitingForAudio = false;
let report: ((line: string) => void) | null = null;

export function showSpeed(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("speed") === "1";
}

// RiderFlow passes a setter here to show the last measurement on screen.
export function onSpeedReport(fn: (line: string) => void): void {
  report = fn;
}

export function speedStart(): void {
  start = last = performance.now();
  parts = [];
  waitingForAudio = false;
}

export function speedMark(name: string): void {
  if (!start) {
    return;
  }
  const now = performance.now();
  const step = name + " " + Math.round(now - last) + "ms";
  last = now;
  parts.push(step);
  console.log("[speed] " + step);
  if (name === "answer") {
    waitingForAudio = true;
  }
}

// The first clip of the answer started playing (lib/speech.ts): the measurement is complete.
export function speedAudio(): void {
  if (!start || !waitingForAudio) {
    return;
  }
  speedMark("audio");
  const line = parts.join(" | ") + " | total " + Math.round(performance.now() - start) + "ms";
  console.log("[speed] " + line);
  start = 0;
  waitingForAudio = false;
  if (report) {
    report(line);
  }
}

// Nothing to measure further (not heard, server down).
export function speedCancel(): void {
  if (start) {
    console.log("[speed] stopped: " + parts.join(" | "));
  }
  start = 0;
  waitingForAudio = false;
}
