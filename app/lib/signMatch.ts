// Loose sign matching, relative to the routes at this stop (pure: no network).
// Every candidate route is scored against one OCR read: its number ("<prefix>:<id>", lookalike letters
// cheap, the prefix and ":" may be missing) and its terminals (a destination word alone can do it). The
// target is accepted when it scores best AND beats the next candidate by MARGIN: the absolute score may
// be low (a garbled read still matches on the first frame where no other route here looks alike), but
// where look-alikes stop here (Ч:57 and Ч:57Б) the margin needs a cleaner read.
// Without candidates (no GPS / stop data) it stays strict: prefix + the exact id, lookalikes only.

export interface Candidate {
  key: string; // "Ч:29Б"
  terminals: [string, string] | null;
}

export interface SignMatchResult {
  verdict: "yes" | "no" | "unsure"; // yes: the target; no: another candidate, clearly; unsure: neither
  best: string | null; // best-scoring candidate key
  score: number;
  margin: number; // best minus second best
}

export const MARGIN = 0.2;
export const MIN_SCORE = 0.3; // below: nothing on the sign looks like any candidate
const LOOKALIKE_COST = 0.3;
const MIN_DEST_TOKEN = 4; // shorter words ("ЭЦ") say nothing about a destination
// Measured on 36 real night photos at Сүхбаатарын талбай (2026-10-16), Azure whole-frame reads: these
// three rules removed 4 wrong "yes" (a fleet number "3-077" -> Ч:37, a stray "72" -> Ч:72, advert words
// "ЗУНЫ" ~ "Зунжин" -> М:2) without losing a right one.
const ID_ONLY_CAP = 0.25; // a number without its prefix (Ч/М/Х...) alone never decides: plates, fleet numbers
const STRONG_DEST = 0.85; // a destination word this close decides alone; weaker ones need some number too
const DEST_NEEDS_ROUTE = 0.3; // ...a number at least this similar (prefix or not)

// Pairs that OCR confuses on LED signs (both directions).
const LOOKALIKES: [string, string][] = [
  ["6", "Б"],
  ["4", "Ч"],
  ["3", "З"],
  ["0", "О"],
  ["8", "В"],
  ["1", "I"],
  ["Y", "Ү"],
  ["X", "Х"],
  ["M", "М"],
];
const PAIR = new Set(
  LOOKALIKES.flatMap(function (item) {
    return [item[0] + item[1], item[1] + item[0]];
  }),
);
// Latin letters drawn the same as Cyrillic ones (not in the list above): the same letter.
const SAME: Record<string, string> = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", O: "О", P: "Р", T: "Т" };

function clean(text: string): string {
  return text
    .toUpperCase()
    .split("")
    .map(function (item) {
      return SAME[item] ?? item;
    })
    .join("");
}

function subCost(a: string, b: string): number {
  return a === b ? 0 : PAIR.has(a + b) ? LOOKALIKE_COST : 1;
}

// Weighted Levenshtein: lookalike substitutions cost 0.3, everything else 1.
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, function (item, j) {
    return j;
  });
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + subCost(a[i - 1], b[j - 1]));
      diag = keep;
    }
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const n = Math.max(a.length, b.length);
  return n ? Math.max(0, 1 - distance(a, b) / n) : 0;
}

function tokens(text: string): string[] {
  return clean(text)
    .split(/[\s|,;()«»"]+/u)
    .map(function (item) {
      return item.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}:.]+$/gu, "");
    })
    .filter(function (item) {
      // fleet numbers painted on buses ("3-077", "5-272") and phone numbers ("7004-4040") are never routes
      return item !== "" && /[\p{L}\p{N}]/u.test(item) && !/^\d+[-–]\d+$/.test(item);
    });
}

function parts(key: string): { prefix: string; id: string } {
  const at = key.indexOf(":");
  return { prefix: clean(key.slice(0, at)), id: clean(key.slice(at + 1)) };
}

