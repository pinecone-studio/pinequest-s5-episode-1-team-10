// Mongolian speech from the server's OronTTS (/api/tts). Each sentence is its own cached clip.
import phrases from "../../shared/phrases.json";
import { speedAudio } from "./speed";

export type PhraseKey = keyof typeof phrases;

// iPhone plays sound only from things started inside a touch. So EVERY touch (not only the first)
// re-unlocks both ways of playing: one audio element for every clip, and a Web Audio context that
// takes over if the element is still refused. iOS 17+: audio session "playback", so clips are heard
// even with the ringer switch on silent. (Before: one attempt with an empty WAV, which iPhones can
// refuse, and then every later clip was silently skipped.)
const audio = typeof Audio === "undefined" ? null : new Audio();
let ctx: AudioContext | null = null;
let elementUnlocked = false;
let synthUnlocked = false;
let silence = "";
let turn = 0; // bumped on every say(): older queues stop
let finish: (() => void) | null = null; // resolves the clip that's playing

export function phrase(key: PhraseKey): string {
  return phrases[key];
}

// 0.1 s of real silence (a WAV with samples: iPhones refuse an empty one).
function silentWav(): string {
  if (!silence) {
    const n = 800; // 8 kHz, 8-bit mono
    const bytes = new Uint8Array(44 + n);
    const v = new DataView(bytes.buffer);
    const text = function (at: number, s: string): void {
      for (let i = 0; i < s.length; i++) {
        bytes[at + i] = s.charCodeAt(i);
      }
    };
    text(0, "RIFF");
    v.setUint32(4, 36 + n, true);
    text(8, "WAVEfmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true);
    v.setUint32(28, 8000, true);
    v.setUint16(32, 1, true);
    v.setUint16(34, 8, true);
    text(36, "data");
    v.setUint32(40, n, true);
    bytes.fill(128, 44);
    silence = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  }
  return silence;
}

// The shared Web Audio context (also for the beep), resumed by the last touch.
export function audioContext(): AudioContext | null {
  if (!ctx && typeof window !== "undefined" && typeof AudioContext !== "undefined") {
    ctx = new AudioContext();
  }
  return ctx;
}

// Inside a touch/click/key handler. Safe to call on every one.
export function unlockAudio(): void {
  if (typeof window === "undefined") {
    return;
  }
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  // (Not while the microphone is on: lib/speechmatics.ts sets "play-and-record" for that and back after.)
  if (session && session.type !== "play-and-record") {
    try {
      session.type = "playback";
    } catch {
      // older iOS: the ringer switch decides
    }
  }
  const c = audioContext();
  if (c) {
    if (c.state !== "running") {
      c.resume().catch(function () {});
    }
    const s = c.createBufferSource();
    s.buffer = c.createBuffer(1, 1, 22050);
    s.connect(c.destination);
    s.start(0);
  }
  if (audio && !elementUnlocked && audio.paused) {
    audio.src = silentWav();
    audio
      .play()
      .then(function () {
        elementUnlocked = true;
      })
      .catch(function () {});
  }
  // The phone's own voice (for sentences without a clip) is also silent until it has spoken in a touch.
  const synth = window.speechSynthesis;
  if (synth && !synthUnlocked) {
    synthUnlocked = true;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    synth.speak(u);
  }
}

if (typeof document !== "undefined") {
  ["touchend", "pointerup", "click", "keydown"].forEach(function (item) {
    document.addEventListener(item, unlockAudio, true);
  });
}

// Text -> name of its pre-made clip (free hosting), played straight from /tts/<name>.mp3 instead of
// asking /api/tts first (~1 s per sentence on a cold server). Fixed phrases: /tts/index.json, made by
// deploy/vercel.sh. Answers: the server sends the names (AskResponse.clips), because only it can
// normalize the text exactly the way the clip was made. Not listed -> /api/tts, as before.
const clipNames = new Map<string, string>();
if (typeof window !== "undefined") {
  fetch("/tts/index.json")
    .then(function (res) {
      return res.ok ? res.json() : {};
    })
    .then(function (index: Record<string, string>) {
      Object.keys(index).forEach(function (item) {
        clipNames.set(item, index[item]);
      });
    })
    .catch(function () {});
}

// The reader's own fixed sentences, rendered into the app itself (public/reader-clips, made by
// scripts/render-reader-clips.mjs): text -> file. They play with no network and no voice model.
const localClips = new Map<string, string>();
if (typeof window !== "undefined") {
  fetch("/reader-clips/index.json")
    .then(function (res) {
      return res.ok ? res.json() : {};
    })
    .then(function (index: Record<string, string>) {
      Object.keys(index).forEach(function (item) {
        localClips.set(item, "/reader-clips/" + index[item] + ".m4a");
      });
    })
    .catch(function () {});
}

// The reader (lib/reader/player.ts) plays a fixed sentence from its pre-made clip when there is one.
export function hasClip(text: string): boolean {
  return localClips.has(text) || clipNames.has(text);
}

// The one audio element, for the reader's sentences too: on iPhones it is the element the first touch
// unlocked, and the reader is opened from the bus screens without a new touch.
export function sharedAudio(): HTMLAudioElement | null {
  return audio;
}

export function rememberClips(texts: string[], names: (string | null)[] | undefined): void {
  (names ?? []).forEach(function (item, i) {
    if (item && texts[i]) {
      clipNames.set(texts[i], item);
    }
  });
}

function apiUrl(text: string): string {
  return "/api/tts?text=" + encodeURIComponent(text);
}

function clipUrl(text: string): string {
  const local = localClips.get(text);
  if (local) {
    return local;
  }
  const name = clipNames.get(text);
  return name ? "/tts/" + name + ".mp3" : apiUrl(text);
}

// One retry: the dev proxy can hit a keep-alive socket the server just closed (ECONNRESET -> 500),
// and a skipped line ("50 метр.") is worse than a 150 ms delay.
function getAudio(url: string): Promise<Blob | null> {
  return fetch(url)
    .then(function (res) {
      if (!res.ok && res.status >= 500) {
        return new Promise<Blob | null>(function (resolve) {
          setTimeout(function () {
            fetch(url)
              .then(function (again) {
                resolve(again.ok ? again.blob() : null);
              })
              .catch(function () {
                resolve(null);
              });
          }, 150);
        });
      }
      return res.ok ? res.blob() : null;
    })
    .catch(function () {
      return null;
    });
}

// Clips kept in memory, for sentences that must play the moment they're needed (lib/announcer.ts).
const memoryClips = new Map<string, Blob>();

function clipBlob(text: string): Promise<Blob | null> {
  const kept = memoryClips.get(text);
  if (kept) {
    return Promise.resolve(kept);
  }
  const url = clipUrl(text);
  if (localClips.has(text) || url === apiUrl(text)) {
    // the reader's own clip (if it can't be had: silence, never the phone's Russian voice), or the
    // server's /api/tts already: one try
    return getAudio(url);
  }
  return getAudio(url).then(function (direct) {
    return direct ?? getAudio(apiUrl(text)); // a stale name never makes a sentence silent
  });
}

function fetchClip(text: string): Promise<string | null> {
  return clipBlob(text).then(function (found) {
    return found ? URL.createObjectURL(found) : null;
  });
}

// Downloads these clips now and keeps them in memory, so they later play with no network wait.
export function preloadClips(texts: string[]): Promise<void> {
  return Promise.all(
    texts.map(function (item) {
      return clipBlob(item).then(function (found) {
        if (found) {
          memoryClips.set(item, found);
        }
      });
    }),
  ).then(function () {});
}

// Ask the server to make clips now so they play at once later (e.g. the rider's stop name).
export function prefetch(texts: string[]): void {
  texts.forEach(function (item) {
    fetch(clipUrl(item)).catch(function () {});
  });
}

function play(url: string): Promise<void> {
  return new Promise(function (resolve) {
    if (!audio) {
      resolve();
      return;
    }
    const player = audio;
    // A stalled clip (hidden tab, audio focus taken by a call) must never freeze the flow: give up
    // a little after the clip's own length.
    let timer = setTimeout(done, 5000);
    function done(): void {
      clearTimeout(timer);
      resolve();
    }
    finish = done;
    player.onloadedmetadata = function () {
      if (Number.isFinite(player.duration)) {
        clearTimeout(timer);
        timer = setTimeout(done, player.duration * 1000 + 1500);
      }
    };
    player.onplaying = speedAudio;
    player.onended = done;
    player.onerror = done;
    player.src = url;
    player.playbackRate = 1; // the reader may have left it faster
    player.play().catch(function () {
      // Refused (iPhone without a recent touch on this element): the same clip through Web Audio.
      clearTimeout(timer);
      player.onerror = null;
      playWithContext(url).then(done);
    });
  });
}

function playWithContext(url: string): Promise<void> {
  const c = audioContext();
  if (!c) {
    return Promise.resolve();
  }
  if (c.state !== "running") {
    c.resume().catch(function () {});
  }
  return fetch(url)
    .then(function (res) {
      return res.arrayBuffer();
    })
    .then(function (bytes) {
      return c.decodeAudioData(bytes);
    })
    .then(function (buffer) {
      return new Promise<void>(function (resolve) {
        const source = c.createBufferSource();
        source.buffer = buffer;
        source.connect(c.destination);
        const timer = setTimeout(end, buffer.duration * 1000 + 1500);
        function end(): void {
          clearTimeout(timer);
          resolve();
        }
        source.onended = end;
        finish = function () {
          try {
            source.stop();
          } catch {
            // already ended
          }
          end();
        };
        speedAudio();
        source.start();
      });
    })
    .catch(function () {});
}

export function stopSpeaking(): void {
  turn++;
  if (audio) {
    audio.pause();
  }
  if (finish) {
    finish();
    finish = null;
  }
}

// Speaks the sentences in order, interrupting whatever was playing. All clips are requested at
// once so the server makes the later ones while the first plays. Resolves when done or interrupted.
let speaking: Promise<void> = Promise.resolve(); // the current queue, for sayAfter
export function say(texts: string[]): Promise<void> {
  stopSpeaking();
  speaking = playAll(texts, turn);
  return speaking;
}

// Speaks after whatever is being said now, without cutting it off (a screen's options after its
// message). A later say() or stopSpeaking() drops it, like everything queued.
export function sayAfter(texts: string[]): Promise<void> {
  const mine = turn;
  const clips = texts.map(fetchClip); // fetched now, played in turn
  speaking = speaking.then(function () {
    return mine === turn ? playClips(texts, clips, mine) : undefined;
  });
  return speaking;
}

function playAll(texts: string[], mine: number): Promise<void> {
  return playClips(texts, texts.map(fetchClip), mine);
}

async function playClips(texts: string[], clips: Promise<string | null>[], mine: number): Promise<void> {
  for (let i = 0; i < clips.length; i++) {
    const url = await clips[i];
    if (mine !== turn) {
      return;
    }
    if (url) {
      await play(url);
      URL.revokeObjectURL(url);
    } else if (texts[i].trim() && !localClips.has(texts[i])) {
      await speakWithPhone(texts[i]); // no clip (free hosting: not pre-made): never silent
    }
  }
}

// The phone's own voice for a sentence without a Mongolian clip: a Mongolian voice if the phone has
// one, else Russian (reads Cyrillic), else the default. Never waits past the sentence's length.
function speakWithPhone(text: string): Promise<void> {
  return new Promise(function (resolve) {
    const synth = typeof window === "undefined" ? null : window.speechSynthesis;
    if (!synth) {
      resolve();
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    const voices = synth.getVoices();
    const voice =
      voices.find(function (item) {
        return item.lang.toLowerCase().startsWith("mn");
      }) ??
      voices.find(function (item) {
        return item.lang.toLowerCase().startsWith("ru");
      });
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = "mn-MN";
    }
    const timer = setTimeout(resolve, 1500 + text.length * 120);
    u.onstart = speedAudio;
    u.onend = u.onerror = function () {
      clearTimeout(timer);
      resolve();
    };
    finish = function () {
      synth.cancel();
      clearTimeout(timer);
      resolve();
    };
    synth.speak(u);
  });
}

// Short beep: "speak now". Played before recording so it isn't recorded.
// Never waits more than BEEP_MAX_MS: a paused audio context (no audio device, a call took the audio,
// too many contexts on iPhone) never "ends" the tone, and voice input would hang on it forever.
const BEEP_MAX_MS = 400;

export function beep(): Promise<void> {
  return new Promise(function (resolve) {
    let done = false;
    function finish(): void {
      if (!done) {
        done = true;
        resolve();
      }
    }
    setTimeout(finish, BEEP_MAX_MS);
    try {
      // The shared context the last touch unlocked (a new one starts suspended on iPhone: no beep).
      const ctx = audioContext();
      if (!ctx) {
        finish();
        return;
      }
      ctx.resume().catch(function () {});
      const osc = ctx.createOscillator();
      osc.frequency.value = 880;
      osc.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
      osc.onended = finish;
    } catch {
      finish(); // no audio at all: record anyway
    }
  });
}

export function sayPhrase(key: PhraseKey): Promise<void> {
  return say([phrase(key)]);
}

// A soft click about once a second, so a slow GPS fix or a slow server is not silence.
// The first click is after one second: a fast answer never ticks.
export function startWaitingTick(): () => void {
  let stopped = false;
  let timer = 0;
  function click(): void {
    if (stopped) {
      return;
    }
    const c = audioContext();
    if (c) {
      if (c.state !== "running") {
        c.resume().catch(function () {});
      }
      try {
        const osc = c.createOscillator();
        const gain = c.createGain();
        gain.gain.value = 0.03;
        osc.frequency.value = 520;
        osc.connect(gain);
        gain.connect(c.destination);
        osc.start();
        osc.stop(c.currentTime + 0.04);
      } catch {
        // no audio device: the status text still says what is happening
      }
    }
    timer = window.setTimeout(click, 1000);
  }
  timer = window.setTimeout(click, 1000);
  return function () {
    stopped = true;
    window.clearTimeout(timer);
  };
}

export function vibrate(pattern: number[]): void {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    navigator.vibrate(pattern);
    return;
  }
  const c = audioContext();
  if (!c) {
    return;
  }
  if (c.state !== "running") {
    c.resume().catch(function () {});
  }
  let at = c.currentTime + 0.01;
  pattern.forEach(function (item, i) {
    if (i % 2 === 0) {
      pulse(c, at, item);
    }
    at += item / 1000;
  });
}

