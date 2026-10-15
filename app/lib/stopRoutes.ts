// Routes that stop at the boarding stop, cached when the plan arrives, so each sign read can be
// decided on the phone. The target route is included: the plan already chose it for this stop.
import { fetchStopRoutes } from "./api";

const routes = new Map<string, string[]>();
const ready = new Set<string>();
let city: Set<string> | null = null;

export function routesFor(stopId: string): string[] | null {
  return ready.has(stopId) ? (routes.get(stopId) ?? []) : null;
}

export function cityNumbers(): Set<string> | null {
  return city;
}

function remember(stopId: string, known: string[]): void {
  if (known.length) {
    routes.set(stopId, known.slice());
  }
}

// Plan step: keep the plan's own list at once (the target route included), then refresh it and the
// city's route numbers from the server. The server's list is kept as sent: a route it does not name
// cannot be confirmed. A failed refresh leaves the plan's list.
export function prefetchStopRoutes(stopId: string, known: string[], target: string): void {
  const listed = known.slice();
  if (target && listed.indexOf(target) < 0) {
    listed.push(target);
  }
  // A plan list is the stop's routes. A lone target, appended because the list was empty, is not
  // enough: a sibling route may also stop here, and confirming before the server answers could be wrong.
  if (known.length) {
    remember(stopId, listed);
    ready.add(stopId);
  }
  fetchStopRoutes(stopId).then(function (fresh) {
    if (!fresh) {
      return;
    }
    remember(stopId, fresh.routes);
    ready.add(stopId);
    if (fresh.city_numbers.length) {
      city = new Set(fresh.city_numbers);
    }
  });
}
