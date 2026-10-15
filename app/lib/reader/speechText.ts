// Printed Mongolian text -> what the reading voice can say (lib/reader/voice.ts, Meta MMS-TTS "mon").
//   - numbers, units and Roman-numeral centuries become words ("1989 онд" -> "мянга есөн зуун наян есөн онд")
//   - punctuation becomes short pauses between chunks
//   - the model's alphabet: its training text wrote ш as щ and ө as ѳ (an old Mongolian font quirk;
//     same ids, see huggingface.co/nugjii/mms-tts-mon-fixed), so they are mapped before tokenizing,
//     and it has no digits or punctuation (anything else is dropped, as its own tokenizer does).

// Model vocabulary in id order (facebook/mms-tts-mon vocab.json); 0 "|" is the blank between letters.
const VOCAB = ["|", "а", "э", "н", "г", "р", "д", "и", "х", "ү", "л", "т", "й", "о", "у", "с", "б", "ѳ", "м", "ч", "в", "ж", "ь", "з", "ы", "е", "щ", "ц", "я", "ю", "—", "ё", "п", "к", "ф", "ъ", "j", "l", "e", "b", "p", "i", "m", "f", "n", "x", "g", "r", "q", "v", "s", "c", "d", "w", "k", "u", "o", "y", "z", "a", "t", "h", "-", " "];
const IDS: Record<string, number> = {};
VOCAB.forEach(function (item, i) {
  IDS[item] = i;
});

const UNITS = ["", "нэг", "хоёр", "гурав", "дөрөв", "тав", "зургаа", "долоо", "найм", "ес"];
const UNITS_BOUND = ["", "нэг", "хоёр", "гурван", "дөрвөн", "таван", "зургаан", "долоон", "найман", "есөн"];
const TENS = ["", "арав", "хорь", "гуч", "дөч", "тавь", "жар", "дал", "ная", "ер"];
const TENS_BOUND = ["", "арван", "хорин", "гучин", "дөчин", "тавин", "жаран", "далан", "наян", "ерэн"];
// Ordinal (-дугаар/-дүгээр) of the last word of a number.
const ORDINAL: Record<string, string> = {
  нэг: "нэгдүгээр", хоёр: "хоёрдугаар", гурав: "гуравдугаар", дөрөв: "дөрөвдүгээр", тав: "тавдугаар",
  зургаа: "зургадугаар", долоо: "долдугаар", найм: "наймдугаар", ес: "есдүгээр", арав: "аравдугаар",
  хорь: "хорьдугаар", гуч: "гучдугаар", дөч: "дөчдүгээр", тавь: "тавьдугаар", жар: "жардугаар",
  дал: "далдугаар", ная: "наядугаар", ер: "ердүгээр", зуу: "зуудугаар", мянга: "мянгадугаар",
  сая: "саядугаар", тэрбум: "тэрбумдугаар", тэг: "тэгдүгээр",
};

// 0..999; `bound`: the attributive form, used before another word ("таван хүн", "гурван зуу").
function hundreds(n: number, bound: boolean): string[] {
  const out: string[] = [];
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const u = n % 10;
  if (h) {
    if (h > 1) {
      out.push(UNITS_BOUND[h]);
    }
    out.push(t || u || bound ? "зуун" : "зуу");
  }
  if (t) {
    out.push(u || bound ? TENS_BOUND[t] : TENS[t]);
  }
  if (u) {
    out.push(bound ? UNITS_BOUND[u] : UNITS[u]);
  }
  return out;
}

