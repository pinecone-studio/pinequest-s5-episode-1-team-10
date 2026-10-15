// Route number on a bus sign, from the text lines the cloud reader saw on one crop. Pure: no network.
// A route is its sign key: the number and an optional А/Б, as riders know it (server planner.spoken_key):
// "Ч:55", "Ч:55_copy" and "Ч:55-Ма" are all "55"; "Ч:29Б" is "29Б". Matching is exact: 29 is not 29Б.
// One frame may say "yes" (BusScanner), so a "yes" also needs the bus data: the route stops here and
// no other route here could show the same sign. Anything doubtful is "unsure", never a guess.
import type { Verdict } from "../../shared/contract";

const LATIN = "ABEKMHOPCTXY";
const CYRILLIC = "АВЕКМНОРСТХУ";
const ROUTE_TOKEN = /^\d{1,3}[АБ]?$/u;
// "Ч:29Б", "4.29Б", "U 29Б": the city-bus marker (an LED Ч reads as 4 or U) before the number.
const MARKER = /(^|[^\p{L}\p{N}])[Чч4Uu](?:\s*[:.]\s*|\s+)(?=\d)/gu;
// Other route prefixes ("Т:2", "НҮ:2", "М:1А").
const PREFIX = /(^|[^\p{L}\p{N}])\p{L}{1,3}\s*:\s*(?=\d)/gu;
// "Ч55" with the colon lost: the marker glued to the number.
const GLUED_MARKER = /^[ЧчUu](?=\d)/u;
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const DASHES = /[-\u2010-\u2015]/gu;
// "3-р хороолол", "10-р": an ordinal in the destination, not a route.
const ORDINAL = /^\d+[-\u2010-\u2015]\p{L}/u;
const READ_AS_B = /[6bьЬ]$/u; // how a reader writes the Б at the end of "29Б"
const UNCLEAR = "?"; // a word the reader wasn't sure of (app/api/read-sign)

// The route data one decision is checked against.
export interface RouteBook {
  routes: Set<string>; // every sign key a read may be (the city's, else this stop's)
  corrections: boolean; // the city's whole list is known, so a misread may be corrected against it
  here: string[] | null; // busRouteNo of every route that stops here; null: unknown, never "yes"
  cheHere: Set<string>; // sign keys of the city-bus (Ч) routes here, for "455" read for "Ч55"
}

export interface SignMatch {
  verdict: Verdict;
  route: string | null; // the sign key it is about; null when the read proves nothing
}

// Latin lookalikes to Cyrillic: "A, B, E, K, M, H, O, P, C, T, X, Y" -> "А, В, Е, К, М, Н, О, Р, С, Т, Х, У".
export function toCyrillic(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const at = LATIN.indexOf(text.charAt(i));
    out += at >= 0 ? CYRILLIC.charAt(at) : text.charAt(i);
  }
  return out;
}

function canon(text: string): string {
  return toCyrillic(text.toUpperCase());
}

// "Ч:29Б" -> "29Б", "М:3Ма" -> "3", "Ч:7а" -> "7А", "Ч:55_copy" -> "55"; the server's route numbers
// ("29б", "3ма") too. null: no number.
export function signKey(route: string): string | null {
  const parts = route.split(":");
  const m = /^\D*?(\d+)\s*([АБ])?/u.exec(canon(parts[parts.length - 1].trim()));
  return m ? m[1] + (m[2] ?? "") : null;
}

// "Ч:55_copy" -> "Ч:55": routes showing the same sign are the same bus for the rider.
function signOf(route: string): string {
  const parts = route.split(":");
  const prefix = parts.length > 1 ? canon(parts[0].trim()) : "";
  return prefix + ":" + (signKey(route) ?? "");
}

function isChe(route: string): boolean {
  return route.indexOf(":") >= 0 && canon(route.split(":")[0].trim()) === "Ч";
}

// here: routes that stop here (bus data). city: every route number in the city (stopRoutes.cityNumbers).
export function makeRouteBook(here: string[] | null, city: Iterable<string> | null): RouteBook {
  const routes = new Set<string>();
  const cheHere = new Set<string>();
  if (city) {
    Array.from(city).forEach(function (item) {
      const key = signKey(item);
      if (key) {
        routes.add(key);
      }
    });
  }
  (here ?? []).forEach(function (item) {
    const key = signKey(item);
    if (key) {
      routes.add(key);
      if (isChe(item)) {
        cheHere.add(key);
      }
    }
  });
  return { routes: routes, corrections: city !== null, here: here, cheHere: cheHere };
}

function known(book: RouteBook, keys: string[]): string[] {
  return keys.filter(function (item) {
    return book.routes.has(item);
  });
}

