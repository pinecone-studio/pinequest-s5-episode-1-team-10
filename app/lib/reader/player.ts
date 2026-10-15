// What the reader says and sounds:
//   - sentences in the Mongolian reading voice (16 kHz from the worker), at the rider's speed with the
//     pitch kept (blind readers often listen at 1.5-2x)
//   - fixed sentences ("Хуудас дууслаа") from their pre-made OronTTS clip when there is one
//   - never the phone's own voice (it would read Mongolian with a Russian voice): until the Mongolian
//     voice is ready, a soft loading sound plays instead
//   - short sounds: aiming ticks, the shutter, the "unsure line" tone, page end
import { hasClip, say, sharedAudio, stopSpeaking, unlockAudio } from "../speech";
import { isReady, listen, loadModels, synthesize, type SpeechStream } from "./engine";

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

// The app's one audio element (lib/speech.ts): unlocked by the first touch, even on the bus screens.
const audio = sharedAudio();
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
}

function wavUrl(clip: Clip): string {
  const n = clip.samples.length;
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  function text(at: number, s: string): void {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(at + i, s.charCodeAt(i));
    }
  }
  text(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, clip.rate, true);
  view.setUint32(28, clip.rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, clip.samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return URL.createObjectURL(new Blob([view], { type: "audio/wav" }));
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

// A sentence in the reading voice.
export function playClip(clip: Clip, speed: number): Playing {
  stopPlayer();
  const url = wavUrl(clip);
  let finish: (ok: boolean) => void = function () {};
  const done = new Promise<boolean>(function (resolve) {
    finish = function (ok: boolean) {
      URL.revokeObjectURL(url);
      resolve(ok);
    };
  });
  let stopped = false;
  // A stalled clip (audio focus taken by a call) must never freeze the reading.
  let timer: ReturnType<typeof setTimeout> | null = null;
  function guard(): void {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(function () {
      end(true);
    }, ((clip.samples.length / clip.rate) * 1000) / speed + 3000);
  }
  function end(ok: boolean): void {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
    finish(ok);
  }
  const playing: Playing = {
    done,
    pause: function () {
      if (audio && !stopped) {
        audio.pause();
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
    resume: function () {
      if (audio && !stopped) {
        audio.play().catch(function () {
          end(true);
        });
        guard();
      }
    },
    stop: function () {
      if (audio && !stopped) {
        audio.pause();
      }
      end(false);
    },
  };
  current = playing;
  if (!audio) {
    end(true);
    return playing;
  }
  audio.onended = function () {
    end(true);
  };
  audio.onerror = function () {
    end(true);
  };
  audio.src = url;
  audio.playbackRate = speed;
  if (new URLSearchParams(window.location.search).get("debug") === "1") {
    console.log("[reader] playing " + (clip.samples.length / clip.rate).toFixed(1) + " s at " + speed + "x");
  }
  audio.preservesPitch = true;
  audio.play().catch(function () {
    end(true);
  });
  guard();
  return playing;
}

// A sentence as it arrives, piece by piece: the first words play while the rest is still being made.
// Pause/resume act on the piece playing (or the next one, if paused between pieces).
export function playStream(stream: SpeechStream, speed: number): Playing {
  let stopped = false;
  let paused = false;
  let piece: Playing | null = null;
  let finish: (ok: boolean) => void = function () {};
  const done = new Promise<boolean>(function (resolve) {
    finish = resolve;
  });
  (async function () {
    for (let i = 0; ; i++) {
      const next = await stream.piece(i);
      if (stopped) {
        return;
      }
      if (!next) {
        finish(true);
        return;
      }
      piece = playClip(next, speed);
      if (paused) {
        piece.pause();
      }
      if (!(await piece.done)) {
        stopped = true;
        finish(false);
        return;
      }
    }
  })();
  return {
    done,
    pause: function () {
      paused = true;
      if (piece) {
        piece.pause();
      }
    },
    resume: function () {
      paused = false;
      if (piece) {
        piece.resume();
      }
    },
    stop: function () {
      stopped = true;
      if (piece) {
        piece.stop();
      }
      finish(false);
    },
  };
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
