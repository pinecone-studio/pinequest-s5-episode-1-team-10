import assert from "node:assert/strict";
import test from "node:test";
import { backTarget, createRuns, launchStep, primaryWithBack, type BackContext, type Step } from "./journey.ts";

const CTX: BackContext = { typeFor: "dest", numberNext: "find", located: true, placeFromGps: true, workingFor: "ask", settingsFrom: "ask" };

const STEPS: Step[] = [
  "start", "home", "learn", "locating", "confirmPlace", "where", "whereListening", "ask", "listening", "working", "planned",
  "camera", "ride", "arrived", "number", "numberListening", "numberConfirm", "confirmDest", "typing", "settings",
];

test("launch: the mode choice until a mode is saved, then home", function () {
  assert.equal(launchStep(null), "start");
  assert.equal(launchStep("sr"), "home");
  assert.equal(launchStep("voice"), "home");
});

test("every screen but the first has a back target", function () {
  STEPS.forEach(function (item) {
    const target = backTarget(item, CTX);
    if (item === "start") {
      assert.equal(target, null);
    } else {
      assert.notEqual(target, null, item);
      assert.notEqual(target, item, item);
    }
  });
});

test("the bus journey goes back one screen at a time, to home", function () {
  assert.equal(backTarget("home", CTX), "start");
  assert.equal(backTarget("locating", CTX), "home");
  assert.equal(backTarget("confirmPlace", CTX), "home");
  assert.equal(backTarget("where", CTX), "home");
  assert.equal(backTarget("ask", CTX), "home");
  assert.equal(backTarget("listening", CTX), "ask");
  assert.equal(backTarget("working", CTX), "ask");
  assert.equal(backTarget("confirmDest", CTX), "ask");
  assert.equal(backTarget("planned", CTX), "ask");
  assert.equal(backTarget("camera", CTX), "planned");
  assert.equal(backTarget("ride", CTX), "planned");
  assert.equal(backTarget("arrived", CTX), "home");
});

test("back depends on how the screen was reached", function () {
  assert.equal(backTarget("learn", { ...CTX, located: false }), "home");
  assert.equal(backTarget("learn", CTX), "ask");
  assert.equal(backTarget("number", CTX), "home");
  assert.equal(backTarget("number", { ...CTX, numberNext: "ask" }), "ask");
  assert.equal(backTarget("numberListening", CTX), "number");
  assert.equal(backTarget("numberConfirm", CTX), "number");
  assert.equal(backTarget("confirmPlace", { ...CTX, placeFromGps: false }), "where");
  assert.equal(backTarget("whereListening", CTX), "where");
  assert.equal(backTarget("working", { ...CTX, workingFor: "where" }), "where");
  assert.equal(backTarget("typing", { ...CTX, typeFor: "number" }), "number");
  assert.equal(backTarget("typing", CTX), "ask");
  assert.equal(backTarget("typing", { ...CTX, typeFor: "where" }), "where");
  assert.equal(backTarget("settings", CTX), "ask");
  assert.equal(backTarget("settings", { ...CTX, settingsFrom: "where" }), "where");
});

test("back is never the double-tap default", function () {
  assert.equal(primaryWithBack(1, 2), 1); // camera, bus found: "door", "on the bus" (default), back
  assert.equal(primaryWithBack(0, 0), undefined); // camera, still looking: back only, a double tap does nothing
  assert.equal(primaryWithBack(0, 1), 0); // ride: "stops left" (default), back
  assert.equal(primaryWithBack(undefined, 1), undefined); // arrived: no default, as before
  assert.equal(primaryWithBack(0, 2), 0); // home: "Автобус" (default), "Ном унших", back
});

test("a flow waiting when back is pressed is stale; a new one is not", function () {
  const runs = createRuns();
  const first = runs.ticket();
  assert.equal(first(), true);
  runs.cancel();
  assert.equal(first(), false);
  const second = runs.ticket();
  assert.equal(second(), true);
  assert.equal(first(), false);
});
