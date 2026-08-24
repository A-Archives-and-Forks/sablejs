"use strict";

// Real-world workload benchmark. Each workload is a self-contained ES5.1
// source defining `workload(input)`; the driver embeds a deterministic input
// literal, runs the workload repeatedly, and reports ops/sec. Backends:
// sablejs-sandbox, sablejs-trusted, quickjs, and native (plain new Function —
// the performance ceiling, NOT a security alternative). Results are compared
// across backends so a divergent backend fails the run.

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { compile } = require("../src/compiler");
const { createQuickJSRunner } = require("./quickjs-runner");

const workloadDirectory = path.resolve(__dirname, "workloads");
const runtimeModule = path.resolve(__dirname, "../src/runtime");

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const INPUTS = {
  "json-transform": {
    rows: (() => {
      const rows = [];
      for (let i = 0; i < 500; i += 1) {
        rows.push({
          id: i,
          amount: 10 + (i % 50),
          discount: (i % 10) / 100,
          customer: { name: "customer-" + i, region: ["east", "west", "north", "south"][i % 4] },
          tags: i % 3 ? ["retail", "b2b", "trial"] : null,
        });
      }
      return rows;
    })(),
  },
  "pricing-rules": {
    rules: [
      { category: "electronics", percent: 5 },
      { category: "clothing", flat: 2 },
      { category: "grocery", percent: 10 },
      { minBase: 100, percent: 8 },
      { maxBase: 20, flat: 1 },
      { percent: 3 },
    ],
    items: (() => {
      const items = [];
      for (let i = 0; i < 2000; i += 1) {
        items.push({ base: 1 + (i % 200), category: ["electronics", "clothing", "grocery", "other"][i % 4], qty: 1 + (i % 5) });
      }
      return items;
    })(),
  },
  "form-validator": {
    form: { email: "user@example.com", username: "sablejs-user", age: 30, password: "s3cret-password", confirm: "s3cret-password" },
    phones: ["13800138000", "123456", "13911112222", "999"],
  },
  "spreadsheet-formulas": {
    names: (() => {
      const names = [];
      for (let i = 0; i < 50; i += 1) names.push("cell" + i);
      return names;
    })(),
    values: (() => {
      const values = [];
      for (let i = 0; i < 50; i += 1) values.push(i + 1);
      return values;
    })(),
    formulas: (() => {
      const formulas = [];
      for (let i = 2; i < 50; i += 1) {
        formulas.push({ a: "cell" + (i - 2), b: "cell" + (i - 1), op: ["add", "mul", "sub"][i % 3], target: "cell" + i });
      }
      return formulas;
    })(),
  },
  "workflow-rules": {
    record: { status: "pending", amount: 250, region: "east", note: "priority-order" },
    rules: (() => {
      const rules = [];
      for (let i = 0; i < 30; i += 1) {
        rules.push({
          conditions: [{ field: "amount", op: "gt", value: i * 10 }, { field: "status", op: "eq", value: i % 2 ? "pending" : "open" }],
          actions: i % 3 ? [{ tag: "rule-" + i }] : [{ set: "status", to: "escalated-" + i }],
        });
      }
      return rules;
    })(),
  },
  "template-logic": {
    template: "Hello {name}, you have {each orders}{item} {end}. {if vip}VIP discount applied.{end} Total: {total}",
    data: { name: "sablejs", vip: true, total: 42, orders: ["first", "second", "third"] },
  },
  "data-aggregation": {
    from: 1000,
    to: 9000,
    events: (() => {
      const events = [];
      for (let i = 0; i < 5000; i += 1) {
        events.push({ at: i * 2, kind: ["click", "view", "purchase", "signup"][i % 4], value: i % 97 });
      }
      return events;
    })(),
  },
  "mini-parser": {
    expression: "((12 + 34) * (56 - 7) + 8) * 2 - 100 + (3 * (4 + 5))",
  },
};

function assembleProgram(source, input) {
  return `var input = ${JSON.stringify(input)};\n${source}\nworkload(input);`;
}

