// Which routes the camera should tell apart: the routes serving stops within 150 m of the rider (the
// boarding stop's position, or GPS when given), from public/data/route-data.json (made by
// scripts/build-routes.ts from data/route.ts + Hamuga). Loaded once, early, so the first frame can match.
import type { Candidate } from "./signMatch";

const NEAR_M = 150;

interface RouteData {
  all: Candidate[];
  stops: { id: string; lat: number; lng: number; keys: string[] }[];
  byKey: Map<string, Candidate>;
}

let loaded: RouteData | null = null;
let loading: Promise<RouteData | null> | null = null;

export function loadRouteData(): Promise<RouteData | null> {
  if (!loading) {
    loading = fetch("/data/route-data.json")
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (raw: { routes: [string, [string, string] | null][]; stops: [string, number, number, string[]][] } | null) {
        if (!raw) {
          return null;
        }
        const all = raw.routes.map(function (item) {
          return { key: item[0], terminals: item[1] };
        });
        loaded = {
          all,
          stops: raw.stops.map(function (item) {
            return { id: item[0], lat: item[1], lng: item[2], keys: item[3] };
          }),
          byKey: new Map(
            all.map(function (item) {
              return [item.key, item] as const;
            }),
          ),
        };
        return loaded;
      })
      .catch(function () {
        loading = null; // asked again next time
        return null;
      });
  }
  return loading;
}

// Hamuga's route number -> the list's key: "Ч:55Ма", "Ч:55_copy", "ч:16а-Z", "Ч-38" -> "Ч:55", "Ч:16А", "Ч:38".
const LATIN: Record<string, string> = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У" };
export function routeKey(routeNo: string): string | null {
  const m = /^\s*([^:\s-]+)\s*[:-]\s*(\S.*)$/u.exec(routeNo);
  if (!m) {
    return null;
  }
  const up = function (s: string): string {
    return s
      .toUpperCase()
      .split("")
      .map(function (item) {
        return LATIN[item] ?? item;
      })
      .join("");
  };
  const id = up(m[2])
    .replace(/\s+/g, "")
    .replace(/(?:[-_\s]*(?:СОРУ|КОП|МА|НА|Z))+$/u, "");
  return id ? up(m[1]) + ":" + id : null;
}

function metres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const k = Math.PI / 180;
  const x = (lng2 - lng1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  const y = (lat2 - lat1) * k;
  return Math.sqrt(x * x + y * y) * 6371000;
}

// The candidates (null: no position or no stop data -> the matcher stays strict) and every route.
export function candidatesNear(stopId: string, position?: { lat: number; lng: number }): { near: Candidate[] | null; all: Candidate[] } | null {
  const d = loaded;
  if (!d) {
    return null;
  }
  const stop = d.stops.find(function (item) {
    return item.id === stopId;
  });
  const at = position ?? (stop ? { lat: stop.lat, lng: stop.lng } : null);
  if (!at) {
    return { near: null, all: d.all };
  }
  const keys = new Set<string>();
  d.stops.forEach(function (item) {
    if (metres(at.lat, at.lng, item.lat, item.lng) <= NEAR_M) {
      item.keys.forEach(function (key) {
        keys.add(key);
      });
    }
  });
  const near = Array.from(keys)
    .map(function (item) {
      return d.byKey.get(item);
    })
    .filter(function (item): item is Candidate {
      return item !== undefined;
    });
  return { near: near.length ? near : null, all: d.all };
}
