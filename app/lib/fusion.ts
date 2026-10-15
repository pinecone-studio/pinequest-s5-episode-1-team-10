// The phone's copy of server/fusion.py. Pure: no network. A wrong "yes" stays impossible:
// the read must be the wanted route, that route must stop here, and no other route here may share
// its number. Anything else is "no" only when it is a different route that does stop here.
import type { Verdict } from "../../shared/contract";

const CONF_MIN = 0.8;
const LOOKALIKE_FROM = "aAMHeocxpKTB";
const LOOKALIKE_TO = "аАМНеосхрКТВ";
const TOKEN = /^\d{1,3}\p{L}{0,2}$/u;
const PREFIX = /\S*:/g;
const GLUED = /^(\d{1,3})(?:\p{L}{3,}|\p{L}+\d)/u;
const SUFFIXED = /^(\d{1,3})\p{L}{1,2}$/u;

export interface SignDecision {
  verdict: Verdict;
  confidence: number;
  number: string | null; // the route number that decided it; null when the read proves nothing
}

function translateLookalikes(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const at = LOOKALIKE_FROM.indexOf(text.charAt(i));
    out += at >= 0 ? LOOKALIKE_TO.charAt(at) : text.charAt(i);
  }
  return out;
}

function normalize(text: string): string {
  return translateLookalikes(text.replace(/ /g, "").replace(/-/g, "")).toLowerCase();
}

export function routeNumber(routeNo: string): string {
  const parts = routeNo.split(":");
  return normalize(parts[parts.length - 1]);
}

function tokens(texts: [string, number][]): Map<string, number> {
  const found = new Map<string, number>();
  texts.forEach(function (item) {
    if (item[1] < CONF_MIN) {
      return;
    }
    item[0].replace(PREFIX, " ").split(/\s+/).forEach(function (word) {
      const tok = normalize(word);
      if (!tok) {
        return;
      }
      const glued = GLUED.exec(tok);
      const pieces = glued ? [tok, glued[1]] : [tok];
      pieces.forEach(function (piece) {
        if (piece && TOKEN.test(piece)) {
          found.set(piece, Math.max(item[1], found.get(piece) ?? 0));
        }
      });
    });
  });
  return found;
}

function candidates(texts: [string, number][], routesHere: string[] | null, cityNumbers: Set<string> | null): Map<string, number> {
  const found = tokens(texts);
  if (!routesHere) {
    return found;
  }
  const here = new Set(routesHere.map(routeNumber));
  const cheHere = new Set(
    routesHere
      .filter(function (item) {
        return item.trim().startsWith("Ч");
      })
      .map(routeNumber),
  );
  function routeOf(tok: string): string | null {
    if (here.has(tok)) {
      return tok;
    }
    if (cityNumbers && tok.startsWith("4") && cheHere.has(tok.slice(1)) && !cityNumbers.has(tok)) {
      return tok.slice(1);
    }
    return null;
  }
  const out = new Map<string, number>();
  found.forEach(function (conf, tok) {
    let num = routeOf(tok);
    const bare = SUFFIXED.exec(tok);
    let cityHas = false;
    if (cityNumbers) {
      cityNumbers.forEach(function (item) {
        if (item.startsWith(tok)) {
          cityHas = true;
        }
      });
    }
    if (num === null && bare && cityNumbers && !cityHas) {
      num = routeOf(bare[1]);
    }
    if (num !== null) {
      out.set(num, Math.max(conf, out.get(num) ?? 0));
    }
  });
  return out;
}

function best(found: Map<string, number>): { number: string; confidence: number } | null {
  let number: string | null = null;
  let confidence = 0;
  found.forEach(function (conf, num) {
    if (!number || conf > confidence) {
      number = num;
      confidence = conf;
    }
  });
  return number ? { number, confidence } : null;
}

// yes / no / unsure for one sign read. routesHere null: bus data missing, so never "yes".
export function decideSign(texts: [string, number][], wantedRoute: string, routesHere: string[] | null, cityNumbers: Set<string> | null): SignDecision {
  const found = candidates(texts, routesHere, cityNumbers);
  if (!found.size) {
    return { verdict: "unsure", confidence: 0, number: null };
  }
  const wanted = routeNumber(wantedRoute);
  if (!found.has(wanted)) {
    if (found.has("4" + wanted)) {
      return { verdict: "unsure", confidence: 0, number: null };
    }
    const top = best(found);
    return { verdict: "no", confidence: top ? top.confidence : 0, number: top ? top.number : null };
  }
  if (!routesHere || routesHere.indexOf(wantedRoute) < 0) {
    return { verdict: "unsure", confidence: 0, number: null };
  }
  for (let i = 0; i < routesHere.length; i++) {
    const other = routesHere[i];
    const n = routeNumber(other);
    const rest = n.slice(wanted.length);
    if (other !== wantedRoute && n.startsWith(wanted) && (!rest || /^\p{L}+$/u.test(rest))) {
      return { verdict: "unsure", confidence: 0, number: null };
    }
  }
  return { verdict: "yes", confidence: found.get(wanted) ?? 0, number: wanted };
}
