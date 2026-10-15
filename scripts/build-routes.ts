// Builds data/routes.json and data/stops.json from the city's route list (data/route.ts, the ONLY source
// of route keys: 125 routes) and the raw Hamuga JSON in data/raw/ (used only to fill in terminals and
// stop order for routes that are in that list; nothing is added, nothing is invented).
//
//   node --experimental-strip-types scripts/build-routes.ts           build from data/raw/
//   node --experimental-strip-types scripts/build-routes.ts --fetch   first download what's missing in
//                                                                     data/raw/ (HAMUGA_API_KEY in env)
//
// data/raw/ (Hamuga answers as received):
//   stations.json            /api/bus/v1/bus_station_list  {data: [{busStopId, busStopName, gpxY, gpxX}]}
//   groups.json              /api/bus/v1/group/info        {data: [{busStopId, busStopName, routeList: [{busRouteId, busRouteNo}]}]}
//   route_stops/<id>.json    /api/bus/v1/rot_stop_by_route {data: {busRouteInfo: {busRouteName: "М:5Ма (A - via - B)"},
//                                                            rotStopList: [...], reverseRotStopList: [...]}}
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES, type RoutePrefix } from "../data/route.ts";

export interface Route {
  key: string; // ALWAYS prefix + id, unique: "Ч:29Б", "Х:7", "ШҮ:1"
  prefix: RoutePrefix;
  number: string; // "29"
  suffix: string; // "Б", "ӨВ", or "" (uppercase Cyrillic)
  terminals: [string, string] | null; // null if Hamuga lacks it; never invented
  stops: { towardsA: string[]; towardsB: string[] } | null; // ordered stop IDs per direction
}

export interface Stop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  routeKeys: string[]; // route keys like "Ч:29Б", never bare numbers
}

interface HamugaStop {
  busStopId: string;
  busStopName: string;
  busStopSeq: string;
}

