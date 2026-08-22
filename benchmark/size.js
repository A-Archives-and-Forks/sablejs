"use strict";

// Compiled-size measurement and bundle-size regression threshold.
//
// Measures the raw CJS output and the minified browser IIFE (compiled module +
// runtime bundled with esbuild — the deployable artifact) for every
// optimization level x security mode, plus the per-scope vs shared factory
// strategies the compiler's size optimizer chooses between at O2/Os.
//
// Byte counts are deterministic (same inputs + pinned tool versions, any
// machine), so `--check` can gate CI on the recorded baselines:
//
//   npm run benchmark:size             # print the full measurement
//   npm run benchmark:size -- --check  # fail if any artifact exceeds budget

const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");
const { compile } = require("../src/compiler");

const LEVELS = ["O0", "O1", "O2", "Os"];
const SECURITIES = ["sandbox", "trusted"];
const runtimeModule = path.resolve(__dirname, "../src/runtime");
const source = fs.readFileSync(path.resolve(__dirname, "v8-suite.js"), "utf8");

// Recorded 2026-08-22 (Node 24.x, esbuild 0.28.2). Regenerate with
// `node benchmark/size.js` and paste when a deliberate size change lands.
const BASELINES = {
  sandbox: {
    O0: { minifiedIIFE: 603880 },
    O1: { minifiedIIFE: 596882 },
    O2: { minifiedIIFE: 607653 },
    Os: { minifiedIIFE: 369530 },
  },
  trusted: {
    O0: { minifiedIIFE: 603880 },
    O1: { minifiedIIFE: 596882 },
    O2: { minifiedIIFE: 513222 },
    Os: { minifiedIIFE: 345456 },
  },
};
const TOLERANCE = 1.05;

function buildMinifiedIIFE(code, workdir) {
  const generatedPath = path.join(workdir, "generated.cjs");
  const entryPath = path.join(workdir, "entry.cjs");
  const outputPath = path.join(workdir, "program.js");
  fs.writeFileSync(generatedPath, code);
  fs.writeFileSync(entryPath, `"use strict";\nconst program = require(${JSON.stringify(generatedPath)});\nmodule.exports = program;\n`);
  esbuild.buildSync({
    entryPoints: [entryPath],
    outfile: outputPath,
    bundle: true,
    minify: true,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    logLevel: "warning",
  });
  return fs.statSync(outputPath).size;
}

function measure() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "sablejs-size-"));
  const results = {};
  for (const security of SECURITIES) {
    results[security] = {};
    for (const level of LEVELS) {
      const chosen = compile(source, { optimization: level, security, runtimeModule });
      const entry = {
        rawBytes: Buffer.byteLength(chosen.code),
        minifiedIIFE: buildMinifiedIIFE(chosen.code, workdir),
      };
      if (level === "O2" || level === "Os") {
        entry.strategies = {};
        for (const perScopeFactories of [true, false]) {
          const candidate = compile(source, {
            optimization: level,
            security,
            runtimeModule,
            perScopeFactories,
          });
          entry.strategies[perScopeFactories ? "per-scope" : "shared"] =
            Buffer.byteLength(candidate.code);
        }
      }
      results[security][level] = entry;
    }
  }
  fs.rmSync(workdir, { recursive: true, force: true });
  return results;
}

function check(results) {
  let failed = false;
  for (const security of SECURITIES) {
    for (const level of LEVELS) {
      const actual = results[security][level].minifiedIIFE;
      const baseline = BASELINES[security][level].minifiedIIFE;
      const budget = Math.round(baseline * TOLERANCE);
      const ok = actual <= budget;
      if (!ok) failed = true;
      console.log(
        `${ok ? "ok" : "FAIL"}  ${security.padEnd(7)} ${level}  min IIFE ` +
        `${(actual / 1024).toFixed(1)} KB (baseline ${(baseline / 1024).toFixed(1)} KB, ` +
        `budget ${(budget / 1024).toFixed(1)} KB)`
      );
    }
  }
  return failed;
}

const results = measure();
if (process.argv.includes("--check")) {
  if (check(results)) {
    console.error("[size] bundle-size budget exceeded — update benchmark/size.js BASELINES only on a deliberate size change");
    process.exit(1);
  }
  console.log("[size] bundle-size budget OK");
} else {
  console.log(JSON.stringify(results, null, 2));
  console.error("[size] paste the values above into benchmark/size.js BASELINES after a deliberate size change");
}
