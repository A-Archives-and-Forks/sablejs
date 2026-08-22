"use strict";

// Produces the publishable single-file artifacts in dist/:
//   dist/runtime.js  — standalone runtime only (no compiler), for Worker/browser use
//   dist/compiler.js — full package bundle (compiler + runtime + worker helpers)
// Both are bundled with esbuild and can run in Node, browsers, and workers.

const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const repositoryRoot = path.resolve(__dirname, "..");
const outputDirectory = path.join(repositoryRoot, "dist");

const targets = [
  {
    name: "runtime",
    entryPoint: path.join(repositoryRoot, "src/runtime/index.js"),
    outputPath: path.join(outputDirectory, "runtime.js"),
  },
  {
    name: "compiler",
    entryPoint: path.join(repositoryRoot, "src/index.js"),
    outputPath: path.join(outputDirectory, "compiler.js"),
  },
];

fs.mkdirSync(outputDirectory, { recursive: true });

const report = [];
for (const { name, entryPoint, outputPath } of targets) {
  esbuild.buildSync({
    entryPoints: [entryPoint],
    outfile: outputPath,
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: ["es2020"],
    logLevel: "warning",
    // Node built-ins stay as runtime require() calls (the compiler's
    // dumpDir inspection mode needs them in Node); in a browser they only
    // throw if that debug option is actually used.
    external: ["fs", "path"],
  });
  report.push({ name, sizeKB: (fs.statSync(outputPath).size / 1000).toFixed(1) });
}

for (const { name, sizeKB } of report) {
  console.log(`Built dist/${name}.js (${sizeKB} KB)`);
}
