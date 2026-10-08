// Mongolian speech from the server's OronTTS (/api/tts). Each sentence is its own cached clip.
import phrases from "../../shared/phrases.json";

export type PhraseKey = keyof typeof phrases;

let current: HTMLAudioElement | null = null;
let turn = 0; // bumped on every say(): older queues stop

export function phrase(key: PhraseKey): string {
  return phrases[key];
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

function play(url: string): Promise<void> {
  return new Promise(function (resolve) {
    const audio = new Audio(url);
    current = audio;
    audio.onended = function () {
      resolve();
    };
    audio.onerror = function () {
      resolve();
    };
    audio.onpause = function () {
      resolve();
    };
    audio.play().catch(function () {
      resolve();
    });
  });
}

export function stopSpeaking(): void {
  turn++;
  if (current) {
    current.pause();
    current = null;
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
