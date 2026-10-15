// Offline matcher report (npm run match-report): the sign decision that ships (lib/signVerdict.ts, the
// ?scanner=azure camera step) on cached OCR of the real night photos in public/test-fixtures/bus, for
// every route near the photos' stop. A wrong "yes" is a yes for any route but the photo's own (any yes
// on a photo with no readable number); exit 1 if there is one. No network: the cache is made by
// e2e/make-ocr-cache.mjs (on-device OCR in local Chromium) and holds texts only.
// Also shown, not counted in the exit code: BusCamera's rules (lib/signMatch.ts fast path, else
// lib/fusion.ts decideSign) as if the same read came in every frame (more lenient than the phone, which needs two agreeing reads).
import { build } from "esbuild";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DIR = "public/test-fixtures/bus/";
const CACHE = DIR + "ocr-cache.json";
const ROUTE_DATA = "public/data/route-data.json";

if (!existsSync(CACHE) || !existsSync(DIR + "labels.json")) {
  console.error("No " + CACHE + " (or labels.json): the photos are local only. Make the cache with e2e/make-ocr-cache.mjs.");
  process.exit(2);
}

// The app's own code, bundled for Node like scripts/run-tests.mjs.
const out = join(mkdtempSync(join(tmpdir(), "match-report-")), "lib.mjs");
await build({
  stdin: {
    contents: [
      'export { verdictOf } from "./lib/signVerdict.ts";',
      'export { makeRouteBook } from "./lib/parse-sign.ts";',
      'export { candidatesNear, loadRouteData } from "./lib/candidates.ts";',
      'export { matchSign } from "./lib/signMatch.ts";',
      'export { decideSign } from "./lib/fusion.ts";',
    ].join("\n"),
    resolveDir: process.cwd(),
    loader: "ts",
  },
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "warning",
});
const lib = await import(pathToFileURL(out).href);

// candidates.ts loads the route data with fetch: answered from the file.
const routeData = JSON.parse(readFileSync(ROUTE_DATA, "utf8"));
globalThis.fetch = function () {
  return Promise.resolve({
    ok: true,
    json: function () {
      return Promise.resolve(routeData);
    },
  });
};
await lib.loadRouteData();

const cache = JSON.parse(readFileSync(CACHE, "utf8"));
const labels = JSON.parse(readFileSync(DIR + "labels.json", "utf8"));
const stop = labels.stop;
// The routes within 150 m of the stop, the same rule as the camera (candidates.ts).
const pool = lib.candidatesNear("", { lat: stop.lat, lng: stop.lng });
if (!pool || !pool.near) {
  console.error("no routes near " + stop.name);
  process.exit(2);
}
const near = pool.near.map(function (item) {
  return item.key;
});
const city = pool.all.map(function (item) {
  return item.key;
});
// The phone's book holds the stop's own routes from the bus data; here the routes near it (a superset:
// more routes that may say yes, so a stricter check).
const book = lib.makeRouteBook(near, city);
const citySet = new Set(
  routeData.routes.map(function (item) {
    return item[0];
  }),
);

// A read: the lines of one crop (or whole frame) and its confidence.
function shippedYes(reads) {
  return near.filter(function (route) {
    return reads.some(function (item) {
      return lib.verdictOf(item.lines, route, pool, book).verdict === "yes";
    });
  });
}

function cameraYes(reads) {
  return near.filter(function (route) {
    return reads.some(function (item) {
      const quick = lib.matchSign(item.lines.join(" "), route, pool.near, pool.all);
      if (quick.verdict === "yes") {
        return true;
      }
      const texts = item.lines.map(function (line) {
        return [line, item.conf];
      });
      // BusCamera.judge: with route data, the number rules alone never vote yes (signMatch must agree).
      const decided = lib.decideSign(texts, route, near, citySet).verdict;
      return (pool ? (decided === "yes" ? "unsure" : decided) : decided) === "yes";
    });
  });
}

const entries = [];
Object.keys(cache.photos).forEach(function (photo) {
  const p = cache.photos[photo];
  const reads = []
    .concat(
      (p.local ?? []).map(function (item) {
        return { source: "local", lines: item.text ? [item.text] : [], conf: item.conf };
      }),
    )
    .concat(
      (p.azure ?? []).map(function (item) {
        return { source: "azure", lines: item, conf: 1 };
      }),
    )
    .filter(function (item) {
      return item.lines.length > 0;
    });
  entries.push({ name: photo, truth: labels.photos[photo] ?? null, reads: reads });
});
(cache.frames ?? []).forEach(function (item, i) {
  entries.push({ name: "frame " + (i + 1) + " (" + item.note + ")", truth: item.truth, reads: [{ source: "azure frame", lines: item.lines, conf: 1 }] });
});

const totals = { shipped: { wrong: 0, right: 0 }, camera: { wrong: 0, right: 0 } };
let labelled = 0;
let withText = 0;
console.log("Stop: " + stop.name + ", " + near.length + " routes within 150 m: " + near.join(" "));
console.log("Cache: " + (cache.made ?? "?") + " · " + (cache.bench ?? ""));
console.log("");
entries.forEach(function (item) {
  const shipped = shippedYes(item.reads);
  const camera = cameraYes(item.reads);
  if (item.truth) {
    labelled++;
  }
  if (item.reads.length) {
    withText++;
  }
  [
    ["shipped", shipped],
    ["camera", camera],
  ].forEach(function (pair) {
    const yes = pair[1];
    totals[pair[0]].wrong += yes.filter(function (route) {
      return route !== item.truth;
    }).length;
    totals[pair[0]].right += item.truth && yes.indexOf(item.truth) >= 0 ? 1 : 0;
  });
  const text = item.reads
    .map(function (read) {
      return read.lines.join(" / ");
    })
    .join(" | ");
  const flag = shipped.some(function (route) {
    return route !== item.truth;
  })
    ? "  WRONG YES"
    : "";
  console.log(item.name + "  truth " + (item.truth ?? "-") + "  yes [" + shipped.join(" ") + "]  camera rules [" + camera.join(" ") + "]  «" + text.slice(0, 90) + "»" + flag);
});
console.log("");
console.log(entries.length + " entries (" + Object.keys(cache.photos).length + " photos + " + (cache.frames ?? []).length + " whole-frame reads), " + withText + " with any text, " + labelled + " with a route");
console.log("Shipped decision (lib/signVerdict.ts): wrong yes " + totals.shipped.wrong + " · right yes " + totals.shipped.right + "/" + labelled);
console.log("BusCamera rules, one read as if every frame: wrong yes " + totals.camera.wrong + " · right yes " + totals.camera.right + "/" + labelled);
process.exit(totals.shipped.wrong > 0 || totals.camera.wrong > 0 ? 1 : 0);
