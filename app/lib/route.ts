import config from "../../shared/route_speech.json";
import { numberWords } from "./reader/speechText";

// Route numbers as riders see them on the bus: Hamuga's copy tags and stray spaces removed
// (" НҮ:2_copy" -> "НҮ:2"). Display only: /verify and /ride still get the full busRouteNo.
export function routeLabel(route: string): string {
  return route.replace(/_copy|-коп/gi, "").trim();
}

// How each route letter is said (shared/route_speech.json, also read by server/numwords.py route_words).
const PREFIX: Record<string, string> = config.prefix;
const SUFFIX: Record<string, string> = config.suffix;
// Hamuga's variant tags, not on the sign: "Ч:29Б-Ма", "М:1БНА", "Ч:16а-Z", "М:5-КОП_copy", "Ч:71МА".
const TAGS = "(?:-?(?:ма|на|z|коп)|_copy)*";
const NUMBER = new RegExp("^[^0-9]*?([0-9]+)\\s*(?:(өв|[аб])(?=" + TAGS + "$))?", "i");

// A route in Mongolian words, for anything the voice or VoiceOver reads: "Ч:29Б" -> "Ч хорин ес Б",
// "Ч:57" -> "Ч тавин долоо", "29Б" -> "хорин ес Б". Never digits or ":". An unknown prefix ("COP:1",
// "НҮ:2") is left out and a suffix is said only when nothing but variant tags follows it, so the
// result is shorter, never guessed. Numbers outside 1..99 aren't route numbers: "" for them.
// Must give exactly what route_words gives (test-fixtures/speech/routes.expected.json checks both).
export function routeSpeech(route: string): string {
  const t = route.trim();
  const colon = t.indexOf(":");
  const prefix = colon >= 0 ? (PREFIX[t.slice(0, colon).trim().toUpperCase()] ?? "") : "";
  const m = NUMBER.exec(colon >= 0 ? t.slice(colon + 1).trim() : t);
  const n = m ? Number(m[1]) : 0;
  if (!m || n < 1 || n > 99) {
    return "";
  }
  const suffix = m[2] ? (SUFFIX[m[2].toUpperCase()] ?? "") : "";
  return [prefix, numberWords(n, false), suffix]
    .filter(function (item) {
      return item !== "";
    })
    .join(" ");
}
