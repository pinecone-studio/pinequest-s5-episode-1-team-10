import assert from "node:assert/strict";
import test from "node:test";
import { createCallBudget } from "./call-budget.ts";

// A call attempted every 100 ms (the scanner's 10 frames a second) for 5 minutes.
function sent(perMinute: number, burst: number): number[] {
  const budget = createCallBudget(perMinute, burst);
  const at: number[] = [];
  for (let now = 0; now <= 5 * 60000; now += 100) {
    if (budget.take(now)) {
      at.push(now);
    }
  }
  return at;
}

test("a burst goes out at once", function () {
  const at = sent(20, 5);
  assert.deepEqual(at.slice(0, 5), [0, 100, 200, 300, 400]);
});

test("no 60 s window holds more than 20 calls", function () {
  const at = sent(20, 5);
  at.forEach(function (item, i) {
    const inWindow = at.filter(function (other) {
      return other >= item && other < item + 60000;
    }).length;
    assert.ok(inWindow <= 20, "window from call " + i + " holds " + inWindow);
  });
  assert.ok(at.length >= 5 * 15, "keeps sending at the even pace: " + at.length);
});

test("a pause stops calls, then the pace starts again", function () {
  const budget = createCallBudget(20, 5);
  assert.equal(budget.take(0), true);
  budget.pauseUntil(10000);
  assert.equal(budget.take(5000), false);
  assert.equal(budget.take(9999), false);
  assert.equal(budget.take(10000), true); // 10 s of refill at 15 a minute = 2.5 calls
});
