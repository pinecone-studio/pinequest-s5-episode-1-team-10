// The service worker (public/sw.js) keeps the app shell and voice clips, never anything under /api/*.
import { expect, phrase, test } from "./fixtures";

test.use({ serviceWorkers: "allow" });

test("sw.js never caches /api/*", async function ({ page }) {
  await page.goto("/");
  await page.evaluate(function () {
    return navigator.serviceWorker.ready.then(function () {
      return true;
    });
  });
  await page.reload();
  await expect
    .poll(function () {
      return page.evaluate(function () {
        return !!navigator.serviceWorker.controller;
      });
    })
    .toBe(true);
  // Through the worker: bus data, a plan, a spoken sentence
  const statuses = await page.evaluate(async function (text: string) {
    const answers = await Promise.all([
      fetch("/api/health"),
      fetch("/api/stops/nearest?lat=47.91709&lon=106.91797"),
      fetch("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Сансар", lat: 47.91709, lon: 106.91797 }) }),
      fetch("/api/tts?text=" + encodeURIComponent(text)),
    ]);
    return answers.map(function (item) {
      return item.status;
    });
  }, phrase("searching"));
  expect(statuses).toEqual([200, 200, 200, 200]);
  const cached = await page.evaluate(async function () {
    const out: string[] = [];
    const names = await caches.keys();
    for (const name of names) {
      const cache = await caches.open(name);
      const requests = await cache.keys();
      requests.forEach(function (item) {
        out.push(name + " " + new URL(item.url).pathname);
      });
    }
    return out;
  });
  expect(cached.length, "the worker keeps the app shell").toBeGreaterThan(0);
  expect(
    cached.filter(function (item) {
      return item.indexOf(" /api/") >= 0;
    }),
  ).toEqual([]);
});
