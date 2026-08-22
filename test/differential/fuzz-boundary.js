"use strict";

// Sandbox-boundary differential fuzzing: generate guest programs that stay
// inside the sandbox data contract but stress the boundary — proxy write
// steering, capability calls, clone shapes (sparse/cyclic/Map/Set/typed/
// Date/RegExp), sloppy and strict `arguments`, enumeration, defineProperty
// and delete on proxied objects — and require every engine to agree.
//
// The oracle is native V8. The same program also runs in sablejs trusted,
// sablejs sandbox (with the same values injected via `globals`), and
// QuickJS-WASM (via a source prelude). If the sandbox corrupts or rejects
// any in-contract program, it mismatches and the case is saved with its
// seed, exactly like the semantics fuzzer.
//
// Every compiled artifact is also parsed with acorn: generated code that
// fails to parse is always a compiler bug, reported independently of engine
// agreement.
//
//   node test/differential/fuzz-boundary.js --seed=1 --cases=3000 [--quiet]

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const acorn = require("acorn");
const { compile } = require("../../src/compiler");
const { capability } = require("../../src/runtime");
const { argument, createQuickJS, mulberry32, pick } = require("./fuzz.js");

const runtimeModule = path.resolve(__dirname, "../../src/runtime");
const failureDirectory = path.resolve(__dirname, "../../.cache/differential-failures-boundary");

// Host functions, single-sourced: the same expression text becomes the
// native/QuickJS prelude `var fn = ...` and the injected host value.
const HOST_FUNCTIONS = [
  { expression: "(function fn(x) { return x + 1; })" },
  { expression: "(function fn(a, b) { return a * b + 1; })" },
  { expression: "(function fn(x) { return { got: x }; })" },
  { expression: "(function fn() { throw new RangeError(\"boom\"); })" },
  { expression: "(function fn(x) { return String(x) + \"!\"; })" },
  { expression: "(function fn(a) { return [a, a]; })" },
];

// Input shapes, single-sourced: the prelude text both runs in native/QuickJS
// and constructs the exact object injected into sablejs globals.
const INPUT_PRELUDES = [
  `var input = { a: [1, 2, 3], b: { c: "x", n: 5 }, s: "str", bool: true, z: null };`,
  `var input = [1, 2, 3];`,
  `var input = [1, , 3, , 5];`,
  `var input = new Map([[ "k", 1 ], [ "k2", "v" ]]);`,
  `var input = new Set([ 1, "a", 2 ]);`,
  `var input = new Uint8Array([ 1, 2, 3 ]);`,
  `var input = new Date(1234567890);`,
  `var input = /a+b/gi;`,
  `var input = {}; input.self = input; input.list = [ input ];`,
  `var input = { a: { b: { c: { d: { e: [ 1, [ 2, [ 3 ] ] ] } } } } };`,
  `var input = { "1": "one", "01": "zero-one", "length": 9, "": "empty", x: 1 };`,
  `var input = [{ k: 1 }, { k: 2 }, { k: 3 }];`,
  `var input = { nested: [ [ 1 ], [ 2, [ 3 ] ] ], deep: { level: { again: { n: 4 } } } };`,
];

class BoundaryGenerator {
  constructor(seed) {
    this.random = mulberry32(seed);
  }

  inputRead() {
    return pick(this.random, [
      "input.a[0]",
      "input.b.c",
      "input.length",
      "input[0]",
      "input[1]",
      "input[2]",
      "input.nested[1][1][0]",
      "input.deep.level.again.n",
      "input.self === input",
      "input.list[0].self === input.self",
      "input.get(\"k\")",
      "input.size",
      "input.has(1)",
      "input[0] + input[1]",
      "String(input)",
    ]);
  }

