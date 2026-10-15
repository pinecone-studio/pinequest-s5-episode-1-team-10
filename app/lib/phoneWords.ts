// A phone number said aloud -> its digits. Speech recognition gives digits ("99112233"), single words
// ("ес ес нэг нэг"), the pairs Mongolians usually say ("ерэн ес, арван нэг, хорин хоёр"), 4-digit
// groups ("есөн мянга есөн зуун арван нэг" = 9911), or a mix, sometimes with a word misheard.
// The result is always read back to the rider and confirmed, so a near-miss guess is never saved
// silently.

const UNITS: Record<string, number> = {
  тэг: 0,
  нэг: 1,
  нэгэн: 1,
  хоёр: 2,
  гурав: 3,
  гурван: 3,
  дөрөв: 4,
  дөрвөн: 4,
  тав: 5,
  таван: 5,
  зургаа: 6,
  зургаан: 6,
  долоо: 7,
  долоон: 7,
  найм: 8,
  найман: 8,
  ес: 9,
  есөн: 9,
};

// Tens said before a unit ("хорин нэг" = 21) wait for it; said alone ("хорь" = 20) they don't.
const TENS_BEFORE_UNIT: Record<string, number> = {
  арван: 10,
  хорин: 20,
  гучин: 30,
  дөчин: 40,
  тавин: 50,
  жаран: 60,
  далан: 70,
  наян: 80,
  ерэн: 90,
};
const TENS_ALONE: Record<string, number> = {
  арав: 10,
  хорь: 20,
  гуч: 30,
  дөч: 40,
  тавь: 50,
  жар: 60,
  дал: 70,
  ная: 80,
  ер: 90,
};
const HUNDRED = ["зуу", "зуун"];
const THOUSAND = ["мянга", "мянган"];

// Said around a number, never part of it.
const FILLER = ["миний", "манай", "утасны", "утас", "дугаар", "дугаарын", "дугаарыг", "бол", "гэж", "байна", "энэ", "нь", "юм", "за", "тийм", "ээ", "аан", "өө"];

// Misheard by speech recognition on our tests ("Ерэн ес" came back "Ер нь эс", "Ес" as "Үс").
const MISHEARD: Record<string, string> = { үс: "ес", эс: "ес", элс: "ес", ноён: "наян", нойон: "наян" };

const KNOWN = Object.keys(UNITS).concat(Object.keys(TENS_BEFORE_UNIT), Object.keys(TENS_ALONE), HUNDRED, THOUSAND);
// Near-misses are matched only to digits and tens, never to "зуу"/"мянга" (which change the whole
// number): "сайн уу" must not become 100s.
const NEAR = Object.keys(UNITS).concat(Object.keys(TENS_BEFORE_UNIT), Object.keys(TENS_ALONE));

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, function (item, j) {
    return j;
  });
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = keep;
    }
  }
  return prev[b.length];
}

// A word that isn't a number word: the closest digit/tens word if it's nearly the same (one letter
// off up to 4 letters, two for longer words), else null (left out).
function closest(word: string): string | null {
  if (word.length < 3) {
    return null; // too short to tell ("уу", "та"): only the misheard list fixes these
  }
  const most = word.length <= 4 ? 1 : 2;
  let best: string | null = null;
  let bestD = most + 1;
  NEAR.forEach(function (item) {
    const d = distance(word, item);
    if (d < bestD) {
      bestD = d;
      best = item;
    }
  });
  return bestD <= most ? best : null;
}

// Number words (and digit runs), cleaned: misheard forms fixed, filler dropped.
function tokens(text: string): string[] {
  const raw = text
    .toLowerCase()
    .replace(/[^\p{L}\d]+/gu, " ")
    .split(" ")
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    if (w === "ер" && raw[i + 1] === "нь") {
      out.push("ерэн"); // "ерэн" heard as "ер нь"
      i++;
    } else if (/^\d+$/.test(w) || KNOWN.indexOf(w) >= 0) {
      out.push(w);
    } else if (MISHEARD[w]) {
      out.push(MISHEARD[w]);
    } else if (FILLER.indexOf(w) < 0) {
      const near = closest(w);
      if (near) {
        out.push(near);
      }
    }
  }
  return out;
}

// Digits in the order said; "" if nothing in the text was a number.
export function phoneDigits(text: string): string {
  const words = tokens(text);
  let out = "";
  let thousands: number | null = null;
  let hundreds: number | null = null;
  let tens: number | null = null;
  let units: number | null = null;

  // A group ends: written with as many digits as it was said with ("тэг дөрөв" -> "04" comes in two
  // single-digit groups; "таван зуун арван нэг" -> "511"; "есөн мянга тав" -> "9005").
  function flush(): void {
    if (thousands === null && hundreds === null && tens === null && units === null) {
      return;
    }
    const value = (thousands ?? 0) * 1000 + (hundreds ?? 0) * 100 + (tens ?? 0) + (units ?? 0);
    const width = thousands !== null ? String(thousands).length + 3 : hundreds !== null ? 3 : tens !== null ? 2 : 1;
    out += String(value).padStart(width, "0");
    thousands = hundreds = tens = units = null;
  }

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    if (/^\d+$/.test(w)) {
      flush();
      out += w;
    } else if (THOUSAND.indexOf(w) >= 0) {
      // "мянга" alone = 1000; after a unit or a pair it multiplies what came before it.
      const before = (tens ?? 0) + (units ?? 0);
      const had = tens !== null || units !== null;
      tens = units = null;
      if (thousands !== null || hundreds !== null) {
        flush();
      }
      thousands = had ? before : 1;
    } else if (HUNDRED.indexOf(w) >= 0) {
      const before = units;
      units = null;
      if (hundreds !== null || tens !== null) {
        flush();
      }
      hundreds = before ?? 1;
    } else if (w in UNITS) {
      const u = UNITS[w];
      if (next !== undefined && (THOUSAND.indexOf(next) >= 0 || HUNDRED.indexOf(next) >= 0)) {
        // A multiplier follows: "есөн мянга", "наян найман мянга" (88 thousand), "есөн зуун".
        // A new group starts if this one is already past that point.
        const nextThousand = THOUSAND.indexOf(next) >= 0;
        if (units !== null || (nextThousand && (thousands !== null || hundreds !== null)) || (!nextThousand && hundreds !== null)) {
          flush();
        }
        units = u;
        continue;
      }
      if (units !== null) {
        flush();
      }
      units = u;
      flush(); // a unit ends its group (with the tens before it: "ерэн ес" -> 99)
    } else if (w in TENS_BEFORE_UNIT || w in TENS_ALONE) {
      if (tens !== null || units !== null) {
        flush();
      }
      tens = w in TENS_BEFORE_UNIT ? TENS_BEFORE_UNIT[w] : TENS_ALONE[w];
      if (w in TENS_ALONE) {
        flush();
      }
    }
  }
  flush();
  return out;
}

// "99112233" -> "9911 2233", for the screen.
export function groupDigits(digits: string): string {
  return digits.replace(/\D/g, "").replace(/(\d{4})(?=\d)/g, "$1 ");
}

// While listening: is the number complete (`need` digits and nothing left hanging, like "гучин" waiting
// for its unit or "мянга" for what follows)? Then listening can stop at once.
export function phoneComplete(text: string, need = 8): boolean {
  const words = tokens(text);
  const last = words[words.length - 1];
  if (last === undefined || last in TENS_BEFORE_UNIT || HUNDRED.indexOf(last) >= 0 || THOUSAND.indexOf(last) >= 0) {
    return false;
  }
  return phoneDigits(text).length >= need;
}
