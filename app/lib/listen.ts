// The browser's own speech recognition ("mn-MN"), used when the server has no Whisper
// (free hosting: /api/health says "stt": false). Chrome / Android; not iPhone Safari.
import { speedMark } from "./speed";

interface RecognitionResultEvent {
  results: { [index: number]: { [index: number]: { transcript: string } } };
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
    rec.lang = "mn-MN";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onaudiostart = function () {
      speedMark("listening");
    };
    rec.onspeechend = function () {
      speedMark("speech end");
    };
    // interimResults is off, so a result is the final one: answer now instead of waiting for onend
    // (the recognizer still closes the microphone after it).
    rec.onresult = function (e) {
      heard = e.results[0][0].transcript.trim();
      if (heard) {
        speedMark("text");
        resolve({ text: heard, error: "", code: "" });
      }
    };
    rec.onerror = function (e) {
      code = e.error;
    };
    rec.onend = function () {
      if (heard) {
        resolve({ text: heard, error: "", code: "" });
      } else {
        resolve({ text: "", error: kind(code || "no-speech"), code: code || "no-speech" });
      }
    };
    try {
      rec.start();
    } catch (e) {
      resolve({ text: "", error: "unsupported", code: e instanceof Error ? e.name : "start-failed" });
    }
  });
  return {
    done,
    stop: function () {
      rec.stop();
    },
  };
}