// Whole number in words. `bound`: followed by a word it describes.
export function numberWords(n: number, bound: boolean): string {
  if (!Number.isFinite(n) || n < 0) {
    return "";
  }
  if (n === 0) {
    return "тэг";
  }
  const scales: [number, string, string][] = [
    [1e9, "тэрбум", "тэрбум"],
    [1e6, "сая", "сая"],
    [1e3, "мянга", "мянган"],
  ];
  let out: string[] = [];
  let rest = Math.floor(n);
  scales.forEach(function (item) {
    const count = Math.floor(rest / item[0]);
    rest %= item[0];
    if (!count) {
      return;
    }
    const last = rest === 0;
    // "мянга" alone for 1000, "нэг сая" for a million
    if (!(count === 1 && item[0] === 1e3)) {
      out = out.concat(hundreds(count, true));
    }
    out.push(last && bound ? item[2] : item[1]); // "мянга хоёр зуу", but "мянган төгрөг"
  });
  out = out.concat(hundreds(rest, bound));
  return out.join(" ");
}

export function ordinalWords(n: number): string {
  const words = numberWords(n, false).split(" ");
  const last = words.pop() as string;
  return words.concat(ORDINAL[last] ?? last + "дугаар").join(" ");
}

function roman(s: string): number {
  const v: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const a = v[s[i]];
    const b = v[s[i + 1]] ?? 0;
    total += a < b ? -a : a;
  }
  return total;
}

// Phone numbers: 8 digits in pairs ("99 11 22 33" -> "ерэн ес, арван нэг, ..."), longer one by one.
function phoneWords(d: string): string {
  if (d.length === 8) {
    return [0, 2, 4, 6]
      .map(function (item) {
        const pair = d.slice(item, item + 2);
        return pair[0] === "0" ? digitsOneByOne(pair) : numberWords(Number(pair), false);
      })
      .join(", ");
  }
  return digitsOneByOne(d);
}

function digitsOneByOne(d: string): string {
  return d
    .split("")
    .map(function (item) {
      return item === "0" ? "тэг" : UNITS[Number(item)];
    })
    .join(" ");
}

// JavaScript's \b only knows Latin letters, so word edges next to Cyrillic are spelled out.
const L = "а-яА-ЯёЁөӨүҮa-zA-Z";
const END = "(?![" + L + "])";
const START = "(?<![" + L + "])";
const UNIT_WORDS: [RegExp, string][] = [
  [new RegExp("(\\d)\\s*км" + END, "g"), "$1 километр"],
  [new RegExp("(\\d)\\s*кг" + END, "g"), "$1 килограмм"],
  [new RegExp("(\\d)\\s*мг" + END, "g"), "$1 миллиграмм"],
  [new RegExp("(\\d)\\s*мл" + END, "g"), "$1 миллилитр"],
  [new RegExp("(\\d)\\s*см" + END, "g"), "$1 сантиметр"],
  [new RegExp("(\\d)\\s*мм" + END, "g"), "$1 миллиметр"],
  [new RegExp("(\\d)\\s*м" + END, "g"), "$1 метр"],
  [new RegExp("(\\d)\\s*гр?" + END, "g"), "$1 грамм"],
  [new RegExp("(\\d)\\s*л" + END, "g"), "$1 литр"],
  [/(\d)\s*%/g, "$1 хувь"],
  [/(\d)\s*₮/g, "$1 төгрөг"],
  [/\$\s*(\d[\d\s.,]*)/g, "$1 доллар"],
  [/(\d)\s*°\s*C?/g, "$1 градус"],
  [/№\s*/g, "дугаар "],
  [new RegExp(START + "г\\.\\s?м\\.", "g"), "гэх мэт"],
  [new RegExp(START + "[жЖ]\\.\\s?нь" + END, "g"), "жишээ нь"],
  [new RegExp(START + "т\\.\\s?[гб]\\.", "g"), "тэргүүтэн"],
];