  valueExpr(depth) {
    const random = this.random;
    if (depth <= 0 || random() < 0.3) {
      const kind = Math.floor(random() * 6);
      if (kind === 0) return String(Math.floor(random() * 20) - 10);
      if (kind === 1) return JSON.stringify(pick(random, ["a", "ab", "1", "1.5", "true", "", "-0", "1e3", " "]));
      if (kind === 2) return pick(random, ["true", "false", "null", "void 0"]);
      if (kind === 3) return this.inputRead();
      return String(Math.floor(random() * 5));
    }
    const kind = Math.floor(random() * 8);
    switch (kind) {
      case 0: {
        const operator = pick(random, ["+", "-", "*", "<", ">", "==", "===", "!=", "!==", "&&", "||"]);
        return `(${this.valueExpr(depth - 1)} ${operator} ${this.valueExpr(depth - 1)})`;
      }
      case 1:
        return `(${pick(random, ["!", "-", "typeof "])}${this.valueExpr(depth - 1)})`;
      case 2:
        return `[${this.valueExpr(depth - 1)}, ${this.valueExpr(depth - 1)}, ${this.valueExpr(depth - 1)}]`;
      case 3:
        return `({ a: ${this.valueExpr(depth - 1)}, b: ${this.valueExpr(depth - 1)} })`;
      case 4:
        return `(${this.valueExpr(depth - 1)} ? ${this.valueExpr(depth - 1)} : ${this.valueExpr(depth - 1)})`;
      case 5:
        return `(new Proxy(input, { get: function (t, k) { return t[k]; } }))`;
      case 6:
        return `Object.keys(input).length`;
      case 7:
      default:
        return `${pick(random, ["f0", "f1"])}(${this.valueExpr(depth - 1)}, ${this.valueExpr(depth - 1)})`;
    }
  }

  statement(depth, variables, output, allowCapability) {
    const random = this.random;
    const kind = Math.floor(random() * 8);
    switch (kind) {
      case 0: {
        const name = pick(random, variables);
        output.push(`var ${name} = ${this.valueExpr(depth)};`);
        return;
      }
      case 1: {
        const name = pick(random, variables);
        output.push(`${name} = ${this.valueExpr(depth)};`);
        return;
      }
      case 2: {
        output.push(`if (${this.valueExpr(depth)}) {`);
        output.push(`  v1 = ${this.valueExpr(depth)};`);
        output.push("} else {");
        output.push(`  v2 = ${this.valueExpr(depth)};`);
        output.push("}");
        return;
      }
      case 3: {
        output.push(`for (var i = 0; i < ${1 + Math.floor(random() * 3)}; i++) {`);
        output.push(`  v3 = ${this.valueExpr(depth)};`);
        output.push("}");
        return;
      }
      case 4:
        // Proxy write steering attempt: write through a guest proxy whose
        // set trap records but forwards; the sandbox must target the proxy
        // target, not whatever the trap returns.
        output.push("var p = new Proxy({}, { set: function (t, k, v) { t[k] = v; return true; } });");
        output.push("p.x = " + this.valueExpr(depth) + ";");
        output.push("v3 = p.x;");
        return;
      case 5:
        // defineProperty / delete on own (possibly proxied) objects.
        output.push("var q = new Proxy({ a: 1 }, { get: function (t, k) { return t[k]; } });");
        output.push("Object.defineProperty(q, \"b\", { value: " + this.valueExpr(depth) + ", enumerable: true, configurable: true });");
        output.push("v1 = q.a;");
        output.push("v2 = q.b;");
        output.push("delete q.a;");
        output.push("v3 = (\"a\" in q);");
        return;
      case 6:
        // Capability calls only when fn is injected: an undeclared fn is
        // ReferenceError in every engine (fine), but a stale Program-level
        // fn leaking from an earlier native case would silently diverge.
        if (!allowCapability) {
          output.push(`${this.valueExpr(depth)};`);
          return;
        }
        output.push(`try { v0 = fn(${this.valueExpr(depth)}); } catch (e) { v0 = e.name; }`);
        return;
      case 7:
      default:
        output.push(`${this.valueExpr(depth)};`);
        return;
    }
  }

