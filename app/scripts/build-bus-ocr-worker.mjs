// Bundles lib/busOcr.worker.ts into public/bus-ocr-worker.js, a plain script at a fixed address.
// Same reason as the reader worker: Safari drops the bundler's worker URL settings.
import { build } from "esbuild";

await build({
  entryPoints: ["lib/busOcr.worker.ts"],
  outfile: "public/bus-ocr-worker.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["safari15", "chrome100"],
  minify: true,
  external: ["/ort/*"],
  logLevel: "warning",
});
