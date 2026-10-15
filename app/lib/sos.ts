// SOS without the server: the words that mean "help" are matched on the phone (so SOS starts at once and
// works offline), and the two-finger hold (lib/sosHold.ts) calls the family straight away.
import { familyNumber, openLink, telUrl } from "./family";
import { vibrate } from "./speech";

// Folded like the server's assistant (ү/у, ө/о, й/и), so speech-recognition spellings still match.
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ү/g, "у")
    .replace(/ө/g, "о")
    .replace(/й/g, "и")
    .replace(/ё/g, "е")
    .replace(/[^а-яa-z0-9]+/g, " ")
    .trim();
}

function has(t: string, parts: string[]): boolean {
  return parts.some(function (item) {
    return t.includes(fold(item));
  });
}

const HELP_WORDS = ["тусламж хэр", "төөр", "төвөр", "замаа алд", "аюул", "яаралтай", "туслаач", "туслаарай", "тусална уу"];
const FAMILY_WORDS = ["гэр бүл", "ээж", "аав", "ах", "эгч", "дүү", "нөхөр", "эхнэр", "хүүхэд", "гэрийнхэн"];

// "тусламж хэрэгтэй", "төөрчихлөө", "туслаач" ...: the same words as server/assistant.py's emergency check.
export function isHelpSpeech(text: string): boolean {
  return has(fold(text), HELP_WORDS);
}

// "ээждээ залга", "гэр бүлдээ залгаарай".
export function isCallFamilySpeech(text: string): boolean {
  const t = fold(text);
  return has(t, ["залга"]) && has(t, FAMILY_WORDS);
}

// Dial the saved family number now. Must run inside a touch (the lift of the two-finger hold, a tap):
// phones only open the dialer from a gesture. false: no number saved, nothing was opened.
export function callFamily(): boolean {
  const number = familyNumber();
  if (!number) {
    return false;
  }
  vibrate([500]);
  openLink(telUrl(number));
  return true;
}