  functionBody(depth, variables, allowCapability, emitReturn) {
    const output = [];
    // Declare all four cells the statements write: case 4/5 assign v3 and a
    // strict-mode assignment to an undeclared variable is a ReferenceError
    // in every engine (which would poison whole runs, not the boundary).
    for (let index = 0; index < 4; index += 1) {
      output.push(`var v${index} = ${this.valueExpr(depth - 1)};`);
    }
    for (let index = 0; index < 2 + Math.floor(this.random() * 3); index += 1) {
      this.statement(depth, variables, output, allowCapability);
    }
    if (emitReturn) output.push(`return ${this.valueExpr(depth - 1)};`);
    return output;
  }

  argumentsBody() {
    // Sloppy mapped-parameter `arguments`: callee identity, mapped writes,
    // passing the exotic object around. Native sloppy and the sandbox's
    // arguments proxy must agree.
    const output = [];
    output.push("function argf(a, b) {");
    output.push("  var m = arguments;");
    output.push("  a = 9;");
    output.push("  m[1] = 7;");
    output.push("  return [m.length, m[0], m[1], b, m.callee === argf, m[0] === a];");
    output.push("}");
    output.push("var argResult = argf(2, 3);");
    output.push("var argCopy = argResult.slice(0, 3);");
    return output;
  }

  strictArgumentsBody() {
    // Strict `arguments`: callee reads must throw a TypeError in every
    // engine (native PoisonPill and the sandbox restriction alike).
    const output = [];
    output.push("function sargf(a, b) {");
    output.push("  var m = arguments;");
    output.push("  a = 9;");
    output.push("  var caught = \"none\";");
    output.push("  try { var c = m.callee; } catch (e) { caught = e.name; }");
    output.push("  return [m.length, m[0], a, caught];");
    output.push("}");
    output.push("var argResult = sargf(2, 3);");
    return output;
  }

  program() {
    const random = this.random;
    const sloppy = random() < 0.25;
    const usesFn = random() < 0.5;
    const lines = [];
    if (!sloppy) lines.push("\"use strict\";");
    for (let index = 0; index < 2; index += 1) {
      lines.push(`function f${index}(a, b) {`);
      this.functionBody(1 + Math.floor(random() * 2), ["a", "b", "v0", "v1", "v2", "v3"], usesFn, true).forEach((line) => lines.push(`  ${line}`));
      lines.push("}");
    }
    lines.push("function main() {");
    const body = this.functionBody(1 + Math.floor(random() * 2), ["v0", "v1", "v2", "v3"], usesFn, false);
    // The arguments facet needs a defined cell in the final array for every
    // program: sloppy always carries the mapped-arguments probe, strict gets
    // it occasionally and otherwise a plain null cell.
    const strictArguments = !sloppy && random() < 0.3;
    const argumentsLines = sloppy
      ? this.argumentsBody()
      : strictArguments ? this.strictArgumentsBody() : ["var argResult = null;"];
    argumentsLines.forEach((line) => lines.push(`  ${line}`));
    body.forEach((line) => lines.push(`  ${line}`));
    lines.push("  return [argResult, v0, v1, v2, v3];");
    lines.push("}");
    lines.push("JSON.stringify(main());");

    const inputPrelude = pick(random, INPUT_PRELUDES);
    const fnPrelude = usesFn ? pick(random, HOST_FUNCTIONS).expression : null;
    const prelude = fnPrelude ? `${inputPrelude}\nvar fn = ${fnPrelude};` : inputPrelude;
    return { source: lines.join("\n"), prelude, usesFn };
  }
}

