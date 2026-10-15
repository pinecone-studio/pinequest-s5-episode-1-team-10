// What the reader says and sounds:
//   - sentences in the Mongolian reading voice (16 kHz from the worker), at the rider's speed with the
//     pitch kept (blind readers often listen at 1.5-2x)
//   - fixed sentences ("Хуудас дууслаа") from their pre-made OronTTS clip when there is one
//   - never the phone's own voice (it would read Mongolian with a Russian voice): until the Mongolian
//     voice is ready, a soft loading sound plays instead
//   - short sounds: aiming ticks, the shutter, the "unsure line" tone, page end
import { hasClip, say, stopSpeaking, unlockAudio } from "../speech";
import { isReady, listen, loadModels, synthesize, type SpeechStream } from "./engine";
import { stretch } from "./stretch";

export interface Clip {
  samples: Float32Array;
  rate: number;
}

export interface Playing {
  done: Promise<boolean>; // true: played to the end; false: stopped
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

let sounds: AudioContext | null = null;

// iPhone: with the ringer switch on silent, Web Audio (the aiming ticks, the loading sound) is muted
// unless the page says it plays media. "auto" again when leaving, so the bus screens' microphone works.
function audioSession(type: "playback" | "auto"): void {
  const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
  if (session && session.type !== type) {
    try {
      session.type = type;
    } catch {
      // older Safari: the ticks follow the ringer switch
    }
  }
}

export function releasePlayer(): void {
  audioSession("auto");
}

// Inside a touch: iPhones only play sound from elements (and audio contexts) started by one.
export function unlockPlayer(): void {
  audioSession("playback");
  unlockAudio();
  if (!sounds && typeof AudioContext !== "undefined") {
    sounds = new AudioContext();
  }
  if (sounds && sounds.state === "suspended") {
    sounds.resume().catch(function () {});
  }
  const v = voiceContext(); // made inside the touch, so the iPhone lets it play
  if (v && v.state === "suspended" && !current) {
    v.resume().catch(function () {});
  }
}

let current: Playing | null = null;
let generation = 0; // bumped whenever something new is said: a prompt still waiting gives up

export function stopPlayer(): void {
  generation++;
  if (current) {
    current.stop();
    current = null;
  }
  stopSpeaking();
}

// The reading voice has its own audio context (unlocked by a touch, unlockPlayer): its pieces are
// queued back to back on one clock, so there is no gap between phrases or sentences. (One <audio>
// element swapping a file per phrase stalled briefly at every comma on iPhone.) Pause = the clock stops.
let voiceOut: AudioContext | null = null;
function voiceContext(): AudioContext | null {
  if (!voiceOut && typeof AudioContext !== "undefined") {
    voiceOut = new AudioContext();
  }
  return voiceOut;
}

const debugOn = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "1";

// A sentence as it arrives, piece by piece: the first words play while the rest is still being made;
// each piece is queued right after the one before, at the rider's speed (pitch kept, lib/reader/stretch.ts).
export function playStream(stream: SpeechStream, speed: number): Playing {
  stopPlayer();
  const ctx = voiceContext();
  let stopped = false;
  let paused = false;
  let finish: (ok: boolean) => void = function () {};
  const done = new Promise<boolean>(function (resolve) {
    finish = resolve;
  });
  const sources: AudioBufferSourceNode[] = [];
  let endsAt = 0; // on the context's clock
  let playing = 0; // pieces queued and not yet ended
  let made = false; // the last piece has been queued
  // A clock that stalls (audio taken by a call, the phone's audio session lost) must never freeze the
  // reading: if nothing ends long after it should have, the sentence counts as said.
  let guard: ReturnType<typeof setTimeout> | null = null;
  function watch(): void {
    if (guard) {
      clearTimeout(guard);
    }
    guard = null;
    if (!ctx || paused || stopped) {
      return;
    }
    guard = setTimeout(
      function () {
        if (!paused && ctx.state !== "running") {
          ctx.resume().catch(function () {});
        }
        end(true);
      },
      Math.max(0, endsAt - ctx.currentTime) * 1000 + 3000,
    );
  }
  function end(ok: boolean): void {
    if (stopped) {
      return;
    }
    stopped = true;
    if (guard) {
      clearTimeout(guard);
    }
    sources.forEach(function (item) {
      item.onended = null;
      try {
        item.stop();
      } catch {
        // not started yet
      }
      item.disconnect();
    });
    if (current === self) {
      current = null;
    }
    finish(ok);
  }
  const self: Playing = {
    done,
    pause: function () {
      paused = true;
      if (ctx && !stopped) {
        ctx.suspend().catch(function () {});
      }
      watch();
    },
    resume: function () {
      paused = false;
      if (ctx && !stopped) {
        ctx.resume().catch(function () {});
      }
      watch();
    },
    stop: function () {
      end(false);
    },
  };
  current = self;
  if (!ctx) {
    end(true);
    return self;
  }
  if (ctx.state !== "running") {
    ctx.resume().catch(function () {});
  }
  (async function () {
    for (let i = 0; ; i++) {
      const next = await stream.piece(i);
      if (stopped) {
        return;
      }
      if (!next) {
        made = true;
        if (playing === 0) {
          end(true);
        }
        return;
      }
      const samples = stretch(next.samples, speed, next.rate);
      if (debugOn) {
        console.log("[reader] piece " + i + ": " + (samples.length / next.rate).toFixed(1) + " s at " + speed + "x" + (i > 0 && endsAt < ctx.currentTime ? ", " + Math.round((ctx.currentTime - endsAt) * 1000) + " ms late" : ""));
      }
      const buffer = ctx.createBuffer(1, samples.length, next.rate);
      buffer.getChannelData(0).set(samples);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const at = Math.max(ctx.currentTime + 0.02, endsAt);
      src.start(at);
      endsAt = at + buffer.duration;
      sources.push(src);
      playing++;
      src.onended = function () {
        playing--;
        if (made && playing === 0) {
          end(true);
        }
      };
      watch();
    }
  })();
  return self;
}

// Resolves true when the Mongolian voice is ready (false if it failed to load; it is then asked to load
// again). A soft loading sound plays meanwhile, so the rider knows the app is working.
let waiting: Promise<boolean> | null = null;
export function waitForVoice(): Promise<boolean> {
  if (isReady("voice")) {
    return Promise.resolve(true);
  }
  if (!waiting) {
    waiting = new Promise<boolean>(function (resolve) {
      loadingSound();
      const timer = setInterval(loadingSound, 1600);
      const stop = listen(function (msg) {
        if (msg.type === "ready" && msg.part === "voice") {
          clearInterval(timer);
          stop();
          waiting = null;
          if (!msg.ok) {
            setTimeout(function () {
              loadModels(["voice"]);
            }, 3000);
          }
          resolve(msg.ok);
        }
      });
    });
  }
  return waiting;
}

const promptAudio = new Map<string, SpeechStream>(); // kept: guidance repeats

// A fixed sentence of the reader: its pre-made OronTTS clip if there is one, else the reading voice.
//   "wait": said as soon as the Mongolian voice is ready (loading sound until then)
//   "now":  only useful right now (aiming hints): skipped if it can't be said yet
// Resolves when it has been said, skipped, or cut off by something newer.
export async function prompt(text: string, when?: "wait" | "now"): Promise<void> {
  const mine = ++generation;
  if (hasClip(text)) {
    if (current) {
      current.stop();
      current = null;
    }
    await say([text]);
    return;
  }
  if (!isReady("voice")) {
    if (when === "now" || !(await waitForVoice()) || mine !== generation) {
      return;
    }
  }
  let stream = promptAudio.get(text) ?? null;
  if (!stream) {
    stream = synthesize(text, true);
    if (!stream) {
      return;
    }
    promptAudio.set(text, stream);
  }
  await stream.piece(0); // made before anything newer cut in?
  if (mine === generation) {
    await playStream(stream, 1).done;
  }
}

// --- short sounds -------------------------------------------------------------------------------

function tone(freq: number, ms: number, volume: number, type: OscillatorType, delay?: number): void {
  if (!sounds) {
    return;
  }
  const t = sounds.currentTime + (delay ?? 0);
  const osc = sounds.createOscillator();
  const gain = sounds.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(gain);
  gain.connect(sounds.destination);
  osc.start(t);
  osc.stop(t + ms / 1000 + 0.02);
}

// Aiming: a soft tick, higher when the text is better in view (0..1).
export function tick(quality: number): void {
  tone(350 + 900 * Math.max(0, Math.min(1, quality)), 35, 0.12, "sine");
}

export function shutter(): void {
  if (!sounds) {
    return;
  }
  const t = sounds.currentTime;
  const n = Math.round(sounds.sampleRate * 0.09);
  const buf = sounds.createBuffer(1, n, sounds.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
  }
  const src = sounds.createBufferSource();
  const gain = sounds.createGain();
  gain.gain.value = 0.35;
  src.buffer = buf;
  src.connect(gain);
  gain.connect(sounds.destination);
  src.start(t);
}

// Before a line read with low confidence: it may have mistakes.
export function unsureTone(): Promise<void> {
  tone(240, 140, 0.15, "triangle");
  return new Promise(function (resolve) {
    setTimeout(resolve, 180);
  });
}

export function pageEndChime(): void {
  tone(660, 160, 0.15, "sine");
  tone(880, 220, 0.15, "sine", 0.16);
}

export function errorTone(): void {
  tone(180, 220, 0.18, "square");
}

// Waiting for the Mongolian voice (or the page reader): two soft low notes, like breathing.
export function loadingSound(): void {
  tone(294, 180, 0.07, "sine");
  tone(349, 220, 0.07, "sine", 0.22);
}
