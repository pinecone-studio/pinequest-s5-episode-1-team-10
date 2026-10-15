// Makes public/test-fixtures/bus/ocr-cache.json for scripts/match-report.mjs, with NO paid call: local
// Chromium opens /debug/ocr-bench?azure=0 (the phone's own sign reader on each LED crop) and keeps what
// it read. /api/read-sign is blocked here too, so Azure can't be called by mistake. The photos and the
// cache stay local (gitignored: bystanders).
//   BASE_URL=http://localhost:3200 node e2e/make-ocr-cache.mjs   (a `next start` of this app)
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const DIR = "public/test-fixtures/bus/";
const MINUTES = 20;

// What Azure read on whole frames of these photos (lib/signMatch.test.ts, 2026-10-16), kept as frame
// entries. truth: the route the unit test says it is; null where no route may say yes.
const FRAMES = [
  { truth: null, lines: ["hp 3-077 ? … … CIT NC"], note: "fleet number 3-077" },
  { truth: null, lines: ["ЛИГ … ? … … PUB ? VIP KEC 72"], note: "stray 72" },
  { truth: null, lines: ["… ЗУНЫ АНТ"], note: "advert ЗУНЫ ~ Зунжин" },
  { truth: "Ч:78", lines: ["478 АЛДВАР® … …"], note: "scrolling sign cut mid-word" },
  { truth: "М:1", lines: ["… … M:1 TAB"], note: "М:1 with its number" },
  { truth: "М:1", lines: ["… ? … ХОЛБОГдох уТАс … ЦЕРУУДЫН ОРДОН"], note: "М:1 destination only" },
];

const labels = JSON.parse(readFileSync(DIR + "labels.json", "utf8"));
const browser = await chromium.launch();
const context = await browser.newContext({ serviceWorkers: "block" });
await context.route("**/api/read-sign**", function (route) {
  console.error("blocked a call to " + route.request().url());
  return route.abort();
});
const page = await context.newPage();
page.on("console", function (msg) {
  if (msg.type() === "error" || msg.text().startsWith("[local-ocr]")) {
    console.log("[page] " + msg.text());
  }
});
await page.goto(BASE_URL + "/debug/ocr-bench?azure=0");
await page.waitForFunction(
  function () {
    const status = document.getElementById("bench-status");
    return !!status && /^(done|No fixtures|no route data)/.test(status.textContent ?? "");
  },
  null,
  { timeout: MINUTES * 60 * 1000, polling: 1000 },
);
const status = await page.locator("#bench-status").textContent();
const bench = await page.evaluate(function () {
  return window.__bench ?? null;
});
await browser.close();
if (!bench) {
  console.error("the bench did not finish: " + status);
  process.exit(1);
}
const photos = {};
bench.forEach(function (item) {
  photos[item.photo] = { truth: item.truth, crops: item.crops, local: item.localCrops, azure: item.azureCrops };
});
const cache = {
  note: "OCR of the bus fixtures for scripts/match-report.mjs. local: the phone's reader on each LED crop (Chromium, /debug/ocr-bench?azure=0); azure: none read (no paid calls); frames: Azure whole-frame reads from lib/signMatch.test.ts.",
  made: new Date().toISOString(),
  bench: status,
  stop: labels.stop,
  photos: photos,
  frames: FRAMES,
};
writeFileSync(DIR + "ocr-cache.json", JSON.stringify(cache, null, 1) + "\n");
const read = bench.filter(function (item) {
  return item.localCrops.some(function (crop) {
    return crop.text.trim() !== "";
  });
}).length;
console.log("wrote " + DIR + "ocr-cache.json: " + bench.length + " photos, " + read + " with some on-device text (" + status + ")");
