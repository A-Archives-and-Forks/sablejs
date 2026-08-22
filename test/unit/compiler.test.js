"use strict";

const assert = require("assert");
const path = require("path");
const { describe, it } = require("node:test");
const { compile: compileProgram, lowerToHIR, lowerToMIR } = require("../../src/compiler");
const OpSpec = require("../../src/ir/op-spec");
const { buildCFG, verifyCFG } = require("../../src/ir/cfg");
const { ABI_VERSION, createProgram } = require("../../src/runtime");
const {
  LOWERING_COVERAGE,
  STATIC_CONTROL_OPS,
  generate,
  validateLoweringCoverage,
} = require("../../src/codegen");

const runtimeModule = path.resolve(__dirname, "../../src/runtime");

function compile(source, options = {}) {
  return compileProgram(source, { security: "trusted", ...options });
}

function load(source, options = {}) {
  const result = compile(source, { runtimeModule, ...options });
  const generatedModule = { exports: {} };
  // This evaluates already-generated test output. Generated modules and the
  // runtime itself do not contain dynamic compilation.
  new Function("require", "module", "exports", result.code)(require, generatedModule, generatedModule.exports);
  return { result, program: generatedModule.exports };
}

function run(source, globals, options) {
  const loaded = load(source, options);
  const instance = loaded.program.createInstance({ globals });
  return { ...loaded, instance, value: instance.run() };
}

