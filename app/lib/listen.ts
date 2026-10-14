// The browser's own speech recognition ("mn-MN"), used when the server has no Whisper
// (free hosting: /api/health says "stt": false). Chrome / Android; not iPhone Safari.

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
  start(): void;
  stop(): void;
}

type RecognitionClass = new () => Recognition;

function recognitionClass(): RecognitionClass | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function canListenInBrowser(): boolean {
  return typeof window !== "undefined" && recognitionClass() !== null;
}

// What the rider said, "" if nothing was heard or recognition isn't available.
export function listenInBrowser(): { done: Promise<string>; stop: () => void } {
  const Rec = recognitionClass();
  if (!Rec) {
    return {
      done: Promise.resolve(""),
      stop: function () {},
    };
  }
  const rec = new Rec();
  const done = new Promise<string>(function (resolve) {
    let heard = "";
    rec.lang = "mn-MN";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = function (e) {
      heard = e.results[0][0].transcript.trim();
    };
    rec.onerror = function () {
      resolve("");
    };
    rec.onend = function () {
      resolve(heard);
    };
    rec.start();
  });
  return {
    done,
    stop: function () {
      rec.stop();
    },
  };
}
