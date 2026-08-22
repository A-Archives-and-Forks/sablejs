"use strict";

const assert = require("assert");
const path = require("path");
const { describe, it } = require("node:test");
const sablejs = require("../../src");

const runtimeModule = path.resolve(__dirname, "../../src/runtime");

function load(source, options = {}) {
  const result = sablejs.compile(source, { runtimeModule, ...options });
  const generatedModule = { exports: {} };
  new Function("require", "module", "exports", result.code)(
    require,
    generatedModule,
    generatedModule.exports
  );
  return { result, program: generatedModule.exports };
}

function run(source, globals, options = {}) {
  const loaded = load(source, options);
  const instance = loaded.program.createInstance({ globals });
  return { ...loaded, instance, value: instance.run() };
}

function assertSandboxBlocked(source, pattern = /sablejs sandbox boundary/) {
  for (const optimization of ["O0", "O1", "O2", "Os"]) {
    assert.throws(
      () => run(source, undefined, { optimization }),
      pattern,
      `${optimization} allowed an escape path`
    );
  }
}

describe("sablejs sandbox security boundary", function () {
  it("uses sandbox mode by default and keeps trusted mode explicit", function () {
    const sandbox = load("1;");
    assert.equal(sandbox.result.metadata.security, "sandbox");
    assert.equal(sandbox.program.security, "sandbox");
    assert.throws(
      () => sandbox.program.createInstance({ security: "trusted" }),
      /compiled as sandbox/
    );
    assert.equal(load("1;", { security: "trusted" }).result.metadata.security, "trusted");
    assert.throws(() => load("1;", { security: "unknown" }), /security mode/);
  });

  it("keeps ambient globals outside the guest global object", function () {
    assert.deepStrictEqual(
      run(
        "[typeof globalThis, typeof global, typeof process, " +
        "Object.getPrototypeOf(this) === null, typeof this.constructor];"
      ).value,
      ["undefined", "undefined", "undefined", true, "undefined"]
    );
  });

  it("keeps mediated property and call operations on the optimized local stack", function () {
    const loaded = load(
      "var item = { value: 1, read: function () { return this.value; } }; " +
      "var ctor = item.constructor; item.value = item.read() + 1; item.value;",
      { optimization: "O2" }
    );
    assert.match(loaded.result.code, /getSandboxPropertyValue/);
    assert.match(loaded.result.code, /applySandboxValue/);
    assert.match(loaded.result.code, /setSandboxPropertyValue/);
    assert.match(loaded.result.code, /\["read"\]/);
    assert.doesNotMatch(loaded.result.code, /\$r\.(?:getProperty|call|setProperty)/);
    assert.equal(loaded.program.createInstance().run(), 2);
  });

  it("blocks Function-constructor escapes through ordinary prototypes", function () {
    assertSandboxBlocked(
      "var HostFunction = ({}).constructor.constructor; " +
      "HostFunction('return this')();"
    );
  });

  it("blocks Function-constructor escapes through property descriptors", function () {
    assertSandboxBlocked(
      "var proto = Object.getPrototypeOf(function () {}); " +
      "var HostFunction = Object.getOwnPropertyDescriptor(proto, 'constructor').value; " +
      "HostFunction('return this')();"
    );
  });

  it("blocks Function-constructor escapes through bind and call", function () {
    assertSandboxBlocked("var BoundFunction = Function.bind(null); BoundFunction('return this')();");
    assertSandboxBlocked(
      "Function.prototype.call.call(Function, null, 'return this')();"
    );
  });

  it("blocks additional constructor and reflection escape chains", function () {
    assertSandboxBlocked(
      "Object.getOwnPropertyDescriptor(Object.prototype, 'constructor').value" +
      ".constructor('return this')();"
    );
    assertSandboxBlocked("Object.getPrototypeOf(Object).constructor('return this')();");
    assertSandboxBlocked("(function guest() {}).constructor('return this')();");
    assertSandboxBlocked("Reflect.apply(Function, null, ['return this'])();");
    assertSandboxBlocked("Reflect.construct(Function, ['return this'])();");
  });

  it("mediates raw intrinsic values delivered through native callbacks", function () {
    const prefix =
      "var descriptor = Object.getOwnPropertyDescriptor(Function.prototype, 'constructor'); " +
      "var values = Object.values(descriptor); " +
      "values.forEach(function (candidate) { if (typeof candidate === 'function') { ";
    assertSandboxBlocked(
      prefix + "Reflect.apply(candidate, null, ['return process.version'])(); } });"
    );
    assertSandboxBlocked(
      prefix + "candidate.call(null, 'return process.version')(); } });"
    );
  });

  it("keeps the boundary active through with-environment lookups", function () {
    assertSandboxBlocked(
      "with (Object.prototype) { constructor.constructor('return this')(); }"
    );
  });

  it("copies plain globals recursively and preserves graph identity inside the guest", function () {
    const shared = { value: 1 };
    const host = { left: shared, right: shared };
    const loaded = run(
      "input.left.value = 9; [input.left === input.right, input.right.value, input];",
      { input: host }
    );
    assert.deepStrictEqual(loaded.value.slice(0, 2), [true, 9]);
    assert.notStrictEqual(loaded.value[2], host);
    assert.notStrictEqual(loaded.value[2].left, shared);
    assert.equal(host.left.value, 1);
  });

  it("rejects custom prototypes, accessors, symbols, and unwrapped functions in globals", function () {
    const inherited = Object.create({ inherited: globalThis });
    assert.throws(() => load("input;").program.createInstance({ globals: { input: inherited } }), /plain data/);

    let reads = 0;
    const accessor = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get() { reads += 1; return globalThis; },
    });
    assert.throws(() => load("input;").program.createInstance({ globals: { input: accessor } }), /accessor/);
    assert.equal(reads, 0);

    const symbolic = { [Symbol("secret")]: 1 };
    assert.throws(() => load("input;").program.createInstance({ globals: { input: symbolic } }), /symbol/);
    assert.throws(
      () => load("fn;").program.createInstance({ globals: { fn() {} } }),
      /capability/
    );
  });

  it("exposes host functions only through explicit cloned capabilities", function () {
    assert.equal(typeof sablejs.capability, "function");
    let received;
    const hostResult = { total: 0 };
    const add = sablejs.capability(function (input) {
      received = input;
      input.value = 20;
      hostResult.total = input.value + 2;
      return hostResult;
    });
    const loaded = run(
      "var local = { value: 3 }; var result = add(local); " +
      "result.total = 99; [local.value, result.total];",
      { add }
    );
    assert.deepStrictEqual(loaded.value, [3, 99]);
    assert.deepStrictEqual(received, { value: 20 });
    assert.equal(hostResult.total, 22);
  });

  it("rejects ambient objects and functions returned by capabilities", function () {
    assert.equal(typeof sablejs.capability, "function");
    const returnGlobal = sablejs.capability(() => globalThis);
    const returnNestedGlobal = sablejs.capability(() => ({ nested: globalThis }));
    const returnFunction = sablejs.capability(() => function leaked() {});
    assert.throws(() => run("returnGlobal();", { returnGlobal }), /ambient host object/);
    assert.throws(() => run("returnNestedGlobal();", { returnNestedGlobal }), /ambient host object/);
    assert.throws(() => run("returnFunction();", { returnFunction }), /function/);
  });

  it("sanitizes capability exceptions and revokes wrappers on dispose", function () {
    assert.equal(typeof sablejs.capability, "function");
    const fail = sablejs.capability(() => {
      const error = new Error("expected failure");
      error.secret = globalThis;
      throw error;
    });
    assert.deepStrictEqual(
      run(
        "try { fail(); } catch (error) { [error.name, error.message, typeof error.secret]; }",
        { fail }
      ).value,
      ["Error", "expected failure", "undefined"]
    );
    assert.equal(
      run("try { fail(); } catch (error) { typeof error.stack; }", { fail }).value,
      "undefined"
    );

    const exported = run("cap;", { cap: sablejs.capability(() => 1) });
    exported.instance.dispose();
    assert.throws(() => exported.value(), /revoked/);
  });

  it("keeps intrinsic objects read-only, including indirect mutator calls", function () {
    Object.defineProperty(Object.prototype, "__sablejsDeleteProbe", {
      value: 1,
      configurable: true,
    });
    try {
      assertSandboxBlocked("Object.prototype.__sablejsPolluted = 1;");
      assertSandboxBlocked(
        "Object.defineProperty.call(null, Object.prototype, '__sablejsPolluted', " +
        "{ value: 1, configurable: true });"
      );
      assertSandboxBlocked(
        "Reflect.defineProperty(Object.prototype, '__sablejsPolluted', " +
        "{ value: 1, configurable: true });"
      );
      assertSandboxBlocked("Object.setPrototypeOf(Object.prototype, { polluted: true });");
      assertSandboxBlocked("Array.prototype.push.call(Object.prototype, 1);");
      assertSandboxBlocked(
        "Reflect.set({}, '__sablejsPolluted', 1, Object.prototype);"
      );
      assertSandboxBlocked(
        "var setter = Object.prototype.__lookupSetter__('__proto__'); " +
        "setter.call(Array.prototype, Object.prototype);"
      );
      assertSandboxBlocked(
        "var proxy = new Proxy(Array.prototype, {}); proxy.__sablejsPolluted = 1;"
      );
      assertSandboxBlocked(
        "var proxy = Proxy.revocable(Array.prototype, {}).proxy; " +
        "proxy.__sablejsPolluted = 1;"
      );
      if (typeof Error.captureStackTrace === "function") {
        assertSandboxBlocked("Error.captureStackTrace(Object.prototype);");
      }
      assertSandboxBlocked(
        "with (Object.prototype) { delete __sablejsDeleteProbe; }"
      );
      assert.equal(Object.prototype.__sablejsDeleteProbe, 1);
    } finally {
      delete Object.prototype.__sablejsPolluted;
      delete Object.prototype[0];
      delete Array.prototype.__sablejsPolluted;
      delete Object.prototype.__sablejsDeleteProbe;
      delete Object.prototype.stack;
    }
  });

  it("preserves ordinary intrinsic behavior behind the mediated boundary", function () {
    const result = run(
      "var date = new Date(0); var values = [1, 2].map(function (n) { return n * 2; }); " +
      "[Object.keys({ answer: 42 })[0], [] instanceof Array, " +
      "Object.getPrototypeOf([]) === Array.prototype, date.getTime(), values.join(',')];"
    ).value;
    assert.deepStrictEqual(result, ["answer", true, true, 0, "2,4"]);
  });

  it("clones asynchronous capability results and sanitizes rejections", async function () {
    const resolveData = sablejs.capability(async () => ({ nested: { value: 3 } }));
    const rejectData = sablejs.capability(async () => {
      const error = new Error("async failure");
      error.secret = globalThis;
      throw error;
    });
    const resolved = await run("resolveData();", { resolveData }).value;
    assert.deepStrictEqual(resolved, { nested: { value: 3 } });
    await assert.rejects(run("rejectData();", { rejectData }).value, /async failure/);
  });

  it("preserves the legacy pass-through contract only in trusted mode", function () {
    const host = { count: 1 };
    const loaded = run(
      "host.count += 1; host;",
      { host },
      { security: "trusted", optimization: "O2" }
    );
    assert.strictEqual(loaded.value, host);
    assert.equal(host.count, 2);
  });
});

