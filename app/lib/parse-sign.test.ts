import assert from "node:assert/strict";
import test from "node:test";
import { makeRouteBook, matchSign, parseRoute, signKey, toCyrillic } from "./parse-sign.ts";

// Routes at the stop (Hamuga busRouteNo) and every route number in the city (server route_number form).
const HERE = ["Ч:55", "Ч:55_copy", "Ч:29", "Ч:29Б", "Т:2", "Ч:7а", "Ч:58"];
const CITY = ["55", "55_copy", "29", "29б", "2", "7а", "58", "26", "3", "10"];
const book = makeRouteBook(HERE, CITY);

test("Latin lookalikes become Cyrillic", function () {
  assert.equal(toCyrillic("ABEKMHOPCTXY"), "АВЕКМНОРСТХУ");
  assert.equal(toCyrillic("Ч:29Б U 7"), "Ч:29Б U 7");
});

test("sign keys: number and А/Б only, variant tags dropped", function () {
  assert.equal(signKey("Ч:29Б"), "29Б");
  assert.equal(signKey("Ч:55_copy"), "55");
  assert.equal(signKey("Ч:55-Ма"), "55");
  assert.equal(signKey("М:3Ма"), "3");
  assert.equal(signKey("Ч:7а"), "7А");
  assert.equal(signKey("29б"), "29Б");
  assert.equal(signKey("Ч:"), null);
});

test("route markers Ч, 4 and U before : . or a space", function () {
  ["Ч:29Б", "Ч.29Б", "Ч 29Б", "4:29Б", "4.29Б", "4 29Б", "U:29Б", "U.29Б", "U 29Б", "Ч:29Б Сансар"].forEach(function (item) {
    assert.equal(parseRoute(item, book), "29Б", item);
  });
  assert.equal(parseRoute("Ч55", book), "55");
  assert.equal(parseRoute("Т:2", book), "2");
});

test("Latin letters on the sign are read as Cyrillic", function () {
  assert.equal(parseRoute("Ч:7A", book), "7А");
  assert.equal(parseRoute("7a", book), "7А");
});

test("a trailing 6 or b is Б only when the read itself is no route", function () {
  assert.equal(parseRoute("296", book), "29Б");
  assert.equal(parseRoute("Ч:29b", book), "29Б");
  const withB = makeRouteBook(["Ч:2Б"], ["2б", "26"]);
  assert.equal(parseRoute("26", withB), "26"); // a real route: never turned into 2Б
  assert.equal(parseRoute("2b", withB), "2Б");
});

test("no corrections without the city's route list", function () {
  const bare = makeRouteBook(HERE, null);
  assert.equal(parseRoute("29Б", bare), "29Б");
  assert.equal(parseRoute("296", bare), null);
  assert.equal(parseRoute("455", bare), null);
});

test("fleet numbers, plates and ordinals are not routes", function () {
  ["77", "13-278", "5-269", "4721 УБА", "Н1000-Э", "3-р хороолол", "10-р хороолол", "?", ""].forEach(function (item) {
    assert.equal(parseRoute(item, book), null, item);
  });
});

test("an LED Ч read as a glued 4", function () {
  assert.equal(parseRoute("455", book), "55");
  assert.equal(parseRoute("455H1000-E", book), "55");
  assert.equal(parseRoute("55Н1000-Э", book), "55");
  assert.equal(parseRoute("42", book), null); // Т:2 is no Ч route
});

test("two route numbers on one line is no answer", function () {
  assert.equal(parseRoute("55 58", book), null);
});

test("the first matching frame says yes", function () {
  assert.deepEqual(matchSign(["Ч:55 Н1000-Э"], "Ч:55", book), { verdict: "yes", route: "55" });
  assert.deepEqual(matchSign(["455"], "Ч:55", book), { verdict: "yes", route: "55" });
  assert.deepEqual(matchSign(["Ч:7a"], "Ч:7а", book), { verdict: "yes", route: "7А" });
});

test("matching is exact: 29 is not 29Б", function () {
  assert.deepEqual(matchSign(["Ч:29Б"], "Ч:29", book), { verdict: "no", route: "29Б" });
  assert.deepEqual(matchSign(["Ч:29Б"], "Ч:29Б", book), { verdict: "yes", route: "29Б" });
});

test("a 29 read where 29Б also stops may be a cut-short 29Б", function () {
  assert.deepEqual(matchSign(["Ч:29"], "Ч:29", book), { verdict: "unsure", route: "29" });
  assert.deepEqual(matchSign(["29"], "Ч:29Б", book), { verdict: "no", route: "29" });
});

test("another prefix with the same number here is unsure", function () {
  const shared = makeRouteBook(["Ч:55", "Т:55"], ["55"]);
  assert.deepEqual(matchSign(["55"], "Ч:55", shared), { verdict: "unsure", route: "55" });
});

test("without bus data, or a route that doesn't stop here, never yes", function () {
  assert.equal(matchSign(["Ч:55"], "Ч:55", makeRouteBook(null, CITY)).verdict, "unsure");
  assert.equal(matchSign(["26"], "Ч:26", book).verdict, "unsure");
});

test("a different route here is no; numbers that prove nothing are silent", function () {
  assert.deepEqual(matchSign(["Ч:58 Сансар"], "Ч:55", book), { verdict: "no", route: "58" });
  assert.deepEqual(matchSign(["26"], "Ч:55", book), { verdict: "unsure", route: null }); // passing by
  assert.deepEqual(matchSign(["77"], "Ч:55", book), { verdict: "unsure", route: null }); // fleet number
  assert.deepEqual(matchSign(["Ч:? Сансар"], "Ч:55", book), { verdict: "unsure", route: null }); // low confidence
  assert.equal(parseRoute("Ч:55 ?", book), null);
  assert.deepEqual(matchSign([], "Ч:55", book), { verdict: "unsure", route: null });
});

test("an unclear word right after our number may be its letter: unsure", function () {
  const passingB = makeRouteBook(["Ч:55"], ["55", "55б"]); // 55Б doesn't stop here, so no sibling check
  assert.deepEqual(matchSign(["Ч:55 ?"], "Ч:55", passingB), { verdict: "unsure", route: "55" });
  assert.deepEqual(matchSign(["? Ч:55"], "Ч:55", passingB), { verdict: "yes", route: "55" });
});

test("two numbers on one crop, or a read that can't tell 29 from 29Б, is unsure", function () {
  assert.deepEqual(matchSign(["Ч:55", "58"], "Ч:55", book), { verdict: "unsure", route: "55" });
  assert.deepEqual(matchSign(["29B"], "Ч:29", book), { verdict: "unsure", route: "29" });
});