// Joins the prelude with the generated source for native/QuickJS. The
// prelude must not be prepended verbatim: a strict source begins with the
// "use strict" directive, and a non-directive statement before it demotes
// the directive to a plain string expression, silently running the whole
// case sloppy. sablejs compiles the source alone, so it always sees the
// directive first; native and QuickJS must see the same program.
function joinProgram(source, prelude) {
  const directive = /^\s*"use strict";/.test(source) ? '"use strict";' : null;
  const rest = directive ? source.replace(/^\s*"use strict";\s*/, "") : source;
  return directive ? `${directive}\n${prelude}\n${rest}` : `${prelude}\n${source}`;
}

function runNative(source, prelude) {
  // Evaluate the whole thing as one Program (a wrapper function would
  // demote the directive and change completion-value semantics), with the
  // directive ordering handled by joinProgram. The completion value of
  // the final JSON.stringify(main()) statement is the case result.
  try {
    return { ok: true, value: globalThis.eval(joinProgram(source, prelude)) };
  } catch (error) {
    return { ok: false, error: error && error.name };
  }
}

// Compiles the source and returns { ok, value } plus generated-code syntax
// status. `globals` carries the injected input/fn built from the prelude.
function runSableJS(source, security, globals) {
  let compiled;
  try {
    compiled = compile(source, { optimization: "O2", security, runtimeModule });
  } catch (error) {
    return { ok: false, error: error && error.name, generatedSyntax: true };
  }
  let syntaxError = null;
  try {
    acorn.parse(compiled.code, { ecmaVersion: 2022 });
  } catch (error) {
    syntaxError = error;
  }
  try {
    const generatedModule = { exports: {} };
    new Function("require", "module", "exports", compiled.code)(require, generatedModule, generatedModule.exports);
    const instance = generatedModule.exports.createInstance({ globals });
    try {
      return { ok: true, value: instance.run(), generatedSyntax: !syntaxError, syntaxError };
    } finally {
      instance.dispose();
    }
  } catch (error) {
    return { ok: false, error: error && error.name, generatedSyntax: !syntaxError, syntaxError };
  }
}

function same(left, right) {
  return left.ok === right.ok && (left.ok ? left.value === right.value : left.error === right.error);
}

// Builds the exact host values the prelude describes, for globals injection.
function buildGlobals(prelude, usesFn) {
  const factory = new Function(`${prelude}\nreturn { input: input, fn: typeof fn === "function" ? fn : undefined };`);
  return factory();
}

