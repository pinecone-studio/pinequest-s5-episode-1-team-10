import assert from "node:assert/strict";
import test from "node:test";
import type { Box } from "./box.ts";
import { addVote, updateTracks } from "./tracker.ts";

function bus(x: number, score: number): Box {
  return { x: x, y: 0, w: 200, h: 80, score: score };
}

test("a weak detection does not start a track", function () {
  assert.equal(updateTracks([], [bus(0, 0.2)], 0).length, 0);
});

test("a strong detection starts a track and a weak one keeps it", function () {
  const started = updateTracks([], [bus(0, 0.8)], 0);
  assert.equal(started.length, 1);
  const kept = updateTracks(started, [bus(20, 0.2)], 40);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, started[0].id);
  assert.equal(kept[0].lastSeen, 40);
});

test("a hidden bus stays the same track and keeps moving", function () {
  let tracks = updateTracks([], [bus(0, 0.9)], 0);
  tracks = updateTracks(tracks, [bus(100, 0.9)], 100);
  addVote(tracks[0], "yes", 0.9, "55", 1);
  const id = tracks[0].id;
  tracks = updateTracks(tracks, [], 400);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].id, id);
  assert.equal(tracks[0].reads.length, 1);
  assert.ok(tracks[0].box.x > 100, "predicted x " + tracks[0].box.x);
  tracks = updateTracks(tracks, [], 2000);
  assert.equal(tracks.length, 0);
});

test("two yes reads lock the track against a later contradiction", function () {
  const tracks = updateTracks([], [bus(0, 0.9)], 0);
  addVote(tracks[0], "yes", 0.9, "55", 1);
  addVote(tracks[0], "yes", 0.9, "55", 2);
  assert.equal(tracks[0].decision, "yes");
  assert.equal(tracks[0].locked, true);
  addVote(tracks[0], "no", 0.95, "58", 3);
  assert.equal(tracks[0].decision, "yes");
  assert.equal(tracks[0].reads.length, 2);
});
