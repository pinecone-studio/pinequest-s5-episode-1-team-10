// Mongolian speech from the server's OronTTS (/api/tts). Each sentence is its own cached clip.
import phrases from "../../shared/phrases.json";
import { speedAudio } from "./speed";

export type PhraseKey = keyof typeof phrases;

// One audio element for every clip: iOS only lets a page play sound from an element that was
// started inside a touch, so it's unlocked on the first touch and reused after that.
const audio = typeof Audio === "undefined" ? null : new Audio();
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
let unlocked = false;
let turn = 0; // bumped on every say(): older queues stop
let finish: (() => void) | null = null; // resolves the clip that's playing

export function phrase(key: PhraseKey): string {
  return phrases[key];
}

// Call from inside a touch/click handler, before the first say().
export function unlockAudio(): void {
  if (unlocked || !audio) {
    return;
  }
  unlocked = true;
  audio.src = SILENCE;
  audio.play().catch(function () {
    unlocked = false;
  });
  // iPhone also keeps the phone's own voice (the fallback for sentences without a clip) silent until
  // it has spoken once inside a touch.
  const synth = typeof window === "undefined" ? null : window.speechSynthesis;
  if (synth) {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    synth.speak(u);
  }
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
    player.play().catch(done);
  });
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
