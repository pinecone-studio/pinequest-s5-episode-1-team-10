// Copies the onnxruntime-web runtime into public/ort so the browser loads it as-is (no bundling).
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const DIST = "node_modules/onnxruntime-web/dist/";
// The entry point picks its WASM runtime (asyncify/jsep/jspi) at load time, so ship them all.
const FILES = ["ort.webgpu.min.mjs"].concat(
  readdirSync(DIST).filter(function (item) {
    return item.startsWith("ort-wasm-simd-threaded");
  }),
);

// The runtime reserves its memory for up to 4 GB up front. Older iPhones (measured: iPhone X, iOS 16)
// refuse that with "RangeError: Out of memory", even for an 8 MB model. Patched: ask for 4 GB, then
// 1 GB, 512 MB, 256 MB, keeping the first the phone allows (the reader needs ~240 MB per runtime).
// `globalThis.ortMaxPages` (64 KB pages) is where to start; lib/reader/engine.worker.ts sets it on
// iPhones, so the two reader runtimes don't each reserve as much as they can.
const MEMORY = "new WebAssembly.Memory({initial:256,maximum:65536,shared:!0})";
const FITTING =
  "(function(){var s=globalThis.ortMaxPages||65536;for(var m of [65536,16384,8192,4096]){if(m>s)continue;" +
  "try{return new WebAssembly.Memory({initial:256,maximum:m,shared:!0})}catch(e){if(m===4096)throw e}}})()";

mkdirSync("public/ort", { recursive: true });
FILES.forEach(function (item) {
  if (!item.endsWith(".mjs") || item === "ort.webgpu.min.mjs") {
    copyFileSync(DIST + item, "public/ort/" + item);
    return;
  }
  const code = readFileSync(DIST + item, "utf8");
  if (code.split(MEMORY).length !== 2) {
    throw new Error(item + ": the runtime's memory line changed (new onnxruntime-web?): update scripts/copy-ort.mjs");
  }
  writeFileSync("public/ort/" + item, code.replace(MEMORY, FITTING));
});