// The sign keys one word could be: [] none, [key], or several when the read can't tell them apart.
function readToken(raw: string, book: RouteBook): string[] {
  const c = canon(raw);
  if (ROUTE_TOKEN.test(c) && book.routes.has(c)) {
    return [c];
  }
  if (!book.corrections) {
    return [];
  }
  // "296" / "29b" for "29Б", only when the read itself is no route.
  if (READ_AS_B.test(raw) && raw.length > 1) {
    const asB = canon(raw.slice(0, -1)) + "Б";
    if (ROUTE_TOKEN.test(asB) && book.routes.has(asB)) {
      return [asB];
    }
  }
  // "455" for "Ч55": the LED Ч looks like a 4. Only for a Ч route here, and only if the whole read is no route.
  if (ROUTE_TOKEN.test(c) && c.length > 1 && c.charAt(0) === "4" && book.cheHere.has(c.slice(1))) {
    return [c.slice(1)];
  }
  // The number glued to letters: "55Н1000Э" (destination), "3МА" (variant tag), "29В" (Б read as B).
  const glued = /^(\d{1,3})(\p{L})/u.exec(c);
  if (!glued || ROUTE_TOKEN.test(c)) {
    return [];
  }
  const letter = glued[2];
  function options(num: string): string[] {
    return letter === "А" || letter === "Б" ? [num + letter, num] : [num, num + "А", num + "Б"];
  }
  const found = known(book, options(glued[1]));
  if (found.length || glued[1].length < 2 || glued[1].charAt(0) !== "4") {
    return found;
  }
  return options(glued[1].slice(1)).filter(function (item) {
    return book.cheHere.has(item);
  });
}

function lineTokens(line: string): string[] {
  return line
    .normalize("NFC")
    .replace(MARKER, "$1 ")
    .replace(PREFIX, "$1 ")
    .split(/\s+/)
    .map(function (item) {
      if (item === UNCLEAR) {
        return item;
      }
      const word = item.replace(EDGE_PUNCTUATION, "");
      return ORDINAL.test(word) ? "" : word.replace(DASHES, "").replace(GLUED_MARKER, "");
    })
    .filter(function (item) {
      return item !== "";
    });
}

// A word the reader wasn't sure of right after a number may be its letter ("Ч:55 ?" may be 55Б):
// that number is then doubtful too.
function lineReadings(line: string, book: RouteBook): string[][] {
  const readings: string[][] = [];
  let previous: string[] | null = null;
  lineTokens(line).forEach(function (item) {
    if (item === UNCLEAR) {
      if (previous && previous.length === 1) {
        previous.push(UNCLEAR);
      }
      previous = null;
      return;
    }
    const reading = readToken(item, book);
    if (reading.length) {
      readings.push(reading);
    }
    previous = reading.length ? reading : null;
  });
  return readings;
}

// The one route number on this line, or null (none, a fleet number, a plate, or more than one).
export function parseRoute(line: string, book: RouteBook): string | null {
  const keys = new Set<string>();
  let doubtful = false;
  lineReadings(line, book).forEach(function (item) {
    if (item.length > 1) {
      doubtful = true;
    }
    item.forEach(function (key) {
      keys.add(key);
    });
  });
  return !doubtful && keys.size === 1 ? Array.from(keys)[0] : null;
}

// yes / no / unsure for the lines read on ONE crop (one sign).
export function matchSign(lines: string[], wantedRoute: string, book: RouteBook): SignMatch {
  const wanted = signKey(wantedRoute);
  if (!wanted) {
    return { verdict: "unsure", route: null };
  }
  const sure = new Set<string>();
  let wantedDoubtful = false;
  lines.forEach(function (line) {
    lineReadings(line, book).forEach(function (item) {
      if (item.length === 1) {
        sure.add(item[0]);
      } else if (item.indexOf(wanted) >= 0) {
        wantedDoubtful = true;
      }
    });
  });
  const here = book.here;
  if (wantedDoubtful || (sure.has(wanted) && sure.size > 1)) {
    return { verdict: "unsure", route: wanted };
  }
  if (sure.has(wanted)) {
    const mine = signOf(wantedRoute);
    if (!here || !here.some(function (item) {
      return signOf(item) === mine;
    })) {
      return { verdict: "unsure", route: wanted };
    }
    // Another sign here with the same number ("Т:55"), or one the read may have cut short ("29Б" for 29).
    const lookalike = here.some(function (item) {
      const key = signKey(item) ?? "";
      const rest = key.slice(wanted.length);
      return signOf(item) !== mine && key.startsWith(wanted) && (rest === "" || rest === "А" || rest === "Б");
    });
    return lookalike ? { verdict: "unsure", route: wanted } : { verdict: "yes", route: wanted };
  }
  // "Not your bus" only for a route that stops here: a number from a bus passing by, a fleet number
  // or an advert proves nothing.
  const other = Array.from(sure).find(function (item) {
    return (here ?? []).some(function (route) {
      return signKey(route) === item;
    });
  });
  return other ? { verdict: "no", route: other } : { verdict: "unsure", route: null };
}
