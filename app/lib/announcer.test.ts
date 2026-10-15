import assert from "node:assert/strict";
import test from "node:test";
import { createAnnouncer } from "./announcer.ts";

test("a route is said at once, then not again for 8 s", function () {
  const said: string[][] = [];
  const announcer = createAnnouncer(function (texts) {
    said.push(texts);
    return Promise.resolve();
  });
  assert.equal(announcer.announce("55", ["55-р автобус ирлээ."], 0), true);
  assert.equal(announcer.announce("55", ["55-р автобус ирлээ."], 7999), false);
  assert.equal(announcer.announce("58", ["Энэ таны автобус биш."], 7999), true); // its own cooldown
  assert.equal(announcer.announce("55", ["55-р автобус ирлээ."], 8000), true);
  assert.deepEqual(said, [["55-р автобус ирлээ."], ["Энэ таны автобус биш."], ["55-р автобус ирлээ."]]);
});