// Digits, units and Roman centuries in words; everything else as printed. Also what the phone's own
// voice reads when the Mongolian model isn't available.
export function spokenText(text: string): string {
  let t = text;
  UNIT_WORDS.forEach(function (item) {
    t = t.replace(item[0], item[1]);
  });
  // "-5" -> "хасах 5"
  t = t.replace(/(^|[\s(])[-−](?=\d)/g, "$1хасах ");
  // "XIII зуун" -> "арван гуравдугаар зуун"
  t = t.replace(new RegExp(START + "([IVXLC]{1,7})\\s+(зуу)", "g"), function (_m, r: string, w: string) {
    return ordinalWords(roman(r)) + " " + w;
  });
  // "3-р", "21-р" -> ordinal
  t = t.replace(new RegExp("(\\d+)\\s*-\\s*(?:р|дугаар|дүгээр)" + END, "g"), function (_m, d: string) {
    return ordinalWords(Number(d));
  });
  // thousands written with spaces or commas: "1 000 000", "12,500"
  t = t.replace(/(?<!\d)\d{1,3}(?:[ ,]\d{3})+(?!\d)/g, function (m) {
    return m.replace(/[ ,]/g, "");
  });
  // decimals: "2.5" -> "хоёр бүхэл тав"
  t = t.replace(/(\d+)[.,](\d+)/g, function (_m, a: string, b: string) {
    return numberWords(Number(a), false) + " бүхэл " + numberWords(Number(b), false);
  });
  // the rest: long digit runs one by one (phone numbers), else a number; a suffix after a hyphen is
  // spoken attached ("1990-ээд" -> "...ерэнээд"); before a word, the attributive form
  t = t.replace(/(\d+)(?:-([а-яөүё]+))?(\s+(?=[а-яөүёА-ЯӨҮЁ]))?/g, function (_m, d: string, suffix: string | undefined, space: string | undefined) {
    if (d.length >= 8) {
      return phoneWords(d) + (space ?? "");
    }
    const n = Number(d);
    if (suffix) {
      return numberWords(n, true) + suffix + (space ?? "");
    }
    return numberWords(n, Boolean(space)) + (space ?? "");
  });
  return t;
}

export interface SpeechChunk {
  ids: number[]; // model input: letters with the blank between ("|a|b|...|")
  pause: number; // seconds of silence after this chunk
}

const PAUSES: [RegExp, number][] = [
  [/[.!?…]/, 0.35],
  [/[;:]/, 0.25],
  [/[—–]/, 0.2],
  [/[,()"«»“”]/, 0.12],
];

function idsOf(text: string): number[] {
  const t = text.toLowerCase().replace(/ш/g, "щ").replace(/ө/g, "ѳ").replace(/\s+/g, " ").trim();
  const letters: number[] = [];
  for (const ch of t) {
    const id = IDS[ch];
    if (id !== undefined && id !== 0) {
      letters.push(id);
    }
  }
  if (!letters.some(function (item) {
    return item !== 63 && item !== 62 && item !== 30;
  })) {
    return [];
  }
  const out = new Array<number>(letters.length * 2 + 1).fill(0);
  letters.forEach(function (item, i) {
    out[2 * i + 1] = item;
  });
  return out;
}

// One sentence -> model inputs, split at punctuation (shorter inputs: faster first sound, natural
// pauses) and at MAX_CHARS.
const MAX_CHARS = 140;
export function speechChunks(sentence: string): SpeechChunk[] {
  const spoken = spokenText(sentence);
  const out: SpeechChunk[] = [];
  let buf = "";
  function push(pause: number): void {
    const ids = idsOf(buf);
    if (ids.length) {
      out.push({ ids, pause });
    } else if (out.length) {
      out[out.length - 1].pause = Math.max(out[out.length - 1].pause, pause);
    }
    buf = "";
  }
  for (const ch of spoken) {
    const p = PAUSES.find(function (item) {
      return item[0].test(ch);
    });
    if (p) {
      push(p[1]);
    } else if (ch === "-" && /\s$/.test(buf)) {
      push(0.2); // a dash between words
    } else {
      buf += ch;
      if (buf.length > MAX_CHARS && /\s/.test(ch)) {
        push(0.08);
      }
    }
  }
  push(0.35);
  return out;
}
