import assert from "node:assert/strict";
import test from "node:test";
import { guideToDoor, MAIN_FOV_DEG, ULTRA_WIDE_FOV_DEG } from "./door.ts";

const bus = { x: 100, y: 200, w: 600, h: 300 };
const upright = { x: 100, y: 300, w: 500, h: 400 };
const filling = { x: 0, y: 0, w: 1280, h: 720 };
const roofCut = { x: 300, y: 0, w: 900, h: 500 };

// Outputs of guideToDoor before the field of view became a parameter (main camera, 65 deg).
test("the main camera's door guidance is unchanged", function () {
  assert.deepEqual(guideToDoor(bus, 1280, 720, true, null), { angle: 0, clock: 12, steps: 14, distanceM: 10.045987693551938, ahead: true, close: false, x: 640 });
  assert.deepEqual(guideToDoor(upright, 720, 1280, false, 0.1), { angle: -11.807015732903016, clock: 12, steps: 11, distanceM: 7.697348645195032, ahead: false, close: false, x: 150 });
  assert.deepEqual(guideToDoor(filling, 1280, 720, true, null), { angle: 32.5, clock: 1, steps: 3, distanceM: 1.7785335711512409, ahead: false, close: true, x: 1280 });
  assert.deepEqual(guideToDoor(roofCut, 1280, 720, true, null), { angle: 25.072471622690077, clock: 1, steps: 15, distanceM: 10.29885217918118, ahead: false, close: false, x: 1110 });
});

test("fovDeg 65 is the default", function () {
  [bus, upright, filling, roofCut].forEach(function (item) {
    assert.deepEqual(guideToDoor(item, 1280, 720, true, null, MAIN_FOV_DEG), guideToDoor(item, 1280, 720, true, null));
  });
});

test("with the ultra-wide the same box is a nearer bus at a wider angle", function () {
  const main = guideToDoor(roofCut, 1280, 720, true, null);
  const wide = guideToDoor(roofCut, 1280, 720, true, null, ULTRA_WIDE_FOV_DEG);
  assert.ok(wide.distanceM < main.distanceM);
  assert.ok(Math.abs(wide.angle) > Math.abs(main.angle)); // a pixel off-centre is a wider angle
  const edge = guideToDoor(filling, 1280, 720, true, null, ULTRA_WIDE_FOV_DEG);
  assert.equal(Math.round(edge.angle), 54); // the frame edge is half the field of view
});
