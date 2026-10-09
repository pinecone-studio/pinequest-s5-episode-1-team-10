// Mongolian speech from the server's OronTTS (/api/tts). Each sentence is its own cached clip.
import phrases from "../../shared/phrases.json";

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
}

function fetchClip(text: string): Promise<string | null> {
  return fetch("/api/tts?text=" + encodeURIComponent(text))
    .then(function (res) {
      return res.ok ? res.blob() : null;
    })
    .then(function (blob) {
      return blob ? URL.createObjectURL(blob) : null;
    })
    .catch(function () {
      return null;
    });
}

// Ask the server to make clips now so they play at once later (e.g. the rider's stop name).
export function prefetch(texts: string[]): void {
  texts.forEach(function (item) {
    fetch("/api/tts?text=" + encodeURIComponent(item)).catch(function () {});
  });
}

function play(url: string): Promise<void> {
  return new Promise(function (resolve) {
    if (!audio) {
      resolve();
      return;
    }
    finish = resolve;
    audio.onended = function () {
      resolve();
    };
    audio.onerror = function () {
      resolve();
    };
    audio.src = url;
    audio.play().catch(function () {
      resolve();
    });
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
export async function say(texts: string[]): Promise<void> {
  stopSpeaking();
  const mine = turn;
  const clips = texts.map(fetchClip);
  for (const clip of clips) {
    const url = await clip;
    if (mine !== turn) {
      return;
    }
    if (url) {
      await play(url);
      URL.revokeObjectURL(url);
    }
  }
}

export function sayPhrase(key: PhraseKey): Promise<void> {
  return say([phrase(key)]);
}

export function vibrate(pattern: number[]): void {
  if ("vibrate" in navigator) {
    navigator.vibrate(pattern);
  }
}
