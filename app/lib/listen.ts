// The browser's own speech recognition ("mn-MN"), used when the server has no Whisper
// (free hosting: /api/health says "stt": false). Chrome / Android; not iPhone Safari.
import { speedMark } from "./speed";

interface RecognitionResultEvent {
  results: { length: number; [index: number]: { isFinal: boolean; [index: number]: { transcript: string } } };
}

interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onaudiostart: (() => void) | null;
  onspeechend: (() => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionClass = new () => Recognition;

// Chrome on Android often keeps listening long after a Mongolian sentence ends, so the rider would
// have to double tap to stop it. Instead the app watches the words as they come: this long without a
// new word after the rider has spoken = they are done, and Chrome is asked for its final text.
const SILENCE_MS = 1200;
const NO_SPEECH_MS = 7000; // nothing said at all -> "not heard"
const MAX_MS = 12000;

// Why nothing came back, so the rider hears what to do instead of "not heard" again and again:
//   no-mic       microphone blocked or missing
//   unsupported  this browser can't recognise Mongolian (iPhone Safari, Firefox, Samsung Internet...)
//   network      the browser's recognition service (online) didn't answer
//   not-heard    nothing said
export type ListenError = "" | "no-mic" | "unsupported" | "network" | "not-heard";

export interface Heard {
  text: string;
  error: ListenError;
  code: string; // the browser's own error name, shown on screen for whoever is helping
}

function recognitionClass(): RecognitionClass | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function canListenInBrowser(): boolean {
  return typeof window !== "undefined" && recognitionClass() !== null;
}

function kind(code: string): ListenError {
  if (code === "not-allowed" || code === "audio-capture") {
    return "no-mic";
  }
  // iPhone says service-not-allowed when its recognizer doesn't do the language (or Siri is off).
  if (code === "language-not-supported" || code === "service-not-allowed" || code === "no-recognition") {
    return "unsupported";
  }
  if (code === "network") {
    return "network";
  }
  return "not-heard"; // no-speech, aborted
}

// What the rider said, or why nothing was heard.
export function listenInBrowser(): { done: Promise<Heard>; stop: () => void } {
  const Rec = recognitionClass();
  if (!Rec) {
    return {
      done: Promise.resolve({ text: "", error: "unsupported", code: "no-recognition" }),
      stop: function () {},
    };
  }
  const rec = new Rec();
  const done = new Promise<Heard>(function (resolve) {
    let heard = "";
    let code = "";
    let silence: ReturnType<typeof setTimeout> | undefined;
    const noSpeech = setTimeout(stopNow, NO_SPEECH_MS);
    const max = setTimeout(stopNow, MAX_MS);
    function stopNow(): void {
      try {
        rec.stop();
      } catch {
        // already stopped
      }
    }
    function finish(result: Heard): void {
      clearTimeout(silence);
      clearTimeout(noSpeech);
      clearTimeout(max);
      resolve(result);
    }
    rec.lang = "mn-MN";
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onaudiostart = function () {
      speedMark("listening");
    };
    rec.onspeechend = function () {
      speedMark("speech end");
    };
    // A final result is answered at once, without waiting for onend (the recognizer still closes the
    // microphone after it). Words still coming in only restart the silence wait.
    rec.onresult = function (e) {
      let text = "";
      let final = true;
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        final = final && e.results[i].isFinal;
      }
      heard = text.trim();
      if (!heard) {
        return;
      }
      clearTimeout(noSpeech);
      clearTimeout(silence);
      if (final) {
        speedMark("text");
        finish({ text: heard, error: "", code: "" });
        return;
      }
      silence = setTimeout(stopNow, SILENCE_MS);
    };
    rec.onerror = function (e) {
      code = e.error;
    };
    // Ended without a final result: the last words heard still count.
    rec.onend = function () {
      if (heard) {
        finish({ text: heard, error: "", code: "" });
      } else {
        finish({ text: "", error: kind(code || "no-speech"), code: code || "no-speech" });
      }
    };
    try {
      rec.start();
    } catch (e) {
      finish({ text: "", error: "unsupported", code: e instanceof Error ? e.name : "start-failed" });
    }
  });
  return {
    done,
    stop: function () {
      rec.stop();
    },
  };
}