interface RouteStopsRaw {
  data: {
    busRouteInfo?: { busRouteId: string; busRouteName?: string; busRouteNo?: string };
    rotStopList?: HamugaStop[] | null;
    reverseRotStopList?: HamugaStop[] | null;
  };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");
const HAMUGA = "https://gateway.hamuga.mn/transport";

// Latin letters that look like the Cyrillic ones Hamuga sometimes typed ("M:7").
const LATIN: Record<string, string> = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У" };

function cyrillic(text: string): string {
  return text
    .toUpperCase()
    .split("")
    .map(function (item) {
      return LATIN[item] ?? item;
    })
    .join("");
}

// Hamuga's variant tags after the route id: "Ма"/"-Ма" (a variant of the same route), "_copy"/"-КОП"
// (a copy; "copy" is in Cyrillic lookalikes by then: "СОРУ"), "Z"/"-Z", "НА". Each is the same bus for a
// rider: its sign shows the plain key.
const VARIANT = /(?:[-_\s]*(?:СОРУ|КОП|МА|НА|Z))+$/u;

// Hamuga busRouteNo -> { key (variant tags removed), tagged (it had any) }, or null if not "<prefix>:<id>".
function keyOf(routeNo: string): { key: string; tagged: boolean } | null {
  const m = /^\s*([^:\s-]+)\s*[:-]\s*(\S.*)$/u.exec(routeNo);
  if (!m) {
    return null;
  }
  const prefix = cyrillic(m[1]);
  const full = cyrillic(m[2]).replace(/\s+/g, "");
  const id = full.replace(VARIANT, "");
  return id ? { key: prefix + ":" + id, tagged: id !== full } : null;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

async function hamuga(path: string, params: Record<string, string>): Promise<unknown> {
  const key = (process.env.HAMUGA_API_KEY ?? "").trim();
  if (!key) {
    throw new Error("HAMUGA_API_KEY is not set (needed for --fetch)");
  }
  const res = await fetch(HAMUGA + path + "?" + new URLSearchParams(params).toString(), { headers: { "x-api-key": key } });
  if (!res.ok) {
    throw new Error("Hamuga " + path + " " + res.status);
  }
  return res.json();
}

// "М:5Ма (10-р хороолол - Сансарын тойрог - Ботаник)" -> ["10-р хороолол", "Ботаник"];
// "Арцатын ам | Гачуурт" -> ["Арцатын ам", "Гачуурт"]
function terminalsFromName(name: string | undefined): [string, string] | null {
  const text = (name ?? "").replace(/\u00a0/g, " ");
  const m = /\((.*)\)\s*$/u.exec(text);
  const inside = m ? m[1] : text.indexOf("|") >= 0 ? text : null;
  if (!inside) {
    return null;
  }
  const parts = inside
    .split(/\s+[-–—]\s+|\s*\|\s*/u)
    .map(function (item) {
      return item.trim();
    })
    .filter(Boolean);
  return parts.length >= 2 ? [parts[0], parts[parts.length - 1]] : null;
}

// "10-р хороолол /Урд/" -> "10-р хороолол" (the side of the street dropped), lowercase, for comparing.
function base(name: string): string {
  return name.replace(/\/[^/]*\/\s*$/u, "").trim().toLowerCase();
}

function ordered(list: HamugaStop[] | null | undefined): string[] {
  return (list ?? [])
    .slice()
    .sort(function (a, b) {
      return Number(a.busStopSeq) - Number(b.busStopSeq);
    })
    .map(function (item) {
      return item.busStopId;
    });
}

function nameStarts(stopName: string, terminal: string): boolean {
  const a = base(stopName);
  const b = base(terminal);
  return a.startsWith(b) || b.startsWith(a);
}

async function main(): Promise<void> {
  const fetchMissing = process.argv.indexOf("--fetch") >= 0;
  mkdirSync(join(RAW, "route_stops"), { recursive: true });
  if (fetchMissing && !existsSync(join(RAW, "stations.json"))) {
    writeFileSync(join(RAW, "stations.json"), JSON.stringify(await hamuga("/api/bus/v1/bus_station_list", { perPage: "5000", page: "1" })));
  }
  if (fetchMissing && !existsSync(join(RAW, "groups.json"))) {
    writeFileSync(join(RAW, "groups.json"), JSON.stringify(await hamuga("/api/bus/v1/group/info", {})));
  }
  const stations = readJson<{ data: { busStopId: string; busStopName: string; gpxY: string; gpxX: string }[] }>(join(RAW, "stations.json")).data;
  const groups = readJson<{ data: { busStopId: string; busStopName: string; routeList: { busRouteId: string; busRouteNo: string }[] | null }[] }>(join(RAW, "groups.json")).data;

  const listed = new Map(
    ROUTES.map(function (item) {
      return [item.key.toUpperCase(), item] as const;
    }),
  );
  if (listed.size !== ROUTES.length) {
    throw new Error("data/route.ts has duplicate keys");
  }

  // Every Hamuga route variant: busRouteId -> busRouteNo, and the keys they fold into.
  const variants = new Map<string, { routeNo: string; tagged: boolean; ids: Set<string> }[]>();
  const notListed = new Map<string, Set<string>>(); // Hamuga key not in data/route.ts -> its busRouteNos
  const unreadable = new Set<string>(); // busRouteNo that isn't "<prefix>:<id>"
  groups.forEach(function (group) {
    (group.routeList ?? []).forEach(function (item) {
      const k = keyOf(item.busRouteNo ?? "");
      if (!k) {
        unreadable.add(item.busRouteNo || "(empty, route id " + item.busRouteId + ")");
        return;
      }
      if (!listed.has(k.key)) {
        const s = notListed.get(k.key) ?? new Set<string>();
        s.add(item.busRouteNo);
        notListed.set(k.key, s);
        return;
      }
      const list = variants.get(k.key) ?? [];
      let v = list.find(function (x) {
        return x.routeNo === item.busRouteNo;
      });
      if (!v) {
        v = { routeNo: item.busRouteNo, tagged: k.tagged, ids: new Set<string>() };
        list.push(v);
      }
      v.ids.add(item.busRouteId);
      variants.set(k.key, list);
    });
  });

  // One Hamuga variant per route for terminals and stop order: the untagged one ("Ч:26"), else a "Ма"
  // variant ("М:5Ма"), copies and Z/НА variants last.
  function rank(v: { routeNo: string; tagged: boolean }): number {
    return !v.tagged ? 0 : /^[^:]*[:-]\s*[^_-]*?-?ма\s*$/iu.test(v.routeNo) ? 1 : 2;
  }
  function pick(key: string): string | null {
    const list = (variants.get(key) ?? []).slice().sort(function (a, b) {
      return rank(a) - rank(b) || a.routeNo.localeCompare(b.routeNo);
    });
    return list.length ? Array.from(list[0].ids).sort()[0] : null;
  }

  if (fetchMissing) {
    const todo = ROUTES.map(function (item) {
      return pick(item.key.toUpperCase());
    }).filter(function (item): item is string {
      return item !== null && !existsSync(join(RAW, "route_stops", item + ".json"));
    });
    console.log("fetching " + todo.length + " route stop lists from Hamuga");
    for (let i = 0; i < todo.length; i += 8) {
      await Promise.all(
        todo.slice(i, i + 8).map(async function (item) {
          writeFileSync(join(RAW, "route_stops", item + ".json"), JSON.stringify(await hamuga("/api/bus/v1/rot_stop_by_route", { route_id: item })));
        }),
      );
    }
  }

  const stopNames = new Map(
    stations.map(function (item) {
      return [item.busStopId, item.busStopName] as const;
    }),
  );
  const report = { matched: [] as string[], noHamuga: [] as string[], noTerminals: [] as string[], noStops: [] as string[], terminalsFromStops: [] as string[] };
  const routes: Route[] = ROUTES.map(function (item) {
    const key = item.key.toUpperCase();
    const m = /^(\d+)(.*)$/u.exec(item.id.toUpperCase());
    const route: Route = { key, prefix: item.prefix, number: m ? m[1] : item.id.toUpperCase(), suffix: m ? m[2] : "", terminals: null, stops: null };
    const id = pick(key);
    if (!id) {
      report.noHamuga.push(key);
      return route;
    }
    report.matched.push(key);
    const path = join(RAW, "route_stops", id + ".json");
    if (!existsSync(path)) {
      report.noStops.push(key + " (no data/raw/route_stops/" + id + ".json: run with --fetch)");
      report.noTerminals.push(key);
      return route;
    }
    const raw = readJson<RouteStopsRaw>(path).data;
    const forward = ordered(raw.rotStopList);
    const reverse = ordered(raw.reverseRotStopList);
    let terminals = terminalsFromName(raw.busRouteInfo?.busRouteName);
    if (!terminals && forward.length >= 2) {
      // The route's own first and last stop (Hamuga data, not a guess), when its name has no "(A - B)".
      terminals = [stopNames.get(forward[0]) ?? "", stopNames.get(forward[forward.length - 1]) ?? ""];
      if (terminals[0] && terminals[1]) {
        report.terminalsFromStops.push(key);
      } else {
        terminals = null;
      }
    }
    route.terminals = terminals;
    if (!terminals) {
      report.noTerminals.push(key);
    }
    if (forward.length || reverse.length) {
      // rotStopList runs from one end to the other: towardsB if it starts at terminal A.
      const startsAtB = terminals !== null && forward.length > 0 && nameStarts(stopNames.get(forward[0]) ?? "", terminals[1]) && !nameStarts(stopNames.get(forward[0]) ?? "", terminals[0]);
      route.stops = startsAtB ? { towardsA: forward, towardsB: reverse } : { towardsA: reverse, towardsB: forward };
    } else {
      report.noStops.push(key);
    }
    return route;
  });

  // Stops: every Hamuga stop with coordinates, with the listed routes that stop there.
  const coords = new Map(
    stations
      .filter(function (item) {
        return Number(item.gpxY) && Number(item.gpxX);
      })
      .map(function (item) {
        return [item.busStopId, { lat: Number(item.gpxY), lng: Number(item.gpxX) }] as const;
      }),
  );
  const stops: Stop[] = [];
  let noCoords = 0;
  let noListedRoute = 0;
  groups.forEach(function (group) {
    const keys = new Set<string>();
    (group.routeList ?? []).forEach(function (item) {
      const k = keyOf(item.busRouteNo ?? "");
      if (k && listed.has(k.key)) {
        keys.add(k.key);
      }
    });
    const at = coords.get(group.busStopId);
    if (!at) {
      noCoords++;
      return;
    }
    if (!keys.size) {
      noListedRoute++;
      return;
    }
    stops.push({ id: group.busStopId, name: group.busStopName, lat: at.lat, lng: at.lng, routeKeys: Array.from(keys).sort() });
  });

  writeFileSync(join(ROOT, "data", "routes.json"), JSON.stringify(routes, null, 1) + "\n");
  writeFileSync(join(ROOT, "data", "stops.json"), JSON.stringify(stops, null, 1) + "\n");

  console.log("\n== routes: " + routes.length + " (data/route.ts), written to data/routes.json");
  console.log("matched to Hamuga data: " + report.matched.length);
  console.log("not in Hamuga at all (" + report.noHamuga.length + "): " + report.noHamuga.join(", "));
  console.log("missing terminals (" + report.noTerminals.length + "): " + report.noTerminals.join(", "));
  console.log("missing stops (" + report.noStops.length + "): " + report.noStops.join(", "));
  console.log("terminals taken from the first/last stop (route name had none) (" + report.terminalsFromStops.length + "): " + report.terminalsFromStops.join(", "));
  console.log("Hamuga variants folded into a listed route:");
  Array.from(variants.entries()).forEach(function (item) {
    if (item[1].length > 1 || item[1][0].routeNo.toUpperCase() !== item[0]) {
      console.log("  " + item[0] + " <- " + item[1].map(function (v) {
        return v.routeNo;
      }).join(", "));
    }
  });
  console.log("\n== Hamuga routes NOT in data/route.ts (" + notListed.size + ", not added):");
  Array.from(notListed.entries())
    .sort()
    .forEach(function (item) {
      console.log("  " + item[0] + " <- " + Array.from(item[1]).join(", "));
    });
  console.log("Hamuga route numbers that aren't <prefix>:<id> (" + unreadable.size + ", not used): " + Array.from(unreadable).join(", "));
  console.log("\n== stops: " + stops.length + " written to data/stops.json; left out: " + noCoords + " without coordinates, " + noListedRoute + " with no listed route");
}

main().catch(function (e: unknown) {
  console.error(e);
  process.exit(1);
});
