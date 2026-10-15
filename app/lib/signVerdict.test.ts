import assert from "node:assert/strict";
import test from "node:test";
import routes from "../../data/routes.json";
import { makeRouteBook } from "./parse-sign.ts";
import type { Candidate } from "./signMatch.ts";
import { verdictOf } from "./signVerdict.ts";

const ALL: Candidate[] = (routes as { key: string; terminals: [string, string] | null }[]).map(function (item) {
  return { key: item.key, terminals: item.terminals };
});
const CITY = ALL.map(function (item) {
  return item.key;
});
// Routes at Сүхбаатарын талбай, where the real night photos were taken (signMatch.test.ts)
const SUKHBAATAR = ["М:1", "М:2", "М:3", "Х:19", "Х:23", "Ч:2", "Ч:29Б", "Ч:34", "Ч:37", "Ч:48", "Ч:48А", "Ч:50", "Ч:57", "Ч:57Б", "Ч:61", "Ч:7", "Ч:71", "Ч:72", "Ч:78", "Ч:8", "ШҮ:1", "ШҮ:2"];
const POOL = {
  near: ALL.filter(function (item) {
    return SUKHBAATAR.indexOf(item.key) >= 0;
  }),
  all: ALL,
};
const BOOK = makeRouteBook(SUKHBAATAR, CITY);

function yesFor(lines: string[], pool: typeof POOL | null): string[] {
  return SUKHBAATAR.filter(function (item) {
    return verdictOf(lines, item, pool, BOOK).verdict === "yes";
  });
}

test("a clean sign: both matchers agree, only that route says yes", function () {
  assert.deepEqual(yesFor(["Ч:78"], POOL), ["Ч:78"]);
  assert.deepEqual(verdictOf(["Ч:78"], "Ч:78", POOL, BOOK), { verdict: "yes", route: "78" });
});

test("the loose matcher's yes stands when the sign parser is unsure (scrolling sign cut mid-word)", function () {
  assert.deepEqual(yesFor(["478 АЛДВАР® … …"], POOL), ["Ч:78"]);
});

test("no route data yet: only the sign parser decides (an LED Ч read as 4: 478 is Ч:78)", function () {
  assert.deepEqual(yesFor(["Ч:78"], null), ["Ч:78"]);
  assert.deepEqual(yesFor(["478 АЛДВАР® … …"], null), ["Ч:78"]);
  assert.deepEqual(yesFor(["АЛДВАР® … …"], null), []);
});

test("another route here is a clear no", function () {
  assert.deepEqual(verdictOf(["Ч:57"], "Ч:78", POOL, BOOK), { verdict: "no", route: "57" });
});

test("fleet numbers and adverts say yes for no route", function () {
  assert.deepEqual(yesFor(["hp 3-077 ? … … CIT NC"], POOL), []);
  assert.deepEqual(yesFor(["… ЗУНЫ АНТ"], POOL), []);
});

// Found 2026-10-16 by moving this decision here: signMatch ignores the stray "72" (signMatch.test.ts), but
// the sign parser alone said yes for Ч:72, a route that stops here. Now the parser alone never says yes
// when route data exists (signMatch must agree).
test("a stray bare number (72) is not route Ч:72", function () {
  assert.deepEqual(yesFor(["ЛИГ … ? … … PUB ? VIP KEC 72"], POOL), []);
});

test("a route that doesn't stop here is never a yes, however clean the sign", function () {
  const book = makeRouteBook(["Ч:57"], CITY);
  assert.notEqual(verdictOf(["Ч:78"], "Ч:78", null, book).verdict, "yes");
});
