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
export function verdictOf(lines: string[], route: string, pool: CandidatePool | null, book: RouteBook): ScanVerdict {
  const wantedKey = routeKey(route);
  const quick = wantedKey && pool ? matchCandidates(lines.join(" "), wantedKey as string, pool.near, pool.all) : null;
  const parsed = matchSign(lines, route, book);
  return quick && quick.verdict === "yes" ? { verdict: "yes", route: parsed.route ?? (wantedKey as string) } : parsed;
}
