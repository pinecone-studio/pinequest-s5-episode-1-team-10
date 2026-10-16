import assert from "node:assert/strict";
import test from "node:test";
import routes from "../../data/routes.json";
import { matchSign, type Candidate } from "./signMatch.ts";

const ALL: Candidate[] = (routes as { key: string; terminals: [string, string] | null }[]).map(function (item) {
  return { key: item.key, terminals: item.terminals };
});

function pick(keys: string[]): Candidate[] {
  return keys.map(function (item) {
    const found = ALL.find(function (c) {
      return c.key === item;
    });
    assert.ok(found, item + " is in data/routes.json");
    return found as Candidate;
  });
}

test("all 125 routes are candidates when nothing is known", function () {
  assert.equal(ALL.length, 125);
});

test("garbled number + cut-off destination: the only route going there", function () {
  const r = matchSign("2Э ВОКЗ", "Ч:29Б", pick(["Ч:29Б", "Ч:57", "Х:7"]), ALL);
  assert.equal(r.verdict, "yes");
  assert.equal(r.best, "Ч:29Б");
});

test("destination alone (number unreadable)", function () {
  const r = matchSign("ВОКЗАЛ", "Ч:29Б", pick(["Ч:29Б", "Ч:57", "Х:7"]), ALL);
  assert.equal(r.verdict, "yes");
});

test("a look-alike route here: Ч:57 read, Ч:57Б wanted -> no match", function () {
  const r = matchSign("Ч:57 ...", "Ч:57Б", pick(["Ч:57", "Ч:57Б"]), ALL);
  assert.notEqual(r.verdict, "yes");
});

test("bare number shared by two routes here (Ч:7 / Х:7) -> no match", function () {
  const r = matchSign("7 ...", "Ч:7", pick(["Ч:7", "Х:7"]), ALL);
  assert.notEqual(r.verdict, "yes");
});

test("no stop data: strict, a bare number is not enough", function () {
  const r = matchSign("57", "Ч:57Б", null, ALL);
  assert.notEqual(r.verdict, "yes");
});

test("no stop data: prefix + exact id with a lookalike (4 for Ч) is accepted", function () {
  assert.equal(matchSign("4:57Б", "Ч:57Б", null, ALL).verdict, "yes");
  assert.equal(matchSign("Ч:57", "Ч:57Б", null, ALL).verdict, "no");
});

test("the LED sign read on test photo 1 (Ч:55 read as 455) at its stop", function () {
  const r = matchSign("PAH5yy3 455 H 1000-E", "Ч:55", pick(["Ч:55", "Ч:7", "Ч:29Б", "М:3"]), ALL);
  assert.equal(r.verdict, "yes");
});

// Real night photos at Сүхбаатарын талбай (2026-10-16), what Azure read on the whole frame.
const SUKHBAATAR = ["М:1", "М:2", "М:3", "Х:19", "Х:23", "Ч:2", "Ч:29Б", "Ч:34", "Ч:37", "Ч:48", "Ч:48А", "Ч:50", "Ч:57", "Ч:57Б", "Ч:61", "Ч:7", "Ч:71", "Ч:72", "Ч:78", "Ч:8", "ШҮ:1", "ШҮ:2"];

function yesFor(text: string): string[] {
  const near = pick(SUKHBAATAR);
  return SUKHBAATAR.filter(function (item) {
    return matchSign(text, item, near, ALL).verdict === "yes";
  });
}

test("a fleet number on the bus body (3-077) is not route 37", function () {
  assert.deepEqual(yesFor("hp 3-077 ? … … CIT NC"), []);
});

test("a stray bare number (72) is not route Ч:72", function () {
  assert.deepEqual(yesFor("ЛИГ … ? … … PUB ? VIP KEC 72"), []);
});

test("an advert word that looks like a terminal (ЗУНЫ ~ Зунжин) is not М:2", function () {
  assert.deepEqual(yesFor("… ЗУНЫ АНТ"), []);
});

test("a scrolling sign cut mid-word: 478 АЛДВАР(ТЫН) -> Ч:78", function () {
  assert.deepEqual(yesFor("478 АЛДВАР® … …"), ["Ч:78"]);
});

test("М:1 read with its number -> М:1; its destination alone (shared with ШҮ:1, Ч:61) -> nothing", function () {
  assert.deepEqual(yesFor("… … M:1 TAB"), ["М:1"]);
  assert.deepEqual(yesFor("… ? … ХОЛБОГдох уТАс … ЦЕРУУДЫН ОРДОН"), []);
});