// Similarity of the best token to the route: with its prefix ("Ч29Б", ":" may be missing) and without
// ("29Б"). The second is kept apart: alone it is capped (ID_ONLY_CAP).
function routeScore(toks: string[], key: string): { prefixed: number; bare: number } {
  const { prefix, id } = parts(key);
  let prefixed = 0;
  let bare = 0;
  toks.forEach(function (item) {
    const t = item.replace(/[:.]/g, "");
    if (!/\p{N}/u.test(t) && !/^[4ЧМХДҮШ]/u.test(t)) {
      return; // a word with no digit is a destination, not a route number
    }
    prefixed = Math.max(prefixed, similarity(t, prefix + id));
    bare = Math.max(bare, similarity(t, id));
  });
  return { prefixed, bare };
}

// Best similarity of an OCR word to a terminal: whole words, or (scrolling LED signs cut words at both
// ends: "АЛДВАР" of "ХАЛДВАРТЫН") the same-length stretch anywhere in a terminal word, scaled by how
// much of the word was seen.
function destinationScore(toks: string[], terminals: [string, string] | null): number {
  if (!terminals) {
    return 0;
  }
  const words = tokens(terminals.join(" ")).filter(function (item) {
    return item.length >= MIN_DEST_TOKEN && !/^\d+$/.test(item);
  });
  let best = 0;
  toks.forEach(function (item) {
    if (item.length < MIN_DEST_TOKEN || /\d/.test(item)) {
      return;
    }
    words.forEach(function (word) {
      if (item.length >= word.length) {
        best = Math.max(best, similarity(item, word));
        return;
      }
      const seen = Math.min(1, item.length / 6);
      for (let at = 0; at + item.length <= word.length; at++) {
        best = Math.max(best, similarity(item, word.slice(at, at + item.length)) * seen);
      }
    });
  });
  return best;
}

export function scoreCandidate(text: string, candidate: Candidate): number {
  const toks = tokens(text);
  const { prefixed, bare } = routeScore(toks, candidate.key);
  const r = Math.max(prefixed, Math.min(bare, ID_ONLY_CAP));
  let d = destinationScore(toks, candidate.terminals);
  if (d < STRONG_DEST && Math.max(prefixed, bare) < DEST_NEEDS_ROUTE) {
    d = 0; // a weak destination look-alike with no number: an advert or shop word
  }
  return Math.max(r, d, 1 - (1 - r) * (1 - d));
}

// Strict, for when nothing is known about the stop: a token that IS "<prefix>:<id>" (same length, only
// lookalike letters swapped). Exactly one route may match.
function strictMatch(text: string, target: string, all: Candidate[]): SignMatchResult {
  const hits = new Set<string>();
  tokens(text).forEach(function (item) {
    const t = item.replace(/[:.]/g, "");
    all.forEach(function (c) {
      const { prefix, id } = parts(c.key);
      const want = prefix + id;
      if (t.length === want.length && distance(t, want) <= LOOKALIKE_COST * want.length + 1e-9 && distance(t, want) === sumLookalike(t, want)) {
        hits.add(c.key);
      }
    });
  });
  if (hits.size === 1) {
    const only = Array.from(hits)[0];
    return { verdict: only === target ? "yes" : "no", best: only, score: 1, margin: 1 };
  }
  return { verdict: "unsure", best: null, score: 0, margin: 0 };
}

// Position-by-position cost when only same-place substitutions are allowed (no added / dropped letters).
function sumLookalike(a: string, b: string): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const c = subCost(a[i], b[i]);
    if (c >= 1) {
      return Infinity;
    }
    sum += c;
  }
  return sum;
}

// `candidates`: routes at stops near the rider; empty/null -> strict against `all`.
export function matchSign(text: string, target: string, candidates: Candidate[] | null, all: Candidate[], margin: number = MARGIN): SignMatchResult {
  if (!candidates || !candidates.length) {
    return strictMatch(text, target, all);
  }
  const scored = candidates
    .map(function (item) {
      return { key: item.key, score: scoreCandidate(text, item) };
    })
    .sort(function (a, b) {
      return b.score - a.score;
    });
  const top = scored[0];
  const second = scored.length > 1 ? scored[1].score : 0;
  const gap = top.score - second;
  if (top.score < MIN_SCORE || gap < margin) {
    return { verdict: "unsure", best: top.score >= MIN_SCORE ? top.key : null, score: top.score, margin: gap };
  }
  return { verdict: top.key === target ? "yes" : "no", best: top.key, score: top.score, margin: gap };
}
