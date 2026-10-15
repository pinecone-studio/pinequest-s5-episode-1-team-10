// Renders the reader's fixed sentences (shared/phrases.json: read_*, menu_read) to small audio files
// in public/reader-clips/ with the reader's own voice model, so they play at once, with no model loaded:
// the aiming directions ("Ойртуулаарай", "Зүүн тийш") must reach a blind rider before the 35 MB voice
// has downloaded, and must not need its ~300 MB of memory (iPhones close tabs that use too much).
//
//   node scripts/render-reader-clips.mjs          # renders what's missing or changed
//
// Names are the sentence's hash, so a changed sentence is a new file. Replace a file by an OronTTS clip
// of the same name when those are made (server/make_speech.py): nothing else changes.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const APP = resolve(import.meta.dirname, "..");
const OUT = join(APP, "public/reader-clips");
const work = mkdtempSync(join(tmpdir(), "reader-clips-"));

await build({
  entryPoints: [join(APP, "lib/reader/voiceModel.ts")],
  outfile: join(work, "voice.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "warning",
});
const { VoiceModel } = await import(pathToFileURL(join(work, "voice.mjs")).href);
const ort = await import(pathToFileURL(join(APP, "node_modules/onnxruntime-web/dist/ort.wasm.min.mjs")).href);
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "error";

const phrases = JSON.parse(readFileSync(join(APP, "../shared/phrases.json"), "utf8"));
const texts = Object.keys(phrases)
  .filter(function (key) {
    return key.startsWith("read_") || key === "menu_read";
  })
  .map(function (key) {
    return phrases[key];
  });

mkdirSync(OUT, { recursive: true });
const indexFile = join(OUT, "index.json");
const index = {};
const todo = [];
texts.forEach(function (text) {
  const name = createHash("sha1").update(text).digest("hex").slice(0, 16);
  index[text] = name;
  if (!existsSync(join(OUT, name + ".m4a"))) {
    todo.push(text);
  }
});

if (todo.length) {
  const graph = new Uint8Array(readFileSync(join(APP, "public/models/reader/voice_mn.onnx")));
  const pack = new Uint8Array(readFileSync(join(APP, "public/models/reader/voice_mn.pack")));
  const model = await VoiceModel.load(
    ort,
    graph,
    pack,
    function (_priority, job) {
      return job();
    },
    false,
    function () {},
  );
  let n = 0;
  for (const text of todo) {
    const samples = await model.say(text);
    if (!samples) {
      throw new Error("no audio for: " + text);
    }
    const wav = join(work, "clip.wav");
    const data = Buffer.alloc(44 + samples.length * 2);
    data.write("RIFF", 0);
    data.writeUInt32LE(36 + samples.length * 2, 4);
    data.write("WAVEfmt ", 8);
    data.writeUInt32LE(16, 16);
    data.writeUInt16LE(1, 20);
    data.writeUInt16LE(1, 22);
    data.writeUInt32LE(16000, 24);
    data.writeUInt32LE(32000, 28);
    data.writeUInt16LE(2, 32);
    data.writeUInt16LE(16, 34);
    data.write("data", 36);
    data.writeUInt32LE(samples.length * 2, 40);
    for (let i = 0; i < samples.length; i++) {
      data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
    }
    writeFileSync(wav, data);
    // AAC in m4a: plays on iPhone and Android, ~10x smaller than the wav
    execFileSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", "48000", "-c", "1", wav, join(OUT, index[text] + ".m4a")]);
    n++;
    console.log("[" + n + "/" + todo.length + "] " + (samples.length / 16000).toFixed(1) + " s  " + text.slice(0, 60));
  }
}
writeFileSync(indexFile, JSON.stringify(index, null, 1) + "\n");
console.log(texts.length + " sentences in " + OUT);
