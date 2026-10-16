// Says the scanner's verdict the moment it is decided: a short buzz, whatever is playing cut off, then
// the sentence from a clip already in memory. The same key (a route, or "unsure") waits 8 s before it is
// said again. It cuts off ALL speech, so it is used only before the bus is confirmed: the "bus moving,
// step back" warning, which must never be cut off, only plays after that (BusCamera's door guidance).
import { preloadClips, stopSpeaking, type Earcon } from "./speech";

const COOLDOWN_MS = 8000;
const BUZZ = [100, 50, 100];
const MATCH_BUZZ = [200, 100, 200];

export interface Announcer {
  preload(texts: string[]): Promise<void>; // when the scanner opens
  announce(key: string, texts: string[], now: number, earcon?: Earcon): boolean; // false: said less than 8 s ago
}

// speak: the screen's own voice (RiderFlow's: status line + clips, or the screen reader).
// `earcon`: played first, from memory (lib/speech.ts playInstant, through `speak`).
export function createAnnouncer(speak: (texts: string[], earcon?: Earcon) => Promise<void>): Announcer {
  const saidAt = new Map<string, number>();
  return {
    preload: preloadClips,
    announce: function (key: string, texts: string[], now: number, earcon?: Earcon): boolean {
      const last = saidAt.get(key);
      if (last !== undefined && now - last < COOLDOWN_MS) {
        return false;
      }
      saidAt.set(key, now);
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        navigator.vibrate(earcon === "match" ? MATCH_BUZZ : BUZZ);
      }
      stopSpeaking();
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      speak(texts, earcon);
      return true;
    },
  };
}
