// Copies the onnxruntime-web runtime into public/ort so the browser loads it as-is (no bundling).
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";

const DIST = "node_modules/onnxruntime-web/dist/";
// The entry point picks its WASM runtime (asyncify/jsep/jspi) at load time, so ship them all.
const FILES = ["ort.webgpu.min.mjs"].concat(
  readdirSync(DIST).filter(function (item) {
    return item.startsWith("ort-wasm-simd-threaded");
  }),
);

mkdirSync("public/ort", { recursive: true });
FILES.forEach(function (item) {
  copyFileSync(DIST + item, "public/ort/" + item);
});
