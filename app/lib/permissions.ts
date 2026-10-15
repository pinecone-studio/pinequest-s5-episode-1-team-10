// The phone's permission boxes (microphone, camera, location) are visual: a blind rider can't see
// them. Before one opens, the app says what's coming and what to press. Only when the phone will
// actually ask (Permissions API "prompt"); where that can't be checked, only the first time ever.
import { phrase, say, type PhraseKey } from "./speech";

type Kind = "microphone" | "camera" | "geolocation";
const KEY: Record<Kind, PhraseKey> = { microphone: "mic_permission", camera: "camera_permission", geolocation: "location_permission" };
const said = new Set<Kind>();

async function willAsk(kind: Kind): Promise<boolean> {
  try {
    const state = await navigator.permissions.query({ name: kind as PermissionName });
    return state.state === "prompt";
  } catch {
    // Can't tell (older Safari): say it once per phone.
    try {
      const k = "avtobus.asked." + kind;
      if (window.localStorage.getItem(k)) {
        return false;
      }
      window.localStorage.setItem(k, "1");
    } catch {
      // storage blocked: say it
    }
    return true;
  }
}

// Resolves once the hint has been said (or right away if there's nothing to say).
export async function explainPermission(kind: Kind, show?: (text: string) => void): Promise<void> {
  if (said.has(kind)) {
    return;
  }
  said.add(kind);
  if (await willAsk(kind)) {
    if (show) {
      show(phrase(KEY[kind]));
    }
    await say([phrase(KEY[kind])]);
  }
}
