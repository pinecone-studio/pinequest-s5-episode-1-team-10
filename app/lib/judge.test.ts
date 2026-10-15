import assert from "node:assert/strict";
import test from "node:test";
import { applyRead, type CountedRead } from "./judge.ts";

function read(verdict: "yes" | "no", frame: number, number = verdict === "yes" ? "55" : "58", confidence = 0.9): CountedRead {
  return { verdict, confidence, number, frame };
}

test("one read never decides", function () {
  const once = applyRead([], read("yes", 1));
  assert.equal(once.decision, "checking");
  assert.equal(once.reads.length, 1);
});

test("two yes reads from different frames decide yes", function () {
  const once = applyRead([], read("yes", 1));
  const twice = applyRead(once.reads, read("yes", 2));
  assert.equal(twice.decision, "yes");
});

test("the same frame twice is still one read", function () {
  const once = applyRead([], read("yes", 1));
  const again = applyRead(once.reads, read("yes", 1));
  assert.equal(again.decision, "checking");
  assert.equal(again.reads.length, 1);
});

test("confidence under 0.8 does not count", function () {
  const once = applyRead([], read("yes", 1));
  const weak = applyRead(once.reads, read("yes", 2, "55", 0.79));
  assert.equal(weak.decision, "checking");
  assert.equal(weak.reads.length, 1);
});

test("two reads of another route are no", function () {
  const once = applyRead([], read("no", 1));
  const twice = applyRead(once.reads, read("no", 2));
  assert.equal(twice.decision, "no");
});

test("a different route number resets to unsure", function () {
  const once = applyRead([], read("yes", 1));
  const twice = applyRead(once.reads, read("yes", 2));
  const conflict = applyRead(twice.reads, read("no", 3));
  assert.equal(conflict.decision, "unsure");
  assert.equal(conflict.reads.length, 0);
});

test("after a reset, one new read still does not decide", function () {
  const conflict = applyRead([read("yes", 1), read("yes", 2)], read("no", 3));
  const again = applyRead(conflict.reads, read("no", 4));
  assert.equal(again.decision, "checking");
});
