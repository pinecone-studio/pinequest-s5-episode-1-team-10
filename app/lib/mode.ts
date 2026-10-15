// How the rider uses the app, picked on the first screen:
//   "sr"    = with a screen reader (TalkBack / VoiceOver): plain buttons the screen reader reads; the
//             app's Mongolian voice speaks only content (the plan, "this is your bus", the door...).
//   "voice" = no screen reader: the app speaks everything; swipe / double tap / press-and-hold.
// The last choice is remembered on this phone; ?mode=sr|voice forces one (testing).
export type Mode = "sr" | "voice";

const KEY = "avtobus.mode";

export function savedMode(): Mode | null {
  const q = new URLSearchParams(window.location.search).get("mode");
  if (q === "sr" || q === "voice") {
    return q;
  }
  try {
    const m = window.localStorage.getItem(KEY);
    return m === "sr" || m === "voice" ? m : null;
  } catch {
    return null;
  }
}

export function saveMode(mode: Mode): void {
  try {
    window.localStorage.setItem(KEY, mode);
  } catch {
    // storage blocked: asked again next time
  }
}

// Who reads the status in screen-reader mode. "app" is the Mongolian clips. "screen" is VoiceOver
// or TalkBack, and the app stays quiet so the two voices never talk at once.
export type Reader = "app" | "screen";

const READER_KEY = "avtobus.reader";

export function savedReader(): Reader {
  const q = new URLSearchParams(window.location.search).get("reader");
  if (q === "app" || q === "screen") {
    return q;
  }
  try {
    return window.localStorage.getItem(READER_KEY) === "screen" ? "screen" : "app";
  } catch {
    return "app";
  }
}

export function saveReader(reader: Reader): void {
  try {
    window.localStorage.setItem(READER_KEY, reader);
  } catch {
    // storage blocked: the app voice stays the default
  }
}
