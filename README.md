![LOGO](./logo.jpg)

[![Ubuntu CI](https://github.com/sablejs/sablejs/actions/workflows/ci.yml/badge.svg)](https://github.com/sablejs/sablejs/actions/workflows/ci.yml)
[![Version](https://img.shields.io/npm/v/sablejs.svg?sanitize=true)](https://www.npmjs.com/package/sablejs)
[![License](https://img.shields.io/github/license/sablejs/sablejs)](LICENSE)

sablejs is a **small AOT-compiled execution layer** for running **user-authored and AI-generated JavaScript** in browsers. It combines a **stable ES5.1 contract**, **explicit capabilities**, and **Worker isolation** for **rules, plugins, formulas, and other untrusted logic**.

## Why sablejs

- **Versus `eval` / `new Function`**: these compile and execute source at runtime inside a privileged JavaScript environment. sablejs moves source compilation to build time, ships no runtime evaluator, rejects dynamically generated source, and mediates access to host capabilities.
- **Versus an iframe sandbox**: an iframe isolates and restricts a browsing context. sablejs instead exposes copied data, protected intrinsics, and explicit capabilities — guest code receives no browser realm, so a dedicated Worker can serve as the entire guest environment.
- **Versus QuickJS-WASM**: QuickJS-WASM embeds a complete JavaScript interpreter inside WebAssembly. sablejs instead AOT-compiles ES5.1 into direct JavaScript for the host engine, trading interpreter/parser/dispatch overhead for larger generated code and a deliberately stable ES5.1 source contract.

## Use cases

sablejs is built for products that execute code the operator did not author:

- **AI executors and agents** — run LLM-generated JavaScript (data transforms, formulas, API-call scripts, UI automation steps) as an untrusted artifact: compile the model's output ahead of time, execute it in a Worker, and get copied results back with no page access. AOT produces a stable, cacheable executable artifact, while the fixed ES5.1 contract makes generated code easier to validate and repair.
- **User plugins and extensions** — Figma and design-tool plugins, and embeddable plugin systems with user-defined behavior.
- **Rules and formula engines** — low-code rules, spreadsheet formulas, validators, workflow steps, and pricing logic.
- **Code playgrounds and learning tools** — sandboxed execution with no host access.

The best fit is small or medium programs, an ES5.1-compatible feature set, repeated execution, and a narrow host API:

```text
modern source -> Babel/SWC -> ES5.1 -> sablejs AOT -> browser bundle -> dedicated Worker
                                                                       | explicit messages only
                                                                       v
                                                                  application UI
```

## Quick start

Compile an ES5.1 program — a script with no imports that returns its result as the final expression — then create an instance and run it:

```js
const fs = require("node:fs");
const { compile } = require("sablejs");
const generated = compile("({ total: input.price * 1.2 });");
fs.writeFileSync("program.cjs", generated.code);
```

```js
const program = require("./program.cjs");
const instance = program.createInstance({
  globals: { input: { price: 100 } },
});

try {
  console.log(instance.run()); // { total: 120 } — synchronous, returns the value
} finally {
  instance.dispose();
}
```

The default `security: "sandbox"` mode recursively copies plain `globals` data, so guest mutations do not reach the host object graph. One `instance.run()` call executes the program; instances are single-run and meant to be disposed.

## Calling program functions

End the program with a function expression and `run()` returns a callable. Call it with plain data — arguments and the receiver are copied like `globals`, so guest mutations cannot reach host objects:

```js
const program = require("./program.cjs");
// program source: "function price(input) { return { total: input.price * 1.2 }; } price;"
const instance = program.createInstance({ globals: {} });
const price = instance.run();      // synchronous — returns the callable
price({ price: 100 });             // { total: 120 } — synchronous call
instance.dispose();
```

Guest functions keep reference semantics between their own frames; only host-initiated calls copy. Alternatively, pass the arguments through the `input` global and call once per run:

```js
// program source: "function price(input) { return { total: input.price * 1.2 }; } price(input);"
const instance = program.createInstance({ globals: { input: { price: 100 } } });
instance.run();                    // { total: 120 } — synchronous
```

## Exposing host operations: capability()

Sandbox programs cannot touch host functions or ambient objects. Expose exactly the operations they need as capabilities:

```js
const { capability } = require("sablejs");

const instance = program.createInstance({
  globals: {
    input: { price: 100 },
    save: capability(async function (record) {
      const response = await fetch("/api/records", {
        method: "POST",
        body: JSON.stringify(record),
      });
      return { saved: response.ok };
    }, { name: "save" }),
  },
});
```

Capability arguments and results are copied, thrown errors are sanitized, and wrappers are revoked after `instance.dispose()`. For fully trusted integrations that need reference identity and the lowest overhead, compile with `security: "trusted"` — this restores raw `globals` pass-through.

## Isolating CPU and memory: the Worker

The language boundary does not stop infinite loops or memory exhaustion. Run each program in a dedicated Worker and terminate it when it exceeds its budget. `sablejs/worker` packages the two pieces:

```js
// sandbox.worker.js — worker side
require("sablejs/worker").handleSandboxMessages(program);
```

```js
// host side — worker calls are asynchronous
const { createSandboxClient } = require("sablejs/worker");
const sandbox = createSandboxClient(new Worker("/sandbox.worker.js"), { timeoutMs: 1000 });
await sandbox.run({ price: 100 }); // { total: 120 }
await sandbox.evaluate(artifactCode, { price: 100 });
```

`run` and `evaluate` return promises (a message round-trip), unlike the in-process `instance.run()` above, which is synchronous. Per-run timeouts terminate the Worker, responses are validated, and each message runs a fresh instance — the worker survives many calls. The full build pipeline (Babel downlevel, esbuild bundling) and size budgets are in [Worker isolation](docs/worker-isolation.md). Do not place secrets in client-side bundles.

## Sandbox semantics

ES5.1 defines ECMAScript built-ins, not a universal set of browser or application host objects. Availability therefore follows these rules:

| Category | sandbox behavior |
| --- | --- |
| ES5.1 built-ins | `Object`, `Array`, strings, numbers, `Math`, `Date`, `RegExp`, errors, `JSON`, and URI/number helpers are available through protected intrinsics. Static `Function` source can be AOT-compiled; runtime-generated source and global `eval` are unavailable. |
| Newer ECMAScript built-ins | Typed arrays, `Map`, `Set`, `Promise`, `Symbol`, `BigInt`, `Reflect`, `Proxy`, `Atomics`, `WeakRef`, and `Intl` are available when the host implements them. Shared intrinsic mutation remains blocked. |
| Injected data | Primitives, plain objects, arrays, `Date`, `RegExp`, buffers/views, `Map`, `Set`, and sanitized errors are copied into the guest. |
| Host/platform objects | `window`, `document`, DOM nodes, `Response`, `File`, `WebSocket`, Figma APIs, Node `process`/`fs`, and class instances are not injected directly. Expose narrow operations with `capability()` and return plain data. |

`Proxy` is available when the host implements it, under a reviewed policy: the guest may wrap its own objects, wrapping protected intrinsics is blocked, and trap bodies execute as guest code with mediated entries (see [Security](docs/security.md)). If your guest does not need `Proxy`, treat it like any other optional intrinsic and keep its host availability in mind when reviewing the surface you expose.

`security: "trusted"` can use arbitrary host objects by reference, including their methods, accessors, and prototype chains. Use it only when the compiled program is fully trusted. The threat model, policies, and audit record are in [Security](docs/security.md).

## ES5.1 core and Babel downlevel

The ES5.1 core is a deliberate, stable surface: small enough to keep the security boundary auditable and the compiler maintainable. Modern source should be downleveled with Babel or SWC before compilation — **Babel lowers syntax; sablejs controls execution**. Modern built-ins the host already implements (`Map`, `Set`, `Promise`, typed arrays, `Intl`) are exposed as optional intrinsics; features that would expand the language surface (Proxy semantics beyond the guest, module loaders, generator/async runtimes) are intentionally not added natively. See the [Roadmap](docs/roadmap.md) for what is planned and what is deliberately out of scope.

## Compatibility

| Surface | Current contract |
| --- | --- |
| Source | ES5.1; direct static `eval` and `Function` inputs are compiled ahead of time |
| Output | CommonJS; bundle with esbuild for browsers |
| Security | `sandbox` by default; explicit `trusted` pass-through mode |
| Browsers | Chromium, Firefox, WebKit; main thread and Worker E2E |
| Other hosts | Node 24, Deno 2, Bun |
| Conformance | Test262 pinned to `3655e7464de3d52643ecddd4b5f9f4f3e7f62398` |

Optional globals such as typed arrays, `Map`, `Promise`, and `Intl` follow host availability.

## Performance

Three-run medians on the Linux x64 reference machine (methodology, exclusions, and variance: [Performance](docs/performance.md)):

| Backend | V8 Benchmark Suite 7 score | vs sandbox |
| --- | ---: | ---: |
| sablejs O2 sandbox | 1,395 | — |
| sablejs O2 trusted | 2,070 | 1.48x |
| QuickJS-WASM 0.32.0 | 1,083 | 0.78x |

| Suite | sablejs trusted | sablejs sandbox | QuickJS-WASM |
| --- | ---: | ---: | ---: |
| Octane 2.0 geometric score | 2,205 | 1,772 | 1,413 |
| SunSpider 1.0 total (23 tests, ms) | 302.9 | 482.3 | 619.0 |
| Kraken 1.1 total (14 tests, ms) | 6,094.2 | 20,829.8 | 22,402.1 |

Sandbox retains 67.4% of trusted throughput on V8 Benchmark Suite 7 under this harness, and beats QuickJS-WASM on all eight real-world workloads. These numbers characterize this benchmark and harness, not universal application performance. A 137 KB benchmark source compiles to a 571 KB minified sandbox bundle — 82 KB gzipped.

## Security

An internal boundary audit completed on 2026-08-22 found no known usable escape within the tested threat model — no host-code execution and no host-object-graph access through the reviewed paths. The adversarial battery of 100+ probes runs across the O0/O1/O2/Os optimization levels (110 tests, 0 skipped), and a differential fuzzer compares sablejs against native V8 and QuickJS on generated programs. Security depends on the combination: `sandbox` mode + a dedicated Worker + narrow capabilities + correct host integration. Threat model, trust boundaries, and policies: [Security](docs/security.md).

## Documentation

[Architecture](docs/architecture.md) · [Performance](docs/performance.md) · [Security](docs/security.md) · [Worker isolation](docs/worker-isolation.md) · [Roadmap](docs/roadmap.md)

## Development

```sh
npm ci
npm test                        # unit + adversarial battery
npm run test:e2e:build && npm run test:e2e:node
npm run benchmark:smoke
```

Semantic changes must also pass the pinned Test262 gate, and performance changes use three measured runs — both command lists are in [Architecture](docs/architecture.md) (Verification) and [Performance](docs/performance.md) (Reproduction). Keep dependencies directed through `frontend -> ir -> backend -> compiler -> runtime`, add focused regression tests, and update the concise English documentation. The repository uses `package-lock.json` as its only lockfile.

## License

[Apache-2.0](LICENSE)
