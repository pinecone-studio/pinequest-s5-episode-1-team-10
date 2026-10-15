// Runs lib/*.test.ts with node:test on any Node version: each test is bundled with esbuild first
// (the tests import siblings as "./x.ts"; Node itself only strips types from version 22.6).
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tests = readdirSync("lib").filter(function (item) {
  return item.endsWith(".test.ts");
});
const out = mkdtempSync(join(tmpdir(), "app-tests-"));
await build({
  entryPoints: tests.map(function (item) {
    return join("lib", item);
  }),
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "warning",
});
const built = tests.map(function (item) {
  return join(out, item.replace(/\.ts$/, ".mjs"));
});
const run = spawnSync(process.execPath, ["--test"].concat(built), { stdio: "inherit" });
process.exit(run.status ?? 1);
