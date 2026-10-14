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
