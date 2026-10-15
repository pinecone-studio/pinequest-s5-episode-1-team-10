// Bundles the reader's worker (lib/reader/engine.worker.ts) into public/reader-worker.js, a plain script
// at a fixed address. The bundler's own worker (Next/Turbopack) passes its settings in the URL's #params=
// fragment; Safari on an iPhone lost it ("Missing worker bootstrap config") and the reader never loaded.
// A plain file has nothing to lose, and the offline helper (public/read-sw.js) can keep it by name.
import { build } from "esbuild";

await build({
  entryPoints: ["lib/reader/engine.worker.ts"],
  outfile: "public/reader-worker.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["safari15", "chrome100"],
  minify: true,
  external: ["/ort/*"], // onnxruntime is loaded at run time from public/ort (scripts/copy-ort.mjs)
  logLevel: "warning",
});
