"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");
const { compile } = require("../src/compiler");
const { capability } = require("../src/runtime");
const { getQuickJS } = require("quickjs-emscripten");

const SUITES = ["Richards", "Crypto", "RayTrace", "NavierStokes", "DeltaBlue"];
const repositoryRoot = path.resolve(__dirname, "..");
const runtimeModule = path.join(repositoryRoot, "src/runtime");
const source = fs.readFileSync(path.join(__dirname, "v8-suite.js"), "utf8");

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const samples = Number(argument("samples", "3"));
const warmup = Number(argument("warmup", "1"));
const backendArgument = argument("backend", "all");
const requestedBackends = backendArgument === "all"
  ? ["sablejs-sandbox", "sablejs-trusted", "quickjs"]
  : backendArgument.split(",").filter(Boolean);
const backends = [...new Set(requestedBackends.map((backend) =>
  backend === "sablejs" ? "sablejs-trusted" : backend
))];
if (!Number.isInteger(samples) || samples < 3) throw new Error("--samples must be an integer >= 3");
if (!Number.isInteger(warmup) || warmup < 0) throw new Error("--warmup must be a non-negative integer");
backends.forEach((backend) => {
  if (!["sablejs-sandbox", "sablejs-trusted", "quickjs"].includes(backend)) {
    throw new Error(`Unknown backend ${backend}`);
  }
});

function percentile(values, fraction) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(values) {
  const median = percentile(values, 0.5);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const absoluteDeviations = values.map((value) => Math.abs(value - median));
  return {
    median,
    p05: percentile(values, 0.05),
    p95: percentile(values, 0.95),
    min: Math.min(...values),
    max: Math.max(...values),
    relativeMadPct: median === 0 ? 0 : percentile(absoluteDeviations, 0.5) / median * 100,
    coefficientOfVariationPct: mean === 0 ? 0 : Math.sqrt(variance) / mean * 100,
    samples: values,
  };
}

function parseOutput(lines) {
  const scores = {};
  let total;
  for (const line of lines) {
    const suite = line.match(/^(Richards|Crypto|RayTrace|NavierStokes|DeltaBlue):\s*([0-9.]+)$/);
    if (suite) scores[suite[1]] = Number(suite[2]);
    const overall = line.match(/^Score \(version 7\):\s*([0-9.]+)$/);
    if (overall) total = Number(overall[1]);
  }
  assert.deepStrictEqual(Object.keys(scores).sort(), SUITES.slice().sort(), `Incomplete suite output: ${lines.join(" | ")}`);
  assert(Number.isFinite(total), `Missing overall score: ${lines.join(" | ")}`);
  return { ...scores, total };
}

function captureConsole(run) {
  const lines = [];
  run((value) => lines.push(String(value)));
  return parseOutput(lines);
}

function prepareCompiler(security) {
  const compiled = compile(source, { optimization: "O2", runtimeModule, security });
  const generatedModule = { exports: {} };
  new Function("require", "module", "exports", compiled.code)(
    require,
    generatedModule,
    generatedModule.exports
  );
  return { compiled, program: generatedModule.exports, security };
}

function runCompiler(prepared) {
  return captureConsole((emit) => {
    const print = prepared.security === "sandbox" ? capability(emit, { name: "print" }) : emit;
    const instance = prepared.program.createInstance({ globals: { print } });
    try {
      instance.run();
    } finally {
      instance.dispose();
    }
  });
}

async function runQuickJS(QuickJS) {
  const lines = [];
  const context = QuickJS.newContext();
  const print = context.newFunction("print", (value) => {
    lines.push(String(context.dump(value)));
  });
  context.setProp(context.global, "print", print);
  print.dispose();
  try {
    const result = context.evalCode(source, "v8-suite.js");
    if (result.error) {
      const error = context.dump(result.error);
      result.error.dispose();
      throw new Error(`QuickJS benchmark failed: ${JSON.stringify(error)}`);
    }
    result.value.dispose();
    return parseOutput(lines);
  } finally {
    context.dispose();
  }
}

async function collect(name, prepare, execute) {
  const prepared = await prepare();
  for (let index = 0; index < warmup; index += 1) await execute(prepared);
  const rounds = [];
  for (let index = 0; index < samples; index += 1) {
    if (typeof global.gc === "function") global.gc();
    const startedAt = performance.now();
    const result = await execute(prepared);
    rounds.push({ ...result, elapsedMs: performance.now() - startedAt });
    console.error(`[release] ${name} ${index + 1}/${samples}: score=${result.total}`);
  }
  const metrics = {};
  for (const metric of [...SUITES, "total", "elapsedMs"]) {
    metrics[metric] = summarize(rounds.map((round) => round[metric]));
  }
  return { rounds, metrics };
}

async function main() {
  const result = {
    environment: {
      node: process.version,
      v8: process.versions.v8,
      platform: `${process.platform}/${process.arch}`,
      cpu: os.cpus()[0] ? os.cpus()[0].model : "unknown",
      quickjsEmscripten: require("quickjs-emscripten/package.json").version,
    },
    configuration: { samples, warmup, suites: SUITES },
    backends: {},
  };
  if (backends.includes("sablejs-sandbox")) {
    result.backends["sablejs-sandbox"] = await collect(
      "sablejs-sandbox",
      () => prepareCompiler("sandbox"),
      runCompiler
    );
  }
  if (backends.includes("sablejs-trusted")) {
    result.backends["sablejs-trusted"] = await collect(
      "sablejs-trusted",
      () => prepareCompiler("trusted"),
      runCompiler
    );
  }
  if (backends.includes("quickjs")) {
    const QuickJS = await getQuickJS();
    result.backends.quickjs = await collect("quickjs", () => QuickJS, runQuickJS);
  }
  const sandbox = result.backends["sablejs-sandbox"];
  const trusted = result.backends["sablejs-trusted"];
  if (sandbox && trusted) {
    // Sandbox tax = 1 - sandbox / trusted; the fraction of throughput the
    // boundary costs on each workload. Lower is better.
    result.sandboxTax = {};
    console.error("[release] sandbox tax (1 - sandbox/trusted):");
    for (const metric of [...SUITES, "total"]) {
      const tax = 1 - sandbox.metrics[metric].median / trusted.metrics[metric].median;
      result.sandboxTax[metric] = Number(tax.toFixed(4));
      console.error(`  ${metric}: ${(tax * 100).toFixed(1)}%`);
    }
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
