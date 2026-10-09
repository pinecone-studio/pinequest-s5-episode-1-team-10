// "Sound sonar" toward the bus door: short blips panned left/right to where the door is, faster as
// the rider turns toward it (like a parking sensor), a steady high tone when it's straight ahead.
let ctx: AudioContext | null = null;
let panner: StereoPannerNode | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let angle = 0;
let running = false;

// Call inside a touch handler (iOS) before start().
export function primeBeacon(): void {
  if (!ctx && typeof AudioContext !== "undefined") {
    ctx = new AudioContext();
    panner = ctx.createStereoPanner();
    panner.connect(ctx.destination);
  }
  if (ctx && ctx.state === "suspended") {
    ctx.resume();
  }
}

function blip(): void {
  if (!ctx || !panner) {
    return;
  }
  const ahead = Math.abs(angle) < 8;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = ahead ? 1320 : 760;
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.09);
  osc.connect(gain);
  gain.connect(panner);
  osc.start();
  osc.stop(ctx.currentTime + 0.1);
}

function loop(): void {
  if (!running) {
    return;
  }
  blip();
  // 90 ms apart when the door is straight ahead, up to ~900 ms when it's 3 o'clock / 9 o'clock.
  timer = setTimeout(loop, 90 + Math.min(810, Math.abs(angle) * 9));
}

export function aimBeacon(degrees: number): void {
  angle = degrees;
  if (panner && ctx) {
    panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, degrees / 40)), ctx.currentTime, 0.05);
  }
}

export function startBeacon(): void {
  primeBeacon();
  if (!running) {
    running = true;
    loop();
  }
}

export function stopBeacon(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
  }
}
