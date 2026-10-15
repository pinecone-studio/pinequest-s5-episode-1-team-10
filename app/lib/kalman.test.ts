import assert from "node:assert/strict";
import test from "node:test";
import { motionFromBox, predictMotion, updateMotion } from "./kalman.ts";

test("a moving box keeps its speed while it is hidden", function () {
  let motion = motionFromBox({ x: 0, y: 0, w: 100, h: 40 });
  motion = updateMotion(predictMotion(motion, 100), { x: 100, y: 0, w: 100, h: 40 });
  assert.ok(motion.cx.vel > 0.5, "velocity " + motion.cx.vel);
  const hidden = predictMotion(motion, 100);
  assert.ok(hidden.cx.pos > motion.cx.pos + 50, "predicted centre " + hidden.cx.pos);
  assert.ok(hidden.w.pos > 50);
  assert.ok(hidden.h.pos > 20);
});
