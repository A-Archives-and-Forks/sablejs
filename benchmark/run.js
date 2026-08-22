"use strict";

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { compile } = require("../src/compiler");
const { capability } = require("../src/runtime");

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const optimization = argument("optimization", "O2");
const security = argument("security", "trusted");
const suite = argument("suite", "");
const preserveSourceLocations = process.argv.includes("--preserve-source-locations");
const leafFrames = argument("leaf-frames", "true") !== "false";
const inlineLeafFrames = argument("inline-leaf-frames", "true") !== "false";
const inlineSmallFunctions = argument("inline-small-functions", "true") !== "false";
const perScopeFactoryArgument = argument("per-scope-factories", "");
const perScopeFactories = perScopeFactoryArgument === ""
  ? undefined
  : perScopeFactoryArgument !== "false";
const runtimeModule = path.resolve(__dirname, "../src/runtime");
let source = fs.readFileSync(path.resolve(__dirname, "v8-suite.js"), "utf8");

if (suite) {
  const marker = "BenchmarkSuite.RunSuites({";
  const selection = `BenchmarkSuite.suites = BenchmarkSuite.suites.filter(function(candidate) { return candidate.name === ${JSON.stringify(suite)}; });\n  `;
  if (!source.includes(marker)) throw new Error("Unable to locate V8 benchmark entry point");
  source = source.replace(marker, selection + marker);
}

const startedAt = performance.now();
const compiled = compile(source, {
  optimization,
  security,
  runtimeModule,
  preserveSourceLocations,
  leafFrames,
  inlineLeafFrames,
  inlineSmallFunctions,
  perScopeFactories,
});
const compileMs = performance.now() - startedAt;
const generatedModule = { exports: {} };

new Function("require", "module", "exports", compiled.code)(
  require,
  generatedModule,
  generatedModule.exports
);

console.log(
  `[sablejs compile] ${compileMs.toFixed(1)} ms, code=${(Buffer.byteLength(compiled.code) / 1000).toFixed(1)} KB, ` +
  `fast=${compiled.stats.codegen.fastFrameScopes}, fallback=${compiled.stats.codegen.fallbackScopes}`
);

const print = security === "sandbox"
  ? capability((value) => console.log(String(value)), { name: "print" })
  : (value) => console.log(String(value));
const profileBoundary = process.argv.includes("--profile-boundary");
const instance = generatedModule.exports.createInstance({ globals: { print }, profileBoundary });
instance.run();
const boundaryStats = instance.boundaryStats();
if (boundaryStats) {
  console.log("[boundary profile] " + JSON.stringify(boundaryStats, null, 0));
}
instance.dispose();
