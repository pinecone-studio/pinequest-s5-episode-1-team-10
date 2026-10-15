import assert from "node:assert/strict";
import test from "node:test";
import { isLedColor, ledBoxes } from "./crop-led.ts";

const W = 320;
const H = 180;

function image(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    px[i * 4] = 40; // dark grey street
    px[i * 4 + 1] = 40;
    px[i * 4 + 2] = 45;
    px[i * 4 + 3] = 255;
  }
  return px;
}

function paint(px: Uint8ClampedArray, x: number, y: number, w: number, h: number, rgb: number[]): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      px[(yy * W + xx) * 4] = rgb[0];
      px[(yy * W + xx) * 4 + 1] = rgb[1];
      px[(yy * W + xx) * 4 + 2] = rgb[2];
    }
  }
}

test("LED colours: amber, red and green; not white, grey, dark or blue", function () {
  assert.equal(isLedColor(255, 150, 0), true); // amber
  assert.equal(isLedColor(255, 30, 60), true); // red, hue ~350
  assert.equal(isLedColor(40, 255, 90), true); // green
  assert.equal(isLedColor(255, 255, 255), false);
  assert.equal(isLedColor(128, 128, 128), false);
  assert.equal(isLedColor(110, 60, 0), false); // too dark
  assert.equal(isLedColor(30, 60, 255), false); // blue
  assert.equal(isLedColor(255, 230, 180), false); // too pale (saturation 0.29)
});

test("letters of one LED line become one wide box", function () {
  const px = image();
  // "Ч:55" as 4 letters 6x8 px with 3 px gaps, amber
  [100, 109, 118, 127].forEach(function (item) {
    paint(px, item, 40, 6, 8, [255, 140, 0]);
  });
  const boxes = ledBoxes(px, W, H);
  assert.equal(boxes.length, 1);
  assert.deepEqual([boxes[0].x, boxes[0].y, boxes[0].w, boxes[0].h], [100, 40, 33, 8]);
});

test("round lamps are not signs, and the largest sign comes first", function () {
  const px = image();
  paint(px, 20, 20, 10, 10, [255, 0, 0]); // traffic light
  paint(px, 60, 100, 40, 8, [40, 255, 90]); // small green sign
  paint(px, 150, 60, 120, 14, [255, 140, 0]); // big amber sign
  const boxes = ledBoxes(px, W, H);
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].x, 150);
  assert.equal(boxes[1].x, 60);
});

test("nothing lit, nothing found", function () {
  assert.deepEqual(ledBoxes(image(), W, H), []);
});
