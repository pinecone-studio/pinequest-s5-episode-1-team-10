import assert from "node:assert/strict";
import test from "node:test";
import { decideSign, routeNumber } from "./fusion.ts";

const HERE = ["Ч:7", "Ч:7а", "Ч:7Ма", "Ч:81", "М:4"];
const CITY = new Set(["4", "41", "44", "55", "58", "7", "81"]);

function verdict(texts: [string, number][], route: string, here: string[] | null, city?: Set<string> | null) {
  return decideSign(texts, route, here, city === undefined ? null : city).verdict;
}

test("route number", function () {
  assert.equal(routeNumber("Ч:81"), "81");
  assert.equal(routeNumber("М:3Ма"), "3ма");
  assert.equal(routeNumber("Ч:80-Ма"), "80ма");
  assert.equal(routeNumber("M:7"), "7");
});

test("yes on an exact match", function () {
  const d = decideSign([["81", 0.95]], "Ч:81", HERE, null);
  assert.deepEqual([d.verdict, d.confidence], ["yes", 0.95]);
});

test("yes with text around the number", function () {
  assert.equal(verdict([["Ч:81 Хангарьд", 0.9]], "Ч:81", HERE), "yes");
});

test("lookalike letters", function () {
  const d = decideSign([["7a", 0.9]], "Ч:7а", HERE, null);
  assert.deepEqual([d.verdict, d.confidence], ["yes", 0.9]);
});

test("an ambiguous sibling is unsure", function () {
  const d = decideSign([["7", 0.99]], "Ч:7", HERE, null);
  assert.deepEqual([d.verdict, d.confidence], ["unsure", 0]);
});

test("the same number with another prefix is unsure", function () {
  assert.equal(verdict([["7", 0.99]], "Ч:7", ["Ч:7", "M:7"]), "unsure");
});

test("a longer number is not a sibling", function () {
  assert.equal(verdict([["7", 0.9]], "Ч:7", ["Ч:7", "Ч:70"]), "yes");
});

test("low confidence is unsure", function () {
  const d = decideSign([["81", 0.5]], "Ч:81", HERE, null);
  assert.deepEqual([d.verdict, d.confidence], ["unsure", 0]);
});

test("another route at this stop is no", function () {
  const d = decideSign([["4", 0.9], ["7а", 0.85]], "Ч:81", HERE, null);
  assert.deepEqual([d.verdict, d.confidence], ["no", 0.9]);
});

test("a number of no route here is ignored", function () {
  const d = decideSign([["12", 0.9], ["34", 0.85]], "Ч:81", HERE, null);
  assert.deepEqual([d.verdict, d.confidence], ["unsure", 0]);
});

test("a route that does not serve the stop is unsure", function () {
  assert.equal(verdict([["81", 0.95]], "Ч:81", ["М:4"]), "unsure");
});

test("missing bus data is never yes", function () {
  assert.equal(verdict([["81", 0.95]], "Ч:81", null), "unsure");
  assert.equal(verdict([["12", 0.95]], "Ч:81", null), "no");
});

test("garbage is unsure", function () {
  const d = decideSign([["Хангарьд цогцолбор", 0.99], ["12345", 0.99], ["", 0.9]], "Ч:81", HERE, null);
  assert.deepEqual([d.verdict, d.confidence], ["unsure", 0]);
  assert.deepEqual(decideSign([], "Ч:81", HERE, null), { verdict: "unsure", confidence: 0, number: null });
});

test("a prefix misread as a digit is not that route", function () {
  assert.notEqual(verdict([["4:58", 0.95]], "М:4", HERE), "yes");
});

test("a prefix misread still matches the number", function () {
  const d = decideSign([["4:58", 0.95]], "Ч:58", ["Ч:58"], null);
  assert.deepEqual([d.verdict, d.confidence], ["yes", 0.95]);
});

test("an extra leading digit is unsure without the city list", function () {
  const d = decideSign([["455 H 1000-E", 0.94]], "Ч:55", ["Ч:55"], null);
  assert.deepEqual([d.verdict, d.confidence], ["unsure", 0]);
});

test("an LED Ч read as 4 is the Ч route when that number is not a real route", function () {
  const yes = decideSign([["455 ИЙН 1000-Е", 0.94]], "Ч:55", ["Ч:55", "Ч:58"], CITY);
  assert.deepEqual([yes.verdict, yes.confidence], ["yes", 0.94]);
  const no = decideSign([["455H1000-E", 0.95]], "Ч:58", ["Ч:55", "Ч:58"], CITY);
  assert.deepEqual([no.verdict, no.confidence], ["no", 0.95]);
});

test("a leading 4 that is a real route is not Ч", function () {
  const d = decideSign([["41", 0.95]], "Ч:1", ["Ч:1"], CITY);
  assert.deepEqual([d.verdict, d.confidence], ["unsure", 0]);
});

test("a leading 4 needs a Ч route", function () {
  const d = decideSign([["455", 0.95]], "М:55", ["М:55"], CITY);
  assert.deepEqual([d.verdict, d.confidence], ["unsure", 0]);
});

test("a fleet number never gives a verdict", function () {
  const d = decideSign([["269", 0.88], ["OPOX", 0.98]], "Ч:55", ["Ч:55", "Ч:58"], CITY);
  assert.deepEqual([d.verdict, d.confidence], ["unsure", 0]);
});

test("fleet and phone numbers are ignored", function () {
  const d = decideSign([["5-2690", 0.9], ["13-195", 1], ["7004-4040", 0.84]], "Ч:5", ["Ч:5"], null);
  assert.deepEqual([d.verdict, d.confidence], ["unsure", 0]);
});

test("another extra digit is still no", function () {
  assert.equal(verdict([["17", 0.9]], "Ч:7", HERE.concat(["Ч:17"])), "no");
});

test("a destination letter glued to the number still reads the route", function () {
  const routes = ["Ч:55", "Ч:52"];
  const city = new Set(["55", "52", "455а"]);
  const yes = decideSign([["455H 1000-E", 0.92]], "Ч:55", routes, city);
  assert.deepEqual([yes.verdict, yes.confidence], ["yes", 0.92]);
  const no = decideSign([["452H", 0.92]], "Ч:55", routes, city);
  assert.deepEqual([no.verdict, no.confidence], ["no", 0.92]);
  assert.notEqual(verdict([["7а", 0.95]], "Ч:7", ["Ч:7", "Ч:7а"], new Set(["7", "7а"])), "yes");
  assert.notEqual(verdict([["3Н", 0.95]], "Ч:3", ["Ч:3", "М:3НА"], new Set(["3", "3на"])), "yes");
  assert.notEqual(verdict([["455H", 0.92]], "Ч:55", routes, null), "yes");
});
