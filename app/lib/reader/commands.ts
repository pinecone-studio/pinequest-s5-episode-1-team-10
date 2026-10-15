// What the reader understands when the rider presses and holds and speaks. Parsed on the phone (no
// server), so it works anywhere the browser recognises speech.
export type ReaderCommand =
  | "pause"
  | "resume"
  | "repeat"
  | "previous"
  | "next"
  | "newPage"
  | "fromStart"
  | "faster"
  | "slower"
  | "where"
  | "help"
  | "back";

// Folded like the assistant's matching: case, ө/ү/й/ы/э variants, punctuation.
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ө/g, "о")
    .replace(/ү/g, "у")
    .replace(/[йы]/g, "и")
    .replace(/э/g, "е")
    .replace(/[^a-zа-яё0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Most specific first ("дараагийн хуудас" before "дараагийн").
// Patterns are folded too (э -> е, ө -> о, ү -> у, й/ы -> и); a leading space = start of a word.
const RULES: [ReaderCommand, string[]][] = [
  ["newPage", ["дараагиин хууд", "шине хууд", "ергуул", "дахиж зураг", "зураг ав", "шине зураг", "хуудас солих"]],
  ["fromStart", ["ехнеес", "ехлелеес"]],
  ["back", [" буц", "автобус", " гарах", " гар ", " хаа "]],
  ["faster", ["хурдан", "хурдас"]],
  ["slower", ["удаан", "удааш"]],
  ["where", ["хаана", " хедед", " хед дех", " хед дугаар"]],
  ["help", ["тусламж", " яаж", "заавар", "юу хиих"]],
  ["previous", ["омнох", " ухраа", " ухар"]],
  ["next", ["дараагиин", "алгас", " дараах"]],
  ["repeat", ["дахин", " давт", "дахиад"]],
  ["pause", [" зогс", "хулее", " больж", " болио", "чимее"]],
  ["resume", ["ургелжл", " цааш", " унш", " яв"]],
];

export function readerCommand(heard: string): ReaderCommand | null {
  const t = " " + fold(heard) + " ";
  for (const rule of RULES) {
    if (
      rule[1].some(function (item) {
        return t.indexOf(item) >= 0;
      })
    ) {
      return rule[0];
    }
  }
  return null;
}

// "Read this" said to the bus app's assistant: open the reader instead. Needs a thing to read ("ном",
// "сонин", "бичиг"...) or "энийг унш": "дахин унш" alone still asks the bus assistant to repeat.
export function wantsReader(heard: string): boolean {
  const t = " " + fold(heard) + " ";
  const things = ["бичиг", " ном", "сонин", "захиа", "шошго", "уншигч", "хаирцаг", " цаас"];
  if (
    things.some(function (item) {
      return t.indexOf(item) >= 0;
    })
  ) {
    return true;
  }
  return t.indexOf(" унш") >= 0 && (t.indexOf(" ене ") >= 0 || t.indexOf(" енииг") >= 0);
}
