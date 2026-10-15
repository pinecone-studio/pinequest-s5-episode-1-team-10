// A phone number said aloud -> its digits. Speech recognition gives digits ("99112233"), words
// ("ес ес нэг нэг"), or the pairs Mongolians usually say ("ерэн ес, арван нэг, хорин хоёр"), or a mix.

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

const TENS: Record<string, number> = {
  арав: 10,
  арван: 10,
  хорь: 20,
  хорин: 20,
  гуч: 30,
  гучин: 30,
  дөч: 40,
  дөчин: 40,
  тавь: 50,
  тавин: 50,
  жар: 60,
  жаран: 60,
  дал: 70,
  далан: 70,
  ная: 80,
  наян: 80,
  ер: 90,
  ерэн: 90,
};

const HUNDRED = ["зуу", "зуун"];

// Digits in the order said; "" if nothing in the text was a number.
export function phoneDigits(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\d]+/gu, " ")
    .split(" ")
    .filter(Boolean);
  let out = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\d+$/.test(w)) {
      out += w;
    } else if (w in TENS) {
      const next = words[i + 1];
      if (next !== undefined && next in UNITS && UNITS[next] > 0) {
        out += String(TENS[w] + UNITS[next]);
        i++;
      } else {
        out += String(TENS[w]);
      }
    } else if (w in UNITS) {
      const next = words[i + 1];
      if (next !== undefined && HUNDRED.indexOf(next) >= 0) {
        out += String(UNITS[w]) + "00"; // "таван зуу" = 500
        i++;
      } else {
        out += String(UNITS[w]);
      }
    } else if (HUNDRED.indexOf(w) >= 0) {
      out += "100";
    }
  }
  return out;
}

// "99112233" -> "9911 2233", for the screen.
export function groupDigits(digits: string): string {
  return digits.replace(/\D/g, "").replace(/(\d{4})(?=\d)/g, "$1 ");
}
