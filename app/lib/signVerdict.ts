// The scanner's decision for one read (moved unchanged from BusScanner so scripts/match-report.mjs
// checks the decision that ships). Pure: no network.
// Fast path: the read clearly picks the rider's route among the routes near this stop
// (lib/signMatch.ts); else the sign parser's own rules (lib/parse-sign.ts).
import { routeKey } from "./candidates";
import { matchSign, type RouteBook } from "./parse-sign";
import { matchSign as matchCandidates, type Candidate } from "./signMatch";

export interface CandidatePool {
  near: Candidate[] | null;
  all: Candidate[];
}

export interface ScanVerdict {
  verdict: "yes" | "no" | "unsure";
  route: string | null;
}

// pool: candidatesNear(stopId), asked only when the route has a key (null: no route data yet).
// With route data, the sign parser alone never says yes: signMatch must agree (it ignores a bare
// number, e.g. a stray "72" next to an advert: a wrong yes on the night photos, 2026-10-16). Stricter
// only: a parser "yes" becomes "unsure"; MARGIN, prefix and insert/delete rules are untouched.
export function verdictOf(lines: string[], route: string, pool: CandidatePool | null, book: RouteBook): ScanVerdict {
  const wantedKey = routeKey(route);
  const quick = wantedKey && pool ? matchCandidates(lines.join(" "), wantedKey as string, pool.near, pool.all) : null;
  const parsed = matchSign(lines, route, book);
  if (quick && quick.verdict === "yes") {
    return { verdict: "yes", route: parsed.route ?? (wantedKey as string) };
  }
  return quick && parsed.verdict === "yes" ? { verdict: "unsure", route: parsed.route } : parsed;
}