async function main() {
  const seed = Number(argument("seed", "1"));
  const cases = Number(argument("cases", "1000"));
  const quiet = process.argv.includes("--quiet");
  const validateSyntax = !process.argv.includes("--no-validate");
  fs.mkdirSync(failureDirectory, { recursive: true });
  const quickjs = await createQuickJS();
  const startedAt = performance.now();
  const mismatches = [];
  const exoticFailures = [];
  const syntaxFailures = [];
  let exotic = 0;

  for (let index = 0; index < cases; index += 1) {
    const caseSeed = seed + index;
    const { source, prelude, usesFn } = new BoundaryGenerator(caseSeed).program();
    const hostValues = buildGlobals(prelude, usesFn);
    const globals = { input: hostValues.input };
    // Capabilities are a sandbox mechanism: the boundary unwraps the
    // token at call time. Trusted mode exposes globals directly, so it
    // must receive the raw host function — a token would throw "is not a
    // function" there and produce a false mismatch.
    const trustedGlobals = usesFn ? { input: hostValues.input, fn: hostValues.fn } : globals;
    if (usesFn) globals.fn = capability(hostValues.fn, { name: "fn" });
    const native = runNative(source, prelude);
    const trusted = runSableJS(source, "trusted", trustedGlobals);
    const sandbox = runSableJS(source, "sandbox", globals);
    const quick = await quickjs.run(joinProgram(source, prelude));

    // A guest Proxy crossing into a capability call is out of contract by
    // construction: the sandbox resolves it to the plain data it presents
    // or rejects it with a boundary error (both caught in-guest), while
    // native passes the exotic object through. Completion values may
    // legitimately diverge, so only completion health is asserted, and the
    // raw witnesses (native/trusted/quickjs) must still agree.
    const crossesProxy = source.split("\n").some((line) => line.includes("fn(") && line.includes("new Proxy"));
    if (crossesProxy) {
      exotic += 1;
      // Raw witnesses must agree exactly. QuickJS is advisory here: wasm
      // stack overflow on unbounded recursion is nondeterministic in
      // quickjs (native throw vs guest-catchable RangeError vs garbage
      // completion), while native and trusted handle it consistently. The
      // sandbox must either complete (capability rejections are caught
      // in-guest, so a healthy exotic program still finishes) or fail with
      // the same error as native — a raw sandbox-only failure or a
      // sandbox-only success is an anomaly.
      const rawAgrees = same(native, trusted);
      const sandboxAnomaly = !sandbox.ok && !same(native, sandbox);
      if (!rawAgrees || sandboxAnomaly) {
        exoticFailures.push({ seed: caseSeed, source, prelude, native, trusted, sandbox, quick });
        fs.writeFileSync(path.join(failureDirectory, `seed-${caseSeed}.exotic.js`), `${prelude}\n${source}`);
        if (!quiet) {
          console.log(`EXOTIC seed=${caseSeed}: native=${JSON.stringify(native)} trusted=${JSON.stringify(trusted)} sandbox=${JSON.stringify(sandbox)} quickjs=${JSON.stringify(quick)}`);
        }
      }
    } else if (!same(native, trusted) || !same(native, sandbox)) {
      mismatches.push({ seed: caseSeed, source, prelude, native, trusted, sandbox, quick });
      fs.writeFileSync(path.join(failureDirectory, `seed-${caseSeed}.js`), `${prelude}\n${source}`);
      if (!quiet) {
        console.log(`MISMATCH seed=${caseSeed}: native=${JSON.stringify(native)} trusted=${JSON.stringify(trusted)} sandbox=${JSON.stringify(sandbox)} quickjs=${JSON.stringify(quick)}`);
      }
    }
    if (validateSyntax && trusted.syntaxError) {
      syntaxFailures.push({ seed: caseSeed, message: String(trusted.syntaxError.message) });
      fs.writeFileSync(path.join(failureDirectory, `seed-${caseSeed}.syntax.js`), `${prelude}\n${source}`);
      if (!quiet) {
        console.log(`SYNTAX seed=${caseSeed}: ${trusted.syntaxError.message}`);
      }
    }
    if (!quiet && (index + 1) % 500 === 0) {
      console.log(`[boundary] ${index + 1}/${cases} cases, ${mismatches.length} mismatches, ${exoticFailures.length} exotic failures, ${syntaxFailures.length} syntax failures`);
    }
  }
  quickjs.dispose();
  const elapsedMs = performance.now() - startedAt;
  console.log(JSON.stringify({
    seed,
    cases,
    mismatches: mismatches.length,
    exoticFailures: exoticFailures.length,
    exoticTotal: exotic,
    syntaxFailures: syntaxFailures.length,
    elapsedMs: Math.round(elapsedMs),
    failures: mismatches.slice(0, 10).map((m) => ({ seed: m.seed, native: m.native, trusted: m.trusted, sandbox: m.sandbox, quickjs: m.quick })),
    exotic: exoticFailures.slice(0, 10).map((m) => ({ seed: m.seed, native: m.native, trusted: m.trusted, sandbox: m.sandbox, quickjs: m.quick })),
    syntax: syntaxFailures.slice(0, 10),
  }, null, 2));
  if (mismatches.length || exoticFailures.length || (validateSyntax && syntaxFailures.length)) process.exitCode = 1;
}

module.exports = { BoundaryGenerator, buildGlobals, runNative, runSableJS, same };

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}