function pulse(c: AudioContext, at: number, ms: number): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  let freq = 1800;
  let level = 0.08;
  let len = 0.012;
  if (ms >= 400) {
    freq = 520;
    level = 0.3;
    len = Math.min(ms, 600) / 1000;
  } else if (ms >= 200) {
    osc.type = "square"; // harsh on purpose: danger
    freq = 1000;
    level = 0.25;
    len = ms / 1000;
  } else if (ms >= 100) {
    freq = 700;
    level = 0.2;
    len = ms / 1000;
  } else if (ms >= 30) {
    freq = 1200;
    level = 0.12;
    len = 0.03;
  }
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(level, at + 0.005);
  gain.gain.setValueAtTime(level, at + Math.max(0.006, len - 0.01));
  gain.gain.exponentialRampToValueAtTime(0.0001, at + len);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(at);
  osc.stop(at + len + 0.02);
}

// iPhone Safari has no vibration. These two moments also play a short sound.
export function cue(name: "bus" | "off" | "sos", pattern: number[]): void {
  vibrate(pattern);
  const c = audioContext();
  if (!c) {
    return;
  }
  if (c.state !== "running") {
    c.resume().catch(function () {});
  }
  // sos: six alternating tones, louder than the others (iPhone has no vibration: this is the signal)
  const tones = name === "bus" ? [660, 880] : name === "sos" ? [880, 1175, 880, 1175, 880, 1175] : [440, 440, 330];
  const volume = name === "sos" ? 0.3 : 0.08;
  try {
    tones.forEach(function (item, i) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      gain.gain.value = volume;
      osc.frequency.value = item;
      osc.connect(gain);
      gain.connect(c.destination);
      const at = c.currentTime + i * 0.18;
      osc.start(at);
      osc.stop(at + 0.12);
    });
  } catch {
    // the spoken sentence is still the signal
  }
}
