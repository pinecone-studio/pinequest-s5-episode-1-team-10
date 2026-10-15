import assert from "node:assert/strict";
import test from "node:test";
import routes from "../../data/routes.json";
import expected from "../../test-fixtures/speech/routes.expected.json";
import { routeLabel, routeSpeech } from "./route.ts";

const GOLDEN: Record<string, string> = expected;

test("every route has a spoken form without digits or ':'", function () {
  assert.equal(routes.length, 125);
  routes.forEach(function (item) {
    const spoken = routeSpeech(item.key);
    assert.ok(spoken.length > 0, item.key);
    assert.doesNotMatch(spoken, /[0-9:]/, item.key);
  });
});

test("the plan's examples", function () {
  assert.equal(routeSpeech("Ч:29Б"), "Ч хорин ес Б");
  assert.equal(routeSpeech("Ч:57"), "Ч тавин долоо");
  assert.equal(routeSpeech("Ч:16А"), "Ч арван зургаа А");
  assert.equal(routeSpeech("Ч:81"), "Ч наян нэг");
  assert.equal(routeSpeech("Ч:10"), "Ч арав");
  assert.equal(routeSpeech("Ч:40"), "Ч дөч");
  assert.equal(routeSpeech("57"), "тавин долоо");
  assert.equal(routeSpeech("29Б"), "хорин ес Б");
  assert.equal(routeSpeech("Ч:22ӨВ"), "Ч хорин хоёр ӨВ");
  assert.equal(routeSpeech("ШҮ:1"), "ШҮ нэг");
});

test("all 125 routes sound different", function () {
  const spoken = routes.map(function (item) {
    return routeSpeech(item.key);
  });
  assert.equal(new Set(spoken).size, routes.length);
});

test("same as the golden file the server's route_words is checked against", function () {
  assert.equal(Object.keys(GOLDEN).length, routes.length);
  routes.forEach(function (item) {
    assert.equal(routeSpeech(item.key), GOLDEN[item.key], item.key);
  });
});

test("Hamuga forms: variant tags dropped, lowercase letters, stray spaces", function () {
  assert.equal(routeSpeech("Ч:29Б-Ма"), "Ч хорин ес Б");
  assert.equal(routeSpeech("Ч:29БМа"), "Ч хорин ес Б");
  assert.equal(routeSpeech("Ч:29Б-Z"), "Ч хорин ес Б");
  assert.equal(routeSpeech("Ч:16а"), "Ч арван зургаа А");
  assert.equal(routeSpeech("Ч:16а-Z"), "Ч арван зургаа А");
  assert.equal(routeSpeech("Ч:24б"), "Ч хорин дөрөв Б");
  assert.equal(routeSpeech("М:1БНА"), "М нэг Б");
  assert.equal(routeSpeech("М:5-КОП_copy"), "М тав");
  assert.equal(routeSpeech("Ч:20А_copy"), "Ч хорь А");
  assert.equal(routeSpeech("Ч:71МА"), "Ч далан нэг"); // "МА" is a variant tag, not the letter А
  assert.equal(routeSpeech("Ч:30-КОП"), "Ч гуч");
  assert.equal(routeSpeech("Х:18z"), "Х арван найм");
  assert.equal(routeSpeech("ч:29б"), "Ч хорин ес Б");
  assert.equal(routeSpeech("шү:1"), "ШҮ нэг");
  assert.equal(routeSpeech(" Ч:57 "), "Ч тавин долоо");
});

test("unknown prefixes left out, never spelled; nothing guessed", function () {
  assert.equal(routeSpeech("COP:1"), "нэг");
  assert.equal(routeSpeech(" НҮ:2_copy"), "хоёр");
  assert.equal(routeSpeech("МА:55"), "тавин тав");
  assert.equal(routeSpeech("M:7"), "долоо"); // Latin M: not the Cyrillic М prefix
  assert.equal(routeSpeech("Хүй7:1"), "нэг");
  assert.equal(routeSpeech("Ч-38"), "гучин найм");
  assert.equal(routeSpeech("Ч:16Ах"), "Ч арван зургаа"); // a letter followed by more than a tag: not said
  assert.equal(routeSpeech("test1000"), "");
  assert.equal(routeSpeech("Ч:"), "");
  assert.equal(routeSpeech(""), "");
});

test("display label unchanged", function () {
  assert.equal(routeLabel(" НҮ:2_copy"), "НҮ:2");
  assert.equal(routeLabel("Ч:29Б"), "Ч:29Б");
});