describe("sablejs OpSpec and AOT backend", function() {
  it("describes every frontend opcode", function() {
    assert.equal(OpSpec.count, 90);
    OpSpec.byCode.forEach((spec, code) => {
      assert.equal(spec.code, code);
      assert(spec.name);
      assert(spec.stack !== undefined);
      assert(spec.effect);
    });
  });

  it("has an exhaustive opcode-to-direct-call or static-control lowering", function() {
    assert.deepStrictEqual(validateLoweringCoverage(), LOWERING_COVERAGE);
    assert.equal(LOWERING_COVERAGE.total, 90);
    assert.equal(LOWERING_COVERAGE.directHelpers, 82);
    assert.equal(LOWERING_COVERAGE.staticControl, 8);
    OpSpec.byCode.forEach((spec) => {
      assert(STATIC_CONTROL_OPS.has(spec.name) || spec.helper, `missing lowering for ${spec.name}`);
    });
  });

  it("rejects unstructured control flow instead of emitting an interpreter fallback", function() {
    const scope = {
      id: 0,
      name: "unsupported",
      script: true,
      strict: false,
      lightweight: false,
      usesArguments: false,
      parameterCount: 0,
      parameters: [],
      variables: [],
      dynamicFunctions: [],
      controlRegions: [],
      syntheticRanges: [],
      codeLength: 1,
      instructions: [{ op: "JUMP", offset: 0, end: 1, args: [1] }],
    };
    assert.throws(
      () => generate({ entry: 0, scopes: [scope] }),
      /interpreter\/trampoline fallback is forbidden/
    );
  });

  it("emits direct helper calls without an instruction dispatcher", function() {
    const { result, value } = run("1 + 2 * 3;", undefined, { optimization: "O0" });
    assert.equal(value, 7);
    assert(!/opcode/i.test(result.code));
    assert(!/\bpc\b/.test(result.code));
    assert(!/switch\s*\(/.test(result.code));
    assert(!/\$r\.(?:dispatch|executeOpcode|runOpcode)\b/.test(result.code));
    assert(result.code.includes("$r.pushLiteral"));
    assert(!result.code.includes("function $run"));
    assert.equal(result.stats.codegen.fallbackScopes, 0);
  });

  it("lowers O2 primitive expressions to JIT-friendly JavaScript locals", function() {
    const { result, value } = run("var x = 2; x = (x + 3) * 4; x;", undefined, { optimization: "O2" });
    assert.equal(value, 20);
    assert(!result.code.includes("const $s = $f.stack"));
    assert(result.code.includes("const $v"));
    assert(!result.code.includes("$r.add($f)"));
    assert(!result.code.includes("$r.multiply($f)"));
    assert(result.stats.codegen.stackToLocal.helpersAvoided > 0);
  });

  it("supports direct control-flow block calls", function() {
    const source = "var i = 0; while (i < 5) { i++; } if (i === 5) { i + 10; } else { 0; }";
    assert.equal(run(source).value, 15);
  });

  it("emits simple source loops as native loops without a backedge trampoline", function() {
    for (const source of [
      "var i = 0; while (i < 4) { i++; } i;",
      "var i = 0; do { i++; } while (i < 4); i;",
      "var i = 0; for (; i < 4; i++) {} i;",
      "var result = '', object = { a: 1, b: 2 }; for (var key in object) { result += key; } result;",
    ]) {
      const { result, value } = run(source, undefined, { optimization: "O0" });
      assert(value === 4 || value === "ab");
      assert(result.code.includes("while (true)"));
      assert(!result.code.includes("$backedge"));
      assert(!result.code.includes("function $jump"));
    }
  });

  it("emits simple source conditionals as native if/else without block functions", function() {
    for (const source of [
      "var value = 1; if (host) { value = 2; } value;",
      "var value; if (host) { value = 2; } else { value = 3; } value;",
    ]) {
      const truthy = run(source, { host: true }, { optimization: "O0" });
      const falsy = run(source, { host: false }, { optimization: "O0" });
      assert.equal(truthy.value, 2);
      assert.equal(falsy.value, source.includes("else") ? 3 : 1);
      assert(truthy.result.code.includes("if ($r.branch($f))"));
      assert(!truthy.result.code.includes("function $b"));
      assert(!truthy.result.code.includes("function $run"));
    }
  });

  it("emits nested and sequential reducible regions as structured host control flow", function() {
    const source = "var i = 0, sum = 0; while (i < 5) { if (i % 2) { sum += i; } i++; } " +
      "if (sum === 4) { for (var j = 0; j < 2; j++) { sum++; } } sum;";
    const { result, value } = run(source, undefined, { optimization: "O0" });
    assert.equal(value, 6);
    assert(result.code.match(/while \(true\)/g).length >= 2);
    assert(result.code.includes("if ($r.branch($f))"));
    assert(!result.code.includes("function $b"));
    assert(!result.code.includes("$backedge"));
  });

  it("lowers targeted break and continue with loop-specific continuation semantics", function() {
    const source = "var i = 0, sum = 0; outer: for (; i < 7; i++) { " +
      "if (i === 2) continue; if (i === 5) break outer; sum += i; } " +
      "var j = 0; do { j++; if (j < 3) continue; sum += j; } while (j < 4); sum + i * 100;";
    const { result, value } = run(source, undefined, { optimization: "O0" });
    assert.equal(value, 515);
    assert(result.code.includes("continue $loop"));
    assert(result.code.includes("break $loop"));
    assert(!result.code.includes("function $b"));
    assert(!result.code.includes("$backedge"));
  });

  it("keeps labelled-break completion values after O2 location stripping", function() {
    for (const loop of [
      "while (true) { i++; if (i === 3) break done; }",
      "do { i++; if (i === 3) break done; } while (true);",
    ]) {
      const source = `var i = 0; done: { ${loop} throw new Error('unreachable'); } i;`;
      const loaded = run(source, undefined, { optimization: "O2" });
      assert.equal(loaded.value, 3);
      assert.equal(loaded.result.stats.codegen.fallbackScopes, 0);
    }
  });

  it("creates callable native functions and closures", function() {
    const source = "function outer(x) { return function(y) { return x + y; }; } var add4 = outer(4); add4(5);";
    const { value, instance } = run(source);
    assert.equal(value, 9);
    assert.equal(typeof instance.global.outer, "function");
    assert.equal(instance.global.outer(10)(2), 12);
  });

  it("keeps compiled function coercion consistent with explicit toString", function() {
    const source = "({} + function(){return 1}) === " +
      "({}.toString() + function(){return 1}.toString());";
    const loaded = run(source, undefined, { optimization: "O2" });
    assert.equal(loaded.value, true);
  });

  it("uses the ES5.1 descriptor for compiled function length", function() {
    const { value } = run(`
      var fn = function(a, b) {};
      var descriptor = Object.getOwnPropertyDescriptor(fn, "length");
      [descriptor.value, descriptor.writable, descriptor.enumerable,
       descriptor.configurable, delete fn.length, fn.hasOwnProperty("length")];
    `, undefined, { optimization: "O2" });
    assert.deepStrictEqual(value, [2, false, false, false, false, true]);
  });

  it("preserves compiled method this and constructor behavior", function() {
    const source = "function Box(x) { this.x = x; } Box.prototype.read = function() { return this.x; }; var box = new Box(7); box.read();";
    const { value, instance } = run(source);
    assert.equal(value, 7);
    assert(instance.global.box instanceof instance.global.Box);
  });

  it("passes host objects through without wrappers and preserves identity", function() {
    const host = { count: 1 };
    const { value } = run("host.count = host.count + 1; host;", { host });
    assert.strictEqual(value, host);
    assert.equal(host.count, 2);
  });

  it("uses native objects, arrays, holes, properties, and constructors", function() {
    const source = "var value = { list: [1,,3] }; value.list[1] = new Date(0); value;";
    const { value, instance } = run(source);
    assert.strictEqual(value, instance.global.value);
    assert(Array.isArray(value.list));
    assert(value.list[1] instanceof Date);
    assert.equal(value.list[1].getTime(), 0);
  });

  it("exposes host ArrayBuffer, DataView, and TypedArray objects without wrappers", function() {
    const source = "var buffer = new ArrayBuffer(8);" +
      "var bytes = new Uint8Array(buffer);" +
      "var view = new DataView(buffer);" +
      "bytes[0] = 17; view.setUint16(1, 0x1234);" +
      "({ buffer: buffer, bytes: bytes, view: view, value: bytes[0] + view.getUint16(1) });";
    const loaded = run(source, undefined, { optimization: "O2" });
    assert(loaded.value.buffer instanceof ArrayBuffer);
    assert(loaded.value.bytes instanceof Uint8Array);
    assert(loaded.value.view instanceof DataView);
    assert.strictEqual(loaded.value.bytes.buffer, loaded.value.buffer);
    assert.equal(loaded.value.value, 17 + 0x1234);

    const buffer = new ArrayBuffer(4);
    const injected = run(
      "var bytes = new Uint8Array(buffer); bytes[2] = 99; bytes.buffer;",
      { buffer },
      { optimization: "O2" }
    );
    assert.strictEqual(injected.value, buffer);
    assert.equal(new Uint8Array(buffer)[2], 99);
  });

  it("uses native sloppy and strict property assignment semantics at O2", function() {
    const sloppySource = "var object = {}; Object.defineProperty(object, 'x', " +
      "{ value: 1, writable: false }); object.x = 2; object.x;";
    const sloppy = run(sloppySource, undefined, { optimization: "O2" });
    assert.equal(sloppy.value, 1);
    assert(sloppy.result.code.includes("$writeSloppy("));

    const strict = load(`"use strict"; ${sloppySource}`, { optimization: "O2" });
    assert(strict.result.code.includes("$writeStrict("));
    assert.throws(() => strict.program.createInstance().run(), TypeError);

    const rejected = new Proxy({}, { set() { return false; } });
    assert.equal(run("host.x = 1; 7;", { host: rejected }, { optimization: "O2" }).value, 7);
    assert.throws(
      () => run("'use strict'; host.x = 1;", { host: rejected }, { optimization: "O2" }),
      TypeError
    );
  });

  it("recognizes the complete ES5 directive prologue", function() {
    assert.equal(
      run("function f() { 'another directive'; 'use strict'; return this === undefined; } f.call(undefined);").value,
      true
    );
    assert.equal(
      run("function f() { 'another directive'\n'use strict'; return this === undefined; } f.call(undefined);").value,
      true
    );
    assert.equal(
      run("function f() { 'another directive'; 0; 'use strict'; return this === undefined; } f.call(undefined);").value,
      false
    );
  });

  it("allows an ES5 strict object literal getter/setter pair", function() {
    const source = "'use strict'; var stored = 0, object = { " +
      "get value() { return stored; }, set value(next) { stored = next; } }; " +
      "object.value = 7; object.value;";
    assert.equal(run(source).value, 7);
  });

  it("keeps O0 as an oracle for enabled optimization levels", function() {
    const source = "var x = 2; x = x * 4 + 1; x;";
    const o0 = run(source, undefined, { optimization: "O0" });
    for (const optimization of ["O1", "O2", "Os"]) {
      assert.deepStrictEqual(run(source, undefined, { optimization }).value, o0.value);
    }
    assert.equal(o0.result.stats.passes.length, 0);
  });

  it("builds CFG predecessors, dominators, and natural loop backedges", function() {
    const hir = lowerToHIR("var i = 0; while (i < 2) { i++; } i;");
    const cfg = buildCFG(hir.scopes[0]);
    assert.equal(verifyCFG(cfg), true);
    assert(cfg.blocks.length > 2);
    assert(cfg.loops.length > 0);
    const loop = cfg.loops[0];
    assert(cfg.dominators.get(loop.backedge).has(loop.header));
    assert(cfg.byStart.get(loop.header).predecessors.includes(loop.backedge));
    assert.equal(cfg.immediateDominators.get(cfg.entry), null);
  });

  it("preserves frontend structured-control regions through HIR lowering", function() {
    const hir = lowerToHIR(
      "if (host) { while (test()) { body(); } } else { for (var i = 0; i < 2; i++) { body(); } } " +
      "do { body(); } while (test()); for (var key in object) { body(); }"
    );
    const kinds = hir.scopes[0].controlRegions.map((region) => region.kind);
    assert.deepStrictEqual(kinds.slice().sort(), ["DoWhile", "For", "ForIn", "If", "While"]);
    hir.scopes[0].controlRegions.forEach((region) => {
      assert(Number.isInteger(region.start));
      assert(Number.isInteger(region.end));
      assert(region.end >= region.start);
    });
  });

  it("emits switch selection, fallthrough, and break as native switch control", function() {
    const source = "var result = ''; switch (host) { " +
      "case probe(1): result += 'a'; case probe(2): result += 'b'; break; " +
      "default: result = 'd'; } result + ':' + calls;";
    for (const [host, expected] of [[1, "ab:1"], [2, "b:2"], [3, "d:2"]]) {
      let calls = 0;
      const loaded = run(source, {
        host,
        get calls() { return calls; },
        probe(value) { calls += 1; return value; },
      }, { optimization: "O0" });
      assert.equal(loaded.value, expected);
      assert(loaded.result.code.includes("switch ($case"));
      assert(loaded.result.code.includes("$r.caseJump($f)"));
      assert(!loaded.result.code.includes("function $b"));
      assert(!loaded.result.code.includes("$backedge"));
    }
  });

  it("emits reducible try/catch regions directly without block continuations", function() {
    const marker = {};
    const source = "var result = 0; try { if (host) throw marker; result = 1; } " +
      "catch (error) { if (error === marker) result = 2; } result;";
    const thrown = run(source, { host: true, marker }, { optimization: "O0" });
    const normal = run(source, { host: false, marker }, { optimization: "O0" });
    assert.equal(thrown.value, 2);
    assert.equal(normal.value, 1);
    assert(thrown.result.code.includes("try {"));
    assert(thrown.result.code.includes("catch ($error"));
    assert(!thrown.result.code.includes("function $b"));
    assert(!thrown.result.code.includes("function $run"));
  });

  it("restores catch environments before outer finally after abrupt catch completion", function() {
    const source = "var error = 'outer', seen; try { " +
      "try { throw 1; } catch (error) { throw 2; } finally { seen = error; } " +
      "} catch (outerError) {} seen;";
    const loaded = run(source, undefined, { optimization: "O0" });
    assert.equal(loaded.value, "outer");
    assert(loaded.result.code.includes("$r.endCatch($f)"));
    assert.equal(loaded.result.stats.codegen.fallbackScopes, 0);
  });

  it("structures conditional and logical expression short-circuit control", function() {
    const source = "var calls = 0; function hit(value) { calls++; return value; } " +
      "var a = host ? hit('yes') : hit('no'); var b = host && hit('and'); " +
      "var c = host || hit('or'); a + ':' + b + ':' + c + ':' + calls;";
    const truthy = run(source, { host: true }, { optimization: "O0" });
    const falsy = run(source, { host: false }, { optimization: "O0" });
    assert.equal(truthy.value, "yes:and:true:2");
    assert.equal(falsy.value, "no:false:or:2");
    assert(!truthy.result.code.includes("function $b"));
    assert(!truthy.result.code.includes("function $run"));
    assert.equal(truthy.result.stats.codegen.fallbackScopes, 0);
    const nested = run(
      "var result = 0; if (a && b && c) { result = 1; } result;",
      { a: true, b: true, c: true },
      { optimization: "O0" }
    );
    assert.equal(nested.value, 1);
    assert.equal(nested.result.stats.codegen.fallbackScopes, 0);
    assert(!nested.result.code.includes("function $run"));
  });

  it("emits non-abrupt try/finally and try/catch/finally as host exception structure", function() {
    const first = run(
      "var result = ''; try { result += 't'; if (host) throw marker; } " +
      "finally { result += 'f'; } result;",
      { host: false, marker: {} },
      { optimization: "O0" }
    );
    const second = run(
      "var result = ''; try { throw marker; } catch (error) { if (error === marker) result += 'c'; } " +
      "finally { result += 'f'; } result;",
      { marker: {} },
      { optimization: "O0" }
    );
    assert.equal(first.value, "tf");
    assert.equal(second.value, "cf");
    for (const loaded of [first, second]) {
      assert(loaded.result.code.includes("finally {"));
      assert(!loaded.result.code.includes("function $b"));
      assert(!loaded.result.code.includes("function $run"));
    }
  });

  it("uses host finally exactly once across return, break, and continue", function() {
    const source = "var log = ''; function returned() { try { return 3; } finally { log += 'r'; } } " +
      "var i = 0; while (i < 4) { i++; try { if (i === 1) continue; if (i === 3) break; log += i; } " +
      "finally { log += 'f'; } } returned() + ':' + log;";
    const loaded = run(source, undefined, { optimization: "O0" });
    assert.equal(loaded.value, "3:f2ffr");
    assert(loaded.result.code.includes("finally {"));
    assert(!loaded.result.code.includes("function $b"));
    assert(!loaded.result.code.includes("function $run"));
    assert.equal(loaded.result.stats.codegen.fallbackScopes, 0);
  });

  it("keeps canonical finally bodies reachable across optimized continue edges", function() {
    const source = "var count = 0, finalized = 0; while (count < 2) { " +
      "try { throw 1; } catch (error) { count++; continue; } finally { finalized++; } " +
      "finalized = -100; } count + ':' + finalized;";
    const loaded = run(source, undefined, { optimization: "O1" });
    assert.equal(loaded.value, "2:2");
    assert.equal(loaded.result.stats.codegen.fallbackScopes, 0);
    assert.doesNotThrow(() => lowerToMIR(source));
  });

  it("lowers post-finally for-in cleanup through explicit completion records", function() {
    const source = "var object = { a: 1, b: 1 }, count = 0, finalizers = 0; " +
      "for (var key in object) { try { count++; continue; } finally { finalizers++; } } " +
      "count + ':' + finalizers;";
    const loaded = run(source, undefined, { optimization: "O1" });
    assert.equal(loaded.value, "2:2");
    assert(loaded.result.code.includes("$completionRegion"));
    assert(!loaded.result.code.includes("function $run"));
    assert.equal(loaded.result.stats.codegen.fallbackScopes, 0);
    assert.doesNotThrow(() => lowerToMIR(source));
  });

  it("structures labelled block exits and structured static eval scopes", function() {
    const source = "var value = 0; outer: { value = 1; if (host) break outer; value = 2; } " +
      "function run() { eval('var i = 0; while (i < 2) { i++; } value += i;'); } run(); value;";
    const loaded = run(source, { host: true }, { optimization: "O0" });
    assert.equal(loaded.value, 3);
    assert(loaded.result.code.includes("$label"));
    assert(loaded.result.code.includes("break $label"));
    assert(!loaded.result.code.includes("function $b"));
    assert(!loaded.result.code.includes("function $run"));
    assert.equal(loaded.result.stats.codegen.fallbackScopes, 0);
  });

  it("lowers operand-stack dataflow to SSA MIR with Phi and use-def chains", function() {
    const mir = lowerToMIR("var x = 1; if (host) { x = 2; } while (x < 4) { x++; } x;");
    assert.equal(mir.kind, "ProgramMIR");
    const entry = mir.scopes[0];
    assert(entry.blocks.length > 2);
    assert(entry.values.length > 0);
    assert(entry.values.some((value) => value.uses.length > 0));
    assert(entry.blocks.some((block) => block.phis.length > 0));
    assert(entry.loops.length > 0);
    assert(entry.blocks.every((block) => block.operations.every((operation) => operation.effect)));
  });

  it("models path-dependent iterator, switch, and exception stack states in MIR", function() {
    for (const source of [
      "for (var key in { a: 1, b: 2 }) { key; }",
      "switch (2) { case 1: 10; break; case 2: 20; break; default: 30; }",
      "try { throw marker; } catch (error) { error; }",
    ]) {
      const mir = lowerToMIR(source);
      assert.equal(mir.kind, "ProgramMIR");
      assert(mir.scopes[0].blocks.length > 1);
    }
  });

  it("removes unreachable basic blocks at optimized levels but preserves O0", function() {
    const source = "function f() { return 1; 123456789 + 987654321; } f();";
    const o0 = load(source, { optimization: "O0" });
    const o1 = load(source, { optimization: "O1" });
    assert.equal(o0.program.createInstance().run(), 1);
    assert.equal(o1.program.createInstance().run(), 1);
    assert(o0.result.code.includes("123456789"));
    assert(!o1.result.code.includes("123456789"));
    assert(o1.result.stats.unreachableBlocksRemoved > 0);
    assert(o1.result.stats.cfg.blocks > 0);
  });

  it("folds constant branches before CFG reachability cleanup", function() {
    const source = "if (1 === 2) { 246813579; } else { 7; }";
    const o0 = load(source, { optimization: "O0" });
    const o1 = load(source, { optimization: "O1" });
    assert.equal(o0.program.createInstance().run(), 7);
    assert.equal(o1.program.createInstance().run(), 7);
    assert(o0.result.code.includes("246813579"));
    assert(!o1.result.code.includes("246813579"));
    assert(o1.result.stats.constantsFolded > 0);
    assert(o1.result.stats.constantBranchesFolded > 0);
    assert(o1.result.stats.unreachableBlocksRemoved > 0);
  });

  it("uses SSA SCCP to fold constant switch edges across basic blocks", function() {
    const source = "switch (2) { case 1: 135792468; break; case 2: 7; break; default: 864297531; }";
    const o0 = load(source, { optimization: "O0" });
    const o1 = load(source, { optimization: "O1" });
    assert.equal(o0.program.createInstance().run(), 7);
    assert.equal(o1.program.createInstance().run(), 7);
    assert(o0.result.code.includes("135792468"));
    assert(!o1.result.code.includes("135792468"));
    assert(!o1.result.code.includes("864297531"));
    assert(o1.result.stats.sccp.constantsPropagated > 0);
    assert(o1.result.stats.sccp.branchesFolded > 0);
  });

  it("propagates constants through private lightweight locals", function() {
    const source = "function f() { var x = 7; var y = x; return y; } f();";
    const o0 = load(source, { optimization: "O0" });
    const o1 = load(source, { optimization: "O1" });
    assert.equal(o0.program.createInstance().run(), 7);
    assert.equal(o1.program.createInstance().run(), 7);
    const o0Loads = (o0.result.code.match(/\$r\.getLocal\(/g) || []).length;
    const o1Loads = (o1.result.code.match(/\$r\.getLocal\(/g) || []).length;
    assert(o1Loads < o0Loads);
    assert(o1.result.stats.copyPropagation.constantsPropagated >= 2);
  });

  it("uses a duplicate for adjacent common local loads at O2", function() {
    const source = "function f(x) { return x + x; } f(host);";
    const o0 = run(source, { host: 6 }, { optimization: "O0" });
    const o2 = run(source, { host: 6 }, { optimization: "O2" });
    assert.equal(o0.value, 12);
    assert.equal(o2.value, 12);
    assert(!o0.result.code.includes("$r.dup($f)"));
    assert(!o2.result.code.includes("$r.dup($f)"));
    assert(/const (\$v\d+_\d+) = \$l\[1\];[\s\S]*\1 \+ \1/.test(o2.result.code));
    assert.equal(o2.result.stats.localCSE.loadsEliminated, 1);
  });

  it("reuses dominating private-local loads across basic blocks", function() {
    const source = "function f(flag) { var stable = 7, first = stable; " +
      "if (flag) { first++; } return first + stable; } f(true) + f(false);";
    const o0 = run(source, undefined, { optimization: "O0" });
    const o2 = run(source, undefined, { optimization: "O2" });
    assert.equal(o0.value, 29);
    assert.equal(o2.value, o0.value);
    assert(o2.result.stats.globalValueNumbering.crossBlockLoadsEliminated > 0);
    assert(o2.result.code.includes("let $gv"));

    const killed = run(
      "function f(flag) { var stable = 7, first = stable; " +
      "if (flag) { stable = 9; } return first + stable; } f(true) + f(false);",
      undefined,
      { optimization: "O2" }
    );
    assert.equal(killed.value, 30);
    assert.equal(killed.result.stats.globalValueNumbering.crossBlockLoadsEliminated, 0);
  });

  it("keeps cross-block GVN producers alive across generated loop blocks", function() {
    const source = `
      function tail(node) {
        var current = node;
        while (current.link !== null) current = current.link;
        current.value = 9;
        return current.value;
      }
      tail({ link: { link: null, value: 0 }, value: 0 });
    `;
    const { value } = run(source, undefined, { optimization: "O2" });
    assert.equal(value, 9);
  });

  it("hoists only invariant private-local reads out of natural loops", function() {
    const source = "function sum(n) { var invariant = 3, i = 0, total = 0; " +
      "while (i < n) { total = total + invariant; i++; } return total; } sum(4);";
    const o0 = run(source, undefined, { optimization: "O0" });
    const o2 = run(source, undefined, { optimization: "O2" });
    assert.equal(o0.value, 12);
    assert.equal(o2.value, o0.value);
    assert(o2.result.stats.loopInvariantCodeMotion.loadsHoisted > 0);
    assert(/const \$h\d+_\d+ = \$l\[\d+\];/.test(o2.result.code));

    const changing = run(
      "function sum(n) { var value = 0, i = 0, total = 0; " +
      "while (i < n) { value = value + 1; total = total + value; i++; } return total; } sum(4);",
      undefined,
      { optimization: "O2" }
    );
    assert.equal(changing.value, 10);
    assert.equal(changing.result.stats.loopInvariantCodeMotion.loadsHoisted, 0);
  });

  it("inlines budgeted small calls behind identity and primitive guards", function() {
    const source = "function add(a, b) { return (a + b) | 0; } add(2, 3);";
    const inlined = run(source, undefined, { optimization: "O2" });
    assert.equal(inlined.value, 5);
    assert.equal(inlined.result.stats.codegen.inlining.callSites, 1);
    assert(inlined.result.stats.codegen.inlining.instructionsInlined > 0);
    assert(inlined.result.code.includes("typeof $v"));

    const disabled = run(source, undefined, {
      optimization: "O2",
      inlineSmallFunctions: false,
    });
    assert.equal(disabled.value, 5);
    assert.equal(disabled.result.stats.codegen.inlining.callSites, 0);

    const loaded = load(
      "function add(a, b) { return a + b; } mutate(); add(2, 3);",
      { optimization: "O2" }
    );
    let instance;
    instance = loaded.program.createInstance({
      globals: {
        mutate() { instance.global.add = function() { return 41; }; },
      },
    });
    assert.equal(instance.run(), 41);
    assert.equal(loaded.result.stats.codegen.inlining.callSites, 1);

    let coercions = 0;
    const coerced = run(
      "function add(a, b) { return a + b; } add(host, 1);",
      { host: { valueOf() { coercions += 1; return 4; } } },
      { optimization: "O2" }
    );
    assert.equal(coerced.value, 5);
    assert.equal(coercions, 1);
    assert.throws(
      () => compile(source, { runtimeModule, optimization: "O2", inlineBudget: -1 }),
      /Invalid inline budget/
    );
  });

  it("eliminates a dead pure comparison but preserves getter reads", function() {
    let reads = 0;
    const host = {};
    Object.defineProperties(host, {
      left: { get() { reads += 1; return 1; } },
      right: { get() { reads += 1; return 2; } },
    });
    const source = "host.left === host.right; 9;";
    const o1 = run(source, { host }, { optimization: "O1" });
    assert.equal(o1.value, 9);
    assert.equal(reads, 2);
    assert(!o1.result.code.includes("$r.strictEqual($f)"));
    assert.equal(o1.result.stats.deadCodeElimination.stackDropsInserted, 2);
  });

  it("does not fold or eliminate observable host property reads", function() {
    let reads = 0;
    const host = {};
    Object.defineProperty(host, "value", { get() { reads += 1; return 3; } });
    assert.equal(run("host.value + host.value;", { host }, { optimization: "O2" }).value, 6);
    assert.equal(reads, 2);
  });

  it("exposes deterministic HIR and optimizer statistics", function() {
    const traced = [];
    const first = compile("1 + 2 * 3;", { runtimeModule, includeHIR: true, optimization: "O2" });
    const second = compile("1 + 2 * 3;", { runtimeModule, includeHIR: true, optimization: "O2" });
    const withTrace = compile("1 + 2 * 3;", {
      runtimeModule,
      optimization: "O2",
      tracePasses(pass) { traced.push(pass.name); },
    });
    assert.deepStrictEqual(first.hir, second.hir);
    assert(first.stats.constantsFolded > 0);
    assert.equal(first.stats.mir.builds, 1);
    assert(first.stats.nodesAfter < first.stats.nodesBefore);
    assert(first.stats.passes.every((pass) => Number.isFinite(pass.durationMs)));
    assert.deepStrictEqual(traced, withTrace.stats.passes.map((pass) => pass.name));
    assert.equal(first.metadata.abiVersion, ABI_VERSION);
    assert.equal(first.metadata.inputLanguage, "es5.1");
    assert.equal(compile("1;", { runtimeModule, optimization: "O0" }).stats.mir.builds, 0);
  });

  it("aliases non-observable source identifiers without post-codegen obfuscation", function() {
    const source = "var exported = (function factoryIdentity(outerConfidential) { " +
      "var retainedConfidential = outerConfidential + 1; " +
      "return function nestedIdentity(innerConfidential) { " +
      "return { publicField: retainedConfidential + innerConfidential }; }; })(4); " +
      "exported(3).publicField;";
    for (const optimization of ["O0", "O2"]) {
      const first = load(source, { optimization });
      const second = load(source, { optimization });
      assert.equal(first.program.createInstance().run(), 8);
      assert.equal(first.result.code, second.result.code);
      for (const hidden of [
        "factoryIdentity",
        "outerConfidential",
        "retainedConfidential",
        "nestedIdentity",
        "innerConfidential",
      ]) {
        assert(!first.result.code.includes(hidden), `${hidden} leaked into generated code`);
      }
      assert(first.result.code.includes("exported"));
      assert(first.result.code.includes("publicField"));
      assert.equal(first.result.metadata.identifierProtection, "alias");
      assert(first.result.stats.codegen.identifierProtection.aliasedBindings >= 5);
    }

    const preserved = compile(source, {
      runtimeModule,
      optimization: "O2",
      identifierProtection: "preserve",
    });
    assert(preserved.code.includes("retainedConfidential"));
    assert.equal(preserved.stats.codegen.identifierProtection.aliasedBindings, 0);
    assert.throws(
      () => compile("1;", { runtimeModule, identifierProtection: "unknown" }),
      /Unknown identifier protection mode/
    );

    for (const optimization of ["O0", "O2"]) {
      const reused = run(
        "function first(firstSecret) { return firstSecret + 1; } " +
        "function second(secondSecret) { return secondSecret + 2; } first(1) + second(2);",
        undefined,
        { optimization }
      );
      assert.equal(reused.value, 6);
      assert(reused.result.stats.codegen.identifierProtection.reusedAliases > 0);
      assert(
        reused.result.stats.codegen.identifierProtection.uniqueAliases <
        reused.result.stats.codegen.identifierProtection.aliasedBindings
      );
    }
  });

  it("folds giant constant array literals into native literals", function() {
    const count = 3000;
    let entries = "";
    for (let index = 0; index < count; index += 1) entries += (index ? ", " : "") + (index % 251);
    const source = `var data = [${entries}]; data.length;`;
    const { result, value } = run(source, undefined, { optimization: "O2" });
    assert.equal(value, count);
    // The per-element helper round-trips are folded into one literal.
    assert(!result.code.includes("initProperty"));
    assert(result.code.length < 200000);
  });

  it("keeps cross-block inline guards from referencing out-of-scope temporaries", function() {
    // The helper closure is emitted inside the if-block; the call site in
    // the loop must fall back to the runtime call instead of referencing
    // the closure temporary by name.
    const source =
      "function f() { var fn = null; if (true) { function helper() { return 1; } fn = helper; } " +
      "var acc = 0; for (var i = 0; i < 3; i++) { acc += fn(); } return acc; } f();";
    for (const optimization of ["O0", "O2", "Os"]) {
      assert.equal(run(source, undefined, { optimization }).value, 3, optimization);
    }
  });

  it("uses compact leaf frames and a size-aware Os closure strategy", function() {
    const source = "function add(left, right) { return left + right; } add(2, 3);";
    const o2 = run(source, undefined, { optimization: "O2" });
    const os = run(source, undefined, { optimization: "Os" });
    assert.equal(o2.value, 5);
    assert.equal(os.value, 5);
    assert(o2.result.stats.codegen.leafFrameScopes > 0);
    assert(o2.result.stats.codegen.inlineLeafFrameScopes > 0);
    assert(o2.result.code.includes("const $f = { metadata: $metadata, locals:"));
    assert(!o2.result.code.includes("argumentsInitialized: false"));
    const genericLeaf = run(source, undefined, {
      optimization: "O2",
      inlineLeafFrames: false,
      inlineFastFrames: false,
    });
    assert.equal(genericLeaf.value, 5);
    assert.equal(genericLeaf.result.stats.codegen.inlineLeafFrameScopes, 0);
    assert.equal(genericLeaf.result.stats.codegen.inlineFastFrameScopes, 0);
    assert(genericLeaf.result.code.includes("$invokeCompiled($r, $execute"));
    // Non-leaf fast scopes inline their frame construction by default and
    // omit fields the scope never reads.
    const fastSource = "function pair(outerValue) { return function inner() { return outerValue; }; } pair(7)();";
    const fast = run(fastSource, undefined, { optimization: "O2" });
    assert.equal(fast.value, 7);
    assert(fast.result.stats.codegen.inlineFastFrameScopes > 0);
    assert(fast.result.code.includes("callerFrame: $r.currentFrame"));
    assert(!fast.result.code.includes("argumentsInitialized: false"));
    assert(!os.result.code.includes("function $make1"));
    assert.equal(o2.result.metadata.perScopeFactories, true);
    assert.equal(os.result.metadata.perScopeFactories, false);
    assert(os.result.code.length < o2.result.code.length);
    assert(os.result.stats.codegen.stackToLocal.sizeTemporaryReuses > 0);
    assert.equal(os.result.stats.codegen.sizeOptimization.costModel.objective, "raw-bytes");
    assert.equal(os.result.stats.codegen.sizeOptimization.costModel.candidates.length, 2);
    assert.equal(os.result.stats.codegen.sizeOptimization.costModel.selected, "shared-factory");
  });

  it("preserves names across dynamic environment chains", function() {
    const source = "function dynamicOwner(dynamicLocal) { var object = { dynamicLocal: 7 }; " +
      "with (object) { return function dynamicChild() { return dynamicLocal; }; } } " +
      "dynamicOwner(3)();";
    const loaded = run(source, undefined, { optimization: "O2" });
    assert.equal(loaded.value, 7);
    assert(loaded.result.code.includes("dynamicLocal"));
    assert.equal(loaded.result.stats.codegen.identifierProtection.aliasedBindings, 0);
  });

  it("lowers exception syntax to native try/catch without a dispatcher", function() {
    const hir = lowerToHIR("try { throw 1; } catch (error) { error; }");
    assert.equal(hir.kind, "ProgramHIR");
    assert(hir.scopes[0].instructions.some((instruction) => instruction.op === "TRY"));
    const source = "var x = 0; try { throw 4; } catch (error) { x = error; } finally { x = x + 2; } x;";
    const { result, value } = run(source);
    assert.equal(value, 6);
    assert(result.code.includes("try {"));
    assert(result.code.includes("catch ($error"));
  });

  it("preserves catch bindings in closures and host exception identity", function() {
    const marker = {};
    const source = "var saved; try { host(); } catch (error) { saved = function() { return error; }; } saved();";
    const { value } = run(source, { marker, host() { throw marker; } });
    assert.strictEqual(value, marker);
  });

  it("captures native with environments and applies their shadowing", function() {
    const source = "var x = 1, object = { x: 2 }, saved; with (object) { x = 3; saved = function() { return x; }; } x + saved();";
    const { value, instance } = run(source);
    assert.equal(value, 4);
    assert.equal(instance.global.object.x, 3);
    assert.equal(
      run("var object = { x: 7, read: function() { return this.x; } }, result; with (object) { result = read(); } result;").value,
      7
    );
  });

  it("uses direct variable values only outside dynamic environment chains", function() {
    const safe = run(
      "var globalValue = 4; function outer() { var captured = 3; " +
      "return function() { captured = captured + 1; globalValue = globalValue + 1; " +
      "return captured + globalValue; }; } outer()();",
      undefined,
      { optimization: "O2" }
    );
    assert.equal(safe.value, 9);
    assert(safe.result.code.includes("$f.environment.outer.frame.locals"));
    assert(!safe.result.code.includes("$readVar($r, $f"));

    const dynamic = run(
      "var x = 1, saved; with ({ x: 7 }) { saved = function() { return x; }; } saved();",
      undefined,
      { optimization: "O2" }
    );
    assert.equal(dynamic.value, 7);
    assert(dynamic.result.code.includes("$r.getVar($f"));
  });

  it("executes static eval in the caller environment and rejects dynamic source", function() {
    const source = "function update() { var x = 2; eval('var y = 5; x = x + y;'); return x + y; } update();";
    assert.equal(run(source).value, 12);
    assert.throws(
      () => run("var source = '1 + 2'; eval(source);"),
      /Dynamic eval source is not supported/
    );
  });

  it("creates static Function bodies in the global environment", function() {
    const source = "var add = new Function('a', 'b', 'return a + b;'); add(3, 4);";
    assert.equal(run(source).value, 7);
    assert.equal(
      run("function outer() { var secret = 1; return Function('return typeof secret;'); } outer()();").value,
      "undefined"
    );
  });

  it("implements sloppy arguments aliasing and strict arguments isolation", function() {
    assert.equal(run("function f(a) { arguments[0] = 3; return a; } f(1);").value, 3);
    assert.equal(run("function f(a) { 'use strict'; arguments[0] = 3; return a; } f(1);").value, 1);
    assert.equal(run("function f(a) { eval('arguments[0] = 8;'); return a; } f(1);").value, 8);
    assert.equal(
      run("function f(a) { var tag = Object.prototype.toString.call(arguments); Object.defineProperty(arguments, '0', { get: function() { return 9; }, configurable: true }); return tag + ':' + a + ':' + arguments[0]; } f(1);").value,
      "[object Arguments]:1:9"
    );
    assert.equal(run("function f(a) { return f.arguments[0]; } f(6);").value, 6);
  });

  it("tracks ES5 caller restrictions across strict and sloppy compiled calls", function() {
    assert.equal(
      run("function outer() { return inner(); } function inner() { return inner.caller === outer; } outer();").value,
      true
    );
    assert.throws(
      () => run("function outer() { 'use strict'; return inner(); } function inner() { return inner.caller; } outer();"),
      TypeError
    );
  });

  it("does not treat catch declarative bindings as with call bases", function() {
    const source = "function test() { var x = 'local'; function setX() { this.x = 'global'; } try { throw setX; } catch (fn) { fn(); } return x; } test();";
    assert.equal(run(source).value, "local");
  });

  it("keeps internal descriptors isolated from host prototype pollution", function() {
    const source = "function f() { var object = {}, result; try { Object.prototype.get = function() { return 7; }; Object.defineProperty(object, 'x', Math); result = object.x; } finally { delete Object.prototype.get; } return result; } f();";
    assert.equal(run(source).value, 7);
    assert.equal(
      run("var saved = Array.prototype.lastIndexOf, result; try { Array.prototype.lastIndexOf = 'changed'; function f() { var local = 3; return local; } result = f(); } finally { Array.prototype.lastIndexOf = saved; } result;").value,
      3
    );
  });

  it("hardens active FastFrames at observed array-prototype mutation calls", function() {
    const savedPush = Object.getOwnPropertyDescriptor(Array.prototype, "push");
    try {
      const source = "Object.defineProperty(Array.prototype, 'push', { " +
        "value: function() { throw new Error('guest push'); }, writable: true, configurable: true }); " +
        "var object = { get value() { return 7; } }; object.value;";
      const loaded = run(source, undefined, { optimization: "O2" });
      assert.equal(loaded.value, 7);
      assert(loaded.result.code.includes("$s.push"));
      assert(loaded.result.stats.codegen.fastFrameScopes > 0);
    } finally {
      Object.defineProperty(Array.prototype, "push", savedPush);
    }
  });

  it("keeps O2 FastFrame locals isolated from Array prototype index accessors", function() {
    const source = "var result; try { " +
      "Object.defineProperty(Array.prototype, '2', { get: function() { return 99; }, configurable: true }); " +
      "function read(a, b) { var local = 3; return local; } result = read(1, 2); " +
      "} finally { delete Array.prototype[2]; } result;";
    const loaded = run(source, undefined, { optimization: "O2" });
    assert.equal(loaded.value, 3);
    assert(loaded.result.stats.codegen.fastFrameScopes > 0);
  });

  it("rejects block-level function declarations in ES5.1 strict code", function() {
    assert.throws(
      () => compile("'use strict'; { function nested() {} }", { runtimeModule }),
      SyntaxError
    );
  });

  it("checks the compiler/runtime ABI and enforces instance lifecycle", function() {
    assert.throws(() => createProgram(() => {}, {}, "wrong-abi"), /ABI mismatch/);
    const { program } = load("42;");
    assert.equal(program.abiVersion, ABI_VERSION);
    const instance = program.createInstance();
    assert.equal(instance.run(), 42);
    assert.throws(() => instance.run(), /only run once/);
    instance.dispose();
  });
});