function normalize(value) {
  return JSON.stringify(value);
}

function runSableJS(security, programSource, inlineHostIntrinsics = true) {
  const compiled = compile(programSource, { optimization: "O2", security, runtimeModule, inlineHostIntrinsics });
  const generatedModule = { exports: {} };
  new Function("require", "module", "exports", compiled.code)(require, generatedModule, generatedModule.exports);
  const instance = generatedModule.exports.createInstance({});
  const value = instance.run();
  instance.dispose();
  return value;
}

async function main() {
  const backend = argument("backend", "sablejs-sandbox");
  const iterations = Number(argument("iterations", "500"));
  const workloadFilter = argument("workload", "");
  const profileBoundary = process.argv.includes("--profile-boundary");
  const names = Object.keys(INPUTS).filter((name) => !workloadFilter || name === workloadFilter);
  const security = backend === "sablejs-sandbox" ? "sandbox" : "trusted";
  const nativeResults = {};

  for (const name of names) {
    const source = fs.readFileSync(path.join(workloadDirectory, `${name}.js`), "utf8");
    const programSource = assembleProgram(source, INPUTS[name]);

    let execute;
    let verify = null;
    let boundaryTotals = null;
    if (backend === "quickjs") {
      const runner = await createQuickJSRunner(() => {});
      execute = () => runner.evaluate(programSource, `${name}.js`);
    } else if (backend === "native") {
      // The Function constructor never returns the body's completion value
      // (it is not eval), so timing runs a pre-built function while
      // verification re-evaluates with indirect eval — which does return
      // the completion value, exactly like the differential fuzzer's
      // native oracle.
      execute = new Function(programSource);
      const nativeEvaluate = globalThis.eval;
      verify = () => nativeEvaluate(programSource);
    } else {
      const inlineHostIntrinsics = !process.argv.includes("--no-inline-host-intrinsics");
      const inlineMemberIntrinsics = !process.argv.includes("--no-inline-member-intrinsics");
      const deferBranchTest = !process.argv.includes("--no-branch-test-deferral");
      const compiled = compile(programSource, { optimization: "O2", security, runtimeModule, inlineHostIntrinsics, inlineMemberIntrinsics, deferBranchTest });
      const generatedModule = { exports: {} };
      new Function("require", "module", "exports", compiled.code)(require, generatedModule, generatedModule.exports);
      if (profileBoundary) {
        // run() is single-run, so accumulate the per-instance counters.
        boundaryTotals = {};
        execute = () => {
          const instance = generatedModule.exports.createInstance({ profileBoundary: true });
          try {
            const value = instance.run();
            const stats = instance.boundaryStats();
            for (const key of Object.keys(stats)) boundaryTotals[key] = (boundaryTotals[key] || 0) + stats[key];
            return value;
          } finally { instance.dispose(); }
        };
      } else {
        execute = () => {
          const instance = generatedModule.exports.createInstance({});
          try { return instance.run(); } finally { instance.dispose(); }
        };
      }
    }

    // Warmup plus timed iterations.
    execute();
    const startedAt = performance.now();
    for (let index = 0; index < iterations; index += 1) execute();
    const elapsedMs = performance.now() - startedAt;

    const reference = runSableJS("trusted", programSource);
    const result = verify ? verify() : execute();
    if (normalize(result) !== normalize(reference)) {
      console.error(`[workloads] ${name} diverged from the trusted reference`);
      process.exitCode = 1;
    }
    nativeResults[name] = result;

    console.log(`${name}: ${(iterations / (elapsedMs / 1000)).toFixed(0)} ops/sec (${iterations} iterations, ${elapsedMs.toFixed(1)} ms)`);
    if (boundaryTotals) {
      console.log(`  boundary ${name}: ${JSON.stringify(boundaryTotals)}`);
    }
  }
  console.log(`RESULT workloads ${backend}: ${names.length} workloads verified against trusted reference`);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
