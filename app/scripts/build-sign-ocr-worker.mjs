// Bundles lib/signOcr.worker.ts into public/sign-ocr-worker.js, a plain script at a fixed address.
// Same reason as the other workers: Safari drops the bundler's worker URL settings.
import { build } from "esbuild";

await build({
  entryPoints: ["lib/signOcr.worker.ts"],
  outfile: "public/sign-ocr-worker.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["safari15", "chrome100"],
  minify: true,
  external: ["/ort/*"],
  logLevel: "warning",
});
