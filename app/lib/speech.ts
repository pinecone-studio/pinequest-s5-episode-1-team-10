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
  if (session) {
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

function fetchClip(text: string): Promise<string | null> {
  const url = clipUrl(text);
  const blob = url === apiUrl(text) ? getAudio(url) : getAudio(url).then(function (direct) {
    return direct ?? getAudio(apiUrl(text)); // a stale name never makes a sentence silent
  });
  return blob.then(function (found) {
    return found ? URL.createObjectURL(found) : null;
  });
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
    } else if (texts[i].trim()) {
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

export function sayPhrase(key: PhraseKey): Promise<void> {
  return say([phrase(key)]);
}

export function vibrate(pattern: number[]): void {
  if ("vibrate" in navigator) {
    navigator.vibrate(pattern);
  }
}