// --- Adversarial battery from the 2026-08-22 audit (see docs/security.md, Verification) ---

// Guards let some probes throw their own fallback error when the host lacks a
// newer built-in; every expected block message matches this pattern.
const AUDIT_BLOCKED_PATTERN =
  /sablejs sandbox boundary|not a function|Cannot read|not a typed array|no Map|no Set|no WeakMap|no TA|no cst|Dynamic Function source/;

// Returns the outcome instead of throwing, for probes that distinguish a
// value from a block and for the known-issue pins below.
function attempt(source, globals, options = {}) {
  try {
    return { outcome: "value", value: run(source, globals, options).value };
  } catch (error) {
    return { outcome: "throw", message: String(error && error.message) };
  }
}

// The frontend prints a chalk warning for rejected dynamic Function/eval
// arguments; silence it while compiling those probes.
function withoutFrontendWarnings(callback) {
  const original = console.log;
  console.log = () => {};
  try {
    return callback();
  } finally {
    console.log = original;
  }
}

describe("sablejs sandbox adversarial battery (audit 2026-08-22)", function () {
  it("blocks Function-constructor escapes through ordinary prototypes", function () {
    assertSandboxBlocked("({}).constructor.constructor('return this')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("[].constructor.constructor('return process')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("''.constructor.constructor('return this')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("(1).constructor.constructor('return this')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("true.constructor.constructor('return this')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Object.getPrototypeOf({}).constructor.constructor('return this')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Object.getPrototypeOf(Object).constructor('return this')();", AUDIT_BLOCKED_PATTERN);
  });

  it("blocks Function-constructor escapes through descriptors and reflection", function () {
    assertSandboxBlocked(
      "Object.getOwnPropertyDescriptor(Function.prototype, 'constructor').value('return this')();",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "Object.getOwnPropertyDescriptor(Object.prototype, 'constructor').value.constructor('return this')();",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked("Function.prototype.constructor('return this')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Function.prototype.call.call(Function, null, 'return this')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Function.call(null, 'return this')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Function.apply(null, ['return this'])();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Function.bind(null)('return this')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Reflect.apply(Function, null, ['return this'])();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Reflect.construct(Function, ['return this'])();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("with (Object.prototype) { constructor.constructor('return this')(); }", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("eval('this.constructor.constructor(\\'return this\\')()');", AUDIT_BLOCKED_PATTERN);
  });

  it("rejects dynamic Function arguments and indirect eval", function () {
    withoutFrontendWarnings(() => {
      assertSandboxBlocked("var x = 'return this'; Function(x)();", AUDIT_BLOCKED_PATTERN);
    });
    assert.throws(() => load("var e = eval; e('return this');"));
  });

  it("compiles literal Function and eval inputs into sandboxed guest code", function () {
    for (const optimization of ["O0", "O1", "O2", "Os"]) {
      const direct = run("Function('return this')();", undefined, { optimization }).value;
      assert.equal(Object.getPrototypeOf(direct), null);
      assert.equal(direct.process, undefined);

      const constructed = run("new Function('return typeof process')();", undefined, { optimization }).value;
      assert.equal(constructed, "undefined");

      const concatenated = run("Function('return ' + 'this')() === this;", undefined, { optimization }).value;
      assert.equal(concatenated, true);
    }
    // eval literals observe the guest global too; O2 is pinned by the
    // known-issue test below until the mediation mismatch is fixed.
    const evaluated = run("eval('Object.getPrototypeOf(this) === null');", undefined, { optimization: "O1" }).value;
    assert.equal(evaluated, true);
  });

  it("blocks prototype pollution through every mutator family", function () {
    assertSandboxBlocked("Object.prototype.x = 1;", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Array.prototype.push(1);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Array.prototype[0] = 1;", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Array.prototype.length = 0;", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("delete Object.prototype.toString;", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("delete Function.prototype.call;", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked(
      "Object.defineProperty(Object.prototype, 'polluted', {value: 1, configurable: true});",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "Object.defineProperty.call(null, Object.prototype, 'polluted', {value: 1, configurable: true});",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "Object.defineProperty.apply(null, [Object.prototype, 'polluted', {value: 1, configurable: true}]);",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "var b = Object.defineProperty.bind(null, Object.prototype, 'polluted', {value: 1, configurable: true}); b();",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked("Object.defineProperties(Object.prototype, {x: {value: 1}});", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Object.assign(Object.prototype, {x: 1});", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Object.freeze(Object.prototype);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Object.seal(Object.prototype);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Object.preventExtensions(Object.prototype);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Object.setPrototypeOf(Object.prototype, {});", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Reflect.set(Object.prototype, 'polluted', 1);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Reflect.set({}, 'polluted', 1, Object.prototype);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked(
      "Reflect.defineProperty(Object.prototype, 'polluted', {value: 1, configurable: true});",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked("Reflect.deleteProperty(Object.prototype, 'toString');", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Object.prototype.__defineGetter__('polluted', function(){ return 1; });", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Object.prototype.__defineSetter__('polluted', function(v){});", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked(
      "var s = Object.prototype.__lookupSetter__('__proto__'); s.call(Array.prototype, Object.prototype);",
      AUDIT_BLOCKED_PATTERN
    );
  });

  it("blocks array, date, map, set, and regexp mutators redirected at protected receivers", function () {
    assertSandboxBlocked("Array.prototype.push.call(Object.prototype, 1);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Array.prototype.splice.call(Object.prototype, 0, 0, 1);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Array.prototype.sort.call(Object.prototype);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Array.prototype.unshift.call(Object.prototype, 1);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Date.prototype.setTime.call(Object.prototype, 0);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("RegExp.prototype.compile.call(Object.prototype, 'x');", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked(
      "if (typeof Map === 'function') { Map.prototype.set.call(Object.prototype, 1, 1); } else { throw new TypeError('no Map'); }",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "if (typeof Map === 'function') { Map.prototype.clear.call(Object.prototype); } else { throw new TypeError('no Map'); }",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "if (typeof Set === 'function') { Set.prototype.add.call(Object.prototype, 1); } else { throw new TypeError('no Set'); }",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "if (typeof WeakMap === 'function') { WeakMap.prototype.set.call(Object.prototype, {}, 1); } else { throw new TypeError('no WeakMap'); }",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "if (typeof Uint8Array === 'function') { Uint8Array.prototype.set.call(Object.prototype, []); } else { throw new TypeError('no TA'); }",
      AUDIT_BLOCKED_PATTERN
    );
    if (typeof Error.captureStackTrace === "function") {
      assertSandboxBlocked("Error.captureStackTrace(Object.prototype);", AUDIT_BLOCKED_PATTERN);
    }
  });

  it("blocks proxy wrapping of protected intrinsics and with-environment writes", function () {
    assertSandboxBlocked("new Proxy(Array.prototype, {});", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Proxy.revocable(Array.prototype, {});", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("with (Object) { prototype = {}; }", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("with (Math) { PI = 3; }", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("with (Object.prototype) { delete toString; }", AUDIT_BLOCKED_PATTERN);
  });

  it("keeps guest own-object mutation isolated from shared intrinsics", function () {
    const swapped = run("var o = {}; o.__proto__ = Object.prototype; o.polluted = 1; Object.prototype.polluted;").value;
    assert.equal(swapped, undefined);
    const shadowed = run("var Object = 1; Object;").value;
    assert.equal(shadowed, 1);
    const withWrite = attempt("with ({}) { constructor = 1; }");
    assert.equal(withWrite.outcome, "value");
  });

  it("keeps sloppy writes to boxed primitives as no-ops and null writes throwing", function () {
    for (const optimization of ["O0", "O2"]) {
      // ES5.1 PutValue on a boxed primitive silently fails the write.
      const result = run("(1).z = 3; 's'.w = 4; true.b = 5; 42;", undefined, { optimization });
      assert.equal(result.value, 42);
      // ES5.1 PutValue on null/undefined bases throws even in sloppy code.
      const nullWrite = attempt("var r = null; r.x = 1; 42;", undefined, { optimization });
      assert.equal(nullWrite.outcome, "throw");
    }
  });

  it("blocks runtime accessors obtained through property descriptors", function () {
    for (const optimization of ["O0", "O2"]) {
      const direct = attempt(
        "function f(){}; var g = Object.getOwnPropertyDescriptor(f, 'caller').get; g(f);",
        undefined,
        { optimization }
      );
      // O0 wraps the accessor at the mediated read and re-mediates the call
      // (harmless null); O2 keeps the raw accessor and rejects it outright.
      // Both outcomes prove the accessor never executes against host frames.
      assert.ok(
        direct.outcome === "throw" || (direct.outcome === "value" && direct.value === null),
        JSON.stringify(direct)
      );

      const viaCall = run(
        "function f(){}; var g = Object.getOwnPropertyDescriptor(f, 'caller').get; g.call(f);",
        undefined,
        { optimization }
      ).value;
      assert.equal(viaCall, null);

      const prototypeCaller = attempt(
        "var g = Object.getOwnPropertyDescriptor(Function.prototype, 'caller').get; g.call(Object.prototype);",
        undefined,
        { optimization }
      );
      assert.ok(
        prototypeCaller.outcome === "throw" || prototypeCaller.value === null,
        JSON.stringify(prototypeCaller)
      );
    }
  });

  it("wraps host functions delivered through nested native callbacks", function () {
    // Promise invokes the executor natively from inside a guest call; the
    // resolve delivered to the executor must be stored wrapped so the guest
    // can only reach it through the boundary re-mediation.
    const result = run(
      "var saved; function outer() { new Promise(function (resolve) { saved = resolve; }); return saved; } " +
      "var raw = outer(); raw.call(null, 7); 'resolved';"
    ).value;
    assert.equal(result, "resolved");
  });

  it("rejects unwrapped functions and custom shapes in globals and capability results", function () {
    assert.throws(
      () => load("x;").program.createInstance({ globals: { x: { fn() {} } } }),
      /function|capability/
    );
    assert.throws(
      () => load("m;").program.createInstance({ globals: { m: new Map([["k", function () {}]]) } }),
      /function|capability/
    );

    class HostSecret { constructor() { this.value = 1; } }
    const returnsInstance = sablejs.capability(() => new HostSecret());
    assert.equal(attempt("cap();", { cap: returnsInstance }).outcome, "throw");

    const accessor = {};
    Object.defineProperty(accessor, "secret", { enumerable: true, get() { return globalThis; } });
    const returnsAccessor = sablejs.capability(() => accessor);
    assert.equal(attempt("cap();", { cap: returnsAccessor }).outcome, "throw");

    const pass = sablejs.capability((input) => input);
    assert.equal(attempt("cap({ then: function (cb) { cb('evil'); } });", { cap: pass }).outcome, "throw");

    if (typeof SharedArrayBuffer === "function") {
      assert.equal(attempt("cap(new SharedArrayBuffer(4));", { cap: pass }).outcome, "throw");
    }
  });

  it("rejects guest functions smuggled between instances", function () {
    const loaded = load("function secret(){ return 42; } secret;");
    const guestFunction = loaded.program.createInstance({}).run();
    assert.equal(typeof guestFunction, "function");
    assert.throws(
      () => loaded.program.createInstance({ globals: { smuggled: guestFunction } }),
      /function|capability/
    );
  });

  it("clones cyclic globals with preserved identity", function () {
    const cyclic = { name: "a" };
    cyclic.self = cyclic;
    assert.equal(run("input.self === input;", { input: cyclic }).value, true);
  });

  it("keeps host globals absent and top-level this on the guest global", function () {
    const globals = run("typeof process + ',' + typeof require + ',' + typeof global + ',' + typeof module;").value;
    assert.equal(globals, "undefined,undefined,undefined,undefined");
    assert.equal(Object.getPrototypeOf(run("this;").value), null);
  });

  it("preserves arguments, caller, and instanceof semantics for guest functions", function () {
    assert.equal(run("function inner() { return arguments.callee === inner; } inner();").value, true);
    assert.equal(
      run("function outer() { function inner() { return inner.caller === outer; } return inner(); } outer();").value,
      true
    );
    assert.equal(attempt("'use strict'; (function(){ return arguments.callee; })();").outcome, "throw");
    assert.equal(run("({}) instanceof Function;").value, false);
  });

  it("invokes guest proxy traps through host intrinsics without host leakage", function () {
    assert.equal(run("var p = new Proxy({ a: 1 }, {}); Object.keys(p).join(',');").value, "a");
    assert.equal(run("var p = new Proxy({}, { has: function(){ return true; } }); 'x' in p;").value, true);
    assert.equal(
      run("var p = new Proxy({}, { get: function(t, k){ return k === 'x' ? Object.prototype : 1; } }); p.x === Object.prototype;").value,
      true
    );
    assert.equal(
      attempt(
        "var p = new Proxy({}, { get: function(t, k){ return k === 'toJSON' ? function(){ return { leaked: Object.prototype }; } : undefined; } }); JSON.stringify(p);"
      ).outcome,
      "value"
    );
  });

  it("keeps the guest global read-only against Error extensions", function () {
    if (typeof Error.prepareStackTrace !== "undefined") {
      assertSandboxBlocked("Error.prepareStackTrace = function(){};", AUDIT_BLOCKED_PATTERN);
    }
    assertSandboxBlocked("Function.prototype.x = 1;", AUDIT_BLOCKED_PATTERN);
  });
});

describe("sablejs sandbox known issues (audit 2026-08-22)", function () {
  // These tests pin the fixed behavior of audit findings 1-3
  // (see docs/security.md, Historical audit record).

  it(
    "O2/Os: property reads on function globals must work inside dynamic scopes (finding 1)",
    function () {
      const cases = [
        "function f() { try { throw 1; } catch (e) { return Object.keys({a:1})[0]; } } f();",
        "function f() { with ({}) { return Array.isArray([]); } } f();",
        "eval('Object.getPrototypeOf(this) === null');",
      ];
      for (const optimization of ["O0", "O1", "O2", "Os"]) {
        for (const source of cases) {
          const result = attempt(source, undefined, { optimization });
          assert.equal(result.outcome, "value", `${optimization} ${source} -> ${result.message}`);
        }
      }
      assert.equal(run("eval('Object.getPrototypeOf(this) === null');", undefined, { optimization: "O2" }).value, true);
    }
  );

  it(
    "O2: wrapper surface must not be observable through direct reads (finding 1)",
    function () {
      for (const optimization of ["O0", "O1", "O2", "Os"]) {
        const result = run("({}).constructor.length;", undefined, { optimization }).value;
        assert.equal(result, 1, `${optimization} exposed the wrapper surface`);
      }
    }
  );

  it(
    "keeps instanceof prototype resolution consistent across optimization levels",
    function () {
      for (const optimization of ["O0", "O1", "O2", "Os"]) {
        const compiledFn = run("(function(){}) instanceof Function;", undefined, { optimization }).value;
        assert.equal(compiledFn, true, `${optimization} instanceof Function on a compiled fn`);
        const plain = run("({}) instanceof Function;", undefined, { optimization }).value;
        assert.equal(plain, false, `${optimization} instanceof Function on a plain object`);
        const array = run("[] instanceof Array;", undefined, { optimization }).value;
        assert.equal(array, true, `${optimization} instanceof Array`);
      }
    }
  );

  it(
    "boundary errors must not leak host frames through stack (finding 2)",
    function () {
      const result = run("var s = ''; try { Object.prototype.x = 1; } catch (e) { s = String(e.stack); } s;").value;
      assert.doesNotMatch(result, /security\.js|runtime\/index\.js/);
    }
  );

  it(
    "Error.captureStackTrace must not expose host frames on guest objects (finding 2)",
    function () {
      if (typeof Error.captureStackTrace !== "function") return;
      const direct = attempt("Error.captureStackTrace(Object.prototype);");
      assert.equal(direct.outcome, "throw");
      const redirected = attempt("var o = {}; Error.captureStackTrace.call(o);");
      assert.equal(redirected.outcome, "throw");
      assert.match(redirected.message, /sablejs sandbox boundary/);
    }
  );

  it(
    "wrapper source must not be readable through Function.prototype.toString (finding 2)",
    function () {
      const direct = run("var w = ({}).constructor; w.toString();").value;
      assert.doesNotMatch(direct, /sableIntrinsicBoundary|sableDynamicFunctionBoundary/);
      // The mediated chain reaches the raw Function.prototype.toString, which
      // callHost refuses for wrapper receivers; either outcome must not
      // disclose boundary source.
      const viaPrototype = attempt("var w = ({}).constructor; Function.prototype.toString.call(w);");
      assert.ok(
        viaPrototype.outcome === "throw" ||
        (viaPrototype.outcome === "value" &&
          !/sableIntrinsicBoundary|sableDynamicFunctionBoundary/.test(viaPrototype.value)),
        JSON.stringify(viaPrototype)
      );
    }
  );

  it(
    "capability-cloned Buffer views must not carry the Buffer prototype (finding 3)",
    function () {
      if (typeof Buffer === "undefined") return;
      const expose = sablejs.capability(() => Buffer.from([1, 2, 3]));
      const result = run("cap();", { cap: expose }).value;
      assert.equal(Object.getPrototypeOf(result), Uint8Array.prototype);
      assert.deepStrictEqual(Array.from(result), [1, 2, 3]);
    }
  );

  it("worker client validates responses and enforces timeouts", async function () {
    const { createSandboxClient } = sablejs.worker;
    // A fake worker that answers the first message and drops the second.
    const posted = [];
    const fakeWorker = {
      listeners: {},
      addEventListener(name, handler) { this.listeners[name] = handler; },
      postMessage(message) { posted.push(message); },
      terminate() {},
      respond(handler, message) { handler({ data: message }); },
    };
    const client = createSandboxClient(fakeWorker, { timeoutMs: 5000 });
    const success = client.run({ price: 100 });
    assert.equal(posted.length, 1);
    fakeWorker.respond(fakeWorker.listeners.message, { id: posted[0].id, ok: true, value: { total: 120 } });
    assert.deepStrictEqual(await success, { total: 120 });

    const malformed = client.run({});
    fakeWorker.respond(fakeWorker.listeners.message, { id: posted[1].id, ok: true });
    await assert.rejects(malformed, /missing value/);

    const dropped = client.run({});
    client.terminate();
    await assert.rejects(dropped, /terminated/);

    const fastClient = createSandboxClient(fakeWorker, { timeoutMs: 5 });
    await assert.rejects(fastClient.run({}), /timed out/);
  });

  it("worker client evaluate ships compiled artifacts and validates the program argument", async function () {
    const { createSandboxClient } = sablejs.worker;
    const posted = [];
    const fakeWorker = {
      listeners: {},
      addEventListener(name, handler) { this.listeners[name] = handler; },
      postMessage(message) { posted.push(message); },
      terminate() {},
      respond(handler, message) { handler({ data: message }); },
    };
    const client = createSandboxClient(fakeWorker, { timeoutMs: 5000 });
    const artifact = "compiled artifact";
    const success = client.evaluate(artifact, { price: 100 });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].program, artifact);
    fakeWorker.respond(fakeWorker.listeners.message, { id: posted[0].id, ok: true, value: { total: 120 } });
    assert.deepStrictEqual(await success, { total: 120 });
    await assert.rejects(client.evaluate(42, {}), /compiled artifact/);
    // A plain run must not carry a program field.
    const plain = client.run({});
    assert.equal(posted[1].program, undefined);
    client.terminate();
    await assert.rejects(plain, /terminated/);
  });

  it("worker handler loads and runs compiled artifacts on evaluate messages", function () {
    const { handleSandboxMessages } = sablejs.worker;
    const artifact = sablejs.compile("var total = input.price * 2; total;", { runtimeModule }).code;
    let loads = 0;
    const posted = [];
    const scope = {};
    handleSandboxMessages(
      { createInstance() { throw new Error("bound program must not run for evaluate messages"); } },
      {
        scope,
        postMessage: (message) => posted.push(message),
        loadProgram: (code) => {
          loads += 1;
          const module = { exports: {} };
          new Function("require", "module", "exports", code)(require, module, module.exports);
          return module.exports;
        },
      }
    );
    scope.onmessage({ data: { id: 1, input: { price: 21 }, program: artifact } });
    scope.onmessage({ data: { id: 2, input: { price: 22 }, program: artifact } });
    assert.deepStrictEqual(posted[0], { id: 1, ok: true, value: 42 });
    assert.deepStrictEqual(posted[1], { id: 2, ok: true, value: 44 });
    assert.equal(loads, 1); // the last artifact is cached across messages
    scope.onmessage({ data: { id: 3, input: {}, program: 7 } });
    assert.equal(posted[2].ok, false);
    assert.match(posted[2].error, /compiled artifact/);
    scope.onmessage({ data: { id: 4, input: { price: 1 } } });
    assert.equal(posted[3].ok, false);
    assert.match(posted[3].error, /bound program/);
  });

  it("default artifact loader resolves the sablejs runtime (Node)", function () {
    const { loadCompiledArtifact } = sablejs.worker;
    const program = loadCompiledArtifact(sablejs.compile("var total = input.price * 3; total;").code);
    const instance = program.createInstance({ globals: { input: { price: 10 } } });
    try { assert.equal(instance.run(), 30); } finally { instance.dispose(); }
  });

  it("host-called guest functions must not mutate host arguments or receiver", function () {
    const loaded = load("function f(a) { a.x = 99; a.nested.y = 88; this.tag = true; return a.x; } f;");
    const instance = loaded.program.createInstance({ globals: {} });
    const fn = instance.run();
    const hostArg = { x: 1, nested: { y: 2 } };
    const hostThis = { tag: false };
    assert.equal(fn.call(hostThis, hostArg), 99);
    assert.deepStrictEqual(hostArg, { x: 1, nested: { y: 2 } });
    assert.deepStrictEqual(hostThis, { tag: false });
    instance.dispose();
  });

  it("guest-internal calls keep reference semantics across frames", function () {
    const loaded = load(
      "function g(o) { o.v = 2; return o.v; }" +
      "function h() { var o = { v: 1 }; return [g(o), o.v]; } h;"
    );
    const instance = loaded.program.createInstance({ globals: {} });
    assert.deepStrictEqual(instance.run()(), [2, 2]);
    instance.dispose();
  });
});
