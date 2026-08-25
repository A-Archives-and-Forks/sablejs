// Build the Deno example: compile the guest at build time and bundle the
// artifact + runtime as an ESM module with no Node dependencies.
//
//   node examples/deno/build.mjs
//   deno run examples/deno/main.ts

import { buildSync } from "esbuild";
import { compile } from "sablejs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const outDir = join(here, "dist");
const source = readFileSync(join(here, "..", "precompile", "guest.js"), "utf8");

const result = compile(source, {
  optimization: "O2",
  security: "sandbox",
  runtimeModule: join(root, "src", "runtime"),
});

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "artifact.cjs"), result.code);
// CJS entry — esbuild converts it to an ESM export in the bundle. Each call
// creates a fresh sandbox instance.
writeFileSync(
  join(outDir, "entry.cjs"),
  `
"use strict";
const program = require("./artifact.cjs");
exports.run = function run(input) {
  const instance = program.createInstance({ globals: { input } });
  try {
    return instance.run();
  } finally {
    instance.dispose();
  }
};
`
);

buildSync({
  entryPoints: [join(outDir, "entry.cjs")],
  outfile: join(outDir, "program.mjs"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  logLevel: "warning",
});

console.log("built deno/dist/program.mjs");
console.log("run: deno run examples/deno/main.ts");
