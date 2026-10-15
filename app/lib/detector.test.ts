import assert from "node:assert/strict";
import test from "node:test";
import { inputSize } from "./detector.ts";

function model(shape: (number | string)[]) {
  return { inputMetadata: [{ name: "images", isTensor: true as const, type: "float32" as const, shape }] };
}

test("the input size is the model's own, not an assumed one", function () {
  assert.equal(inputSize(model([1, 3, 640, 640])), 640);
  assert.equal(inputSize(model([1, 3, 320, 320])), 320);
});

test("a model without a fixed square size falls back to 640", function () {
  assert.equal(inputSize(model([1, 3, "height", "width"])), 640);
  assert.equal(inputSize(model([1, 3, 480, 640])), 640);
  assert.equal(inputSize({ inputMetadata: [] }), 640);
});
