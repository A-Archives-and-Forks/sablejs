![LOGO](./logo.jpg)

[![Ubuntu CI](https://github.com/ErosZy/sablejs/actions/workflows/ci.yml/badge.svg)](https://github.com/ErosZy/sablejs/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/ErosZy/sablejs)](LICENSE)
[![Release](https://img.shields.io/github/v/release/ErosZy/sablejs)](https://github.com/ErosZy/sablejs/releases)

sablejs is a **small AOT-compiled execution layer** for running **user-authored and AI-generated JavaScript** in browsers. Guest code gets **standard ECMAScript objects, copied data, and explicit capabilities** — not ambient access to the host object graph or platform APIs. It is built for **rules, plugins, formulas, and other untrusted logic**.

## Why sablejs

sablejs AOT-compiles untrusted JavaScript into direct host JavaScript while limiting guest access to **standard ECMAScript objects, copied data, and explicit capabilities**.

- The normal precompiled `run()` path does not evaluate guest source at
  runtime. The optional trusted-artifact `worker.evaluate()` loader uses
  `new Function` at Worker privilege and is documented separately.
- No ambient browser APIs. 
- No embedded JavaScript VM.

## Use cases

- **AI-generated code**: safely run LLM-generated transforms, formulas, and automation logic.
- **User plugins**: execute user-defined extensions without exposing the host environment directly.
- **Rules and formulas**: power validators, pricing logic, workflows, and spreadsheet-like expressions.
- **Code playgrounds**: run interactive user code in a constrained browser environment.

```text
modern JS -> ES5.1 -> sablejs AOT -> Worker -> application
```

## Install and build

Install the published v2 beta from npm (currently `2.0.0-beta.4`; the v2
series is in beta, and `latest` still points at the v1 line until 2.0.0
goes stable):

```sh
npm install sablejs@beta
```

For the ES6+ downlevel and bundling step you also want `@babel/core`, `@babel/preset-env`, and `esbuild` as devDependencies.

### Build from source

```sh
git clone git@github.com:ErosZy/sablejs.git
cd sablejs
npm ci
npm run build
```

`npm run build` bundles the publishable single-file artifacts into `dist/`:

| artifact | description |
| --- | --- |
| `dist/runtime.js` | standalone runtime only (no compiler), for Worker and browser use |
| `dist/compiler.js` | full package bundle (compiler + runtime + worker helpers) |

`npm publish` runs the build automatically via `prepublishOnly`.

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
   // { total: 120 } — synchronous, returns the value
  console.log(instance.run());
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
// synchronous — returns the callable
const price = instance.run();
// { total: 120 } — synchronous call
price({ price: 100 });
instance.dispose();
```

Guest functions keep reference semantics between their own frames; only host-initiated calls copy. Alternatively, pass the arguments through the `input` global and call once per run:

```js
// program source: "function price(input) { return { total: input.price * 1.2 }; } price(input);"
const instance = program.createInstance({ globals: { input: { price: 100 } } });
// { total: 120 } — synchronous
instance.run();
```

## Inspecting the compiled program

`compile()` accepts inspection options for debugging generated code:

| option | effect |
| --- | --- |
| `dumpDir: "/path"` | writes `hir.txt` (optimized HIR, with pass annotations), `mir.txt` (SSA MIR: blocks, phis, operations), and `code.js` (generated CJS) into the directory |
| `includeHIR` / `includeMIR` | attach the HIR / MIR graph objects to the compile result |
| `dumpIR: "hir" \| "mir" \| "all"` | same, graph for the named forms only |
| `fs: { mkdirSync, writeFileSync, join }` | inspection-mode file adapter; defaults to Node's `fs`/`path`, lazily required. Browser bundles can pass an in-memory implementation (e.g. `memfs`) so `dumpDir` works without Node built-ins |

The dump is a side channel — the compile result is unchanged by `dumpDir`.

## Exposing host operations: capabilities

Sandbox programs cannot touch host functions or ambient objects. Any host function in `globals` becomes a capability automatically, so the same literal works in both security modes:

```js
const instance = program.createInstance({
  globals: {
    input: { price: 100 },
    save: async function (record) {
      const response = await fetch("/api/records", {
        method: "POST",
        body: JSON.stringify(record),
      });
      return { saved: response.ok };
    },
  },
});
```

In sandbox mode every host function found anywhere in `globals` (nested objects, arrays, `Map`/`Set` included) is wrapped as a capability: arguments and results are copied, thrown errors are sanitized, and the wrapper is revoked after `instance.dispose()`. The wrapper's name is the function's own `name`, else the property path it was found at, else `"capability"`; bare functions are called with no receiver, and only the function value crosses — its own properties do not.

Wrap explicitly with `capability()` when you need to control those details — a custom name, or `{ thisValue }` for functions that need a receiver:

```js
const save = capability(
  async function (record) {
    const response = await fetch("/api/records", {
      method: "POST",
      body: JSON.stringify(record),
    });
    return { saved: response.ok };
  },
  { name: "save", thisValue: api }
);
```

Explicit tokens work in both modes. In trusted mode, `globals` are passed through by reference and capability tokens are unwrapped back to the raw host functions, so one literal serves sandbox (copied data, mediated calls) and trusted (reference identity, lowest overhead) unchanged.

## Isolating execution: the Worker

The language boundary does not stop infinite loops or memory exhaustion. Run
each program in a dedicated Worker so the host can enforce a wall-clock
timeout and terminate the execution agent. Browser Workers do not expose a
portable hard memory limit; enforce input/output/source limits and use
host-specific memory controls where available. `sablejs/worker` packages the
two pieces:

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

`run` and `evaluate` return promises (a message round-trip), unlike the in-process `instance.run()` above, which is synchronous. Per-run timeouts terminate the Worker, responses are validated, and each message runs a fresh instance — the worker survives many calls. The message channel carries plain data only, so functions cannot cross it: capabilities are an in-process feature, and the Worker is for compute-only programs (see [Worker isolation](docs/worker-isolation.md) for injecting capabilities worker-side). The full build pipeline (Babel downlevel, esbuild bundling) and size budgets are in [Worker isolation](docs/worker-isolation.md). Do not place secrets in client-side bundles.

## Sandbox semantics

ES5.1 defines ECMAScript built-ins, not a universal set of browser or application host objects. Availability therefore follows these rules:

| Category | sandbox behavior |
| --- | --- |
| ES5.1 built-ins | `Object`, `Array`, strings, numbers, `Math`, `Date`, `RegExp`, errors, `JSON`, and URI/number helpers are available through protected intrinsics. Static `Function` source can be AOT-compiled; runtime-generated source and global `eval` are unavailable. |
| Newer ECMAScript built-ins | Typed arrays, `Map`, `Set`, `Promise`, `Symbol`, `BigInt`, `Reflect`, `Proxy`, `Atomics`, `WeakRef`, and `Intl` are available when the host implements them. Shared intrinsic mutation remains blocked. |
| Injected data | Primitives, plain objects, arrays, `Date`, `RegExp`, buffers/views, `Map`, `Set`, and sanitized errors are copied into the guest. Host functions are wrapped as capabilities. |
| Host/platform objects | `window`, `document`, DOM nodes, `Response`, `File`, `WebSocket`, Figma APIs, Node `process`/`fs`, and class instances are not injected directly. Expose narrow operations with `capability()` and return plain data. |

`Proxy` is available when the host implements it, under a reviewed policy: the guest may wrap its own objects, wrapping protected intrinsics is blocked, and trap bodies execute as guest code with mediated entries (see [Security](docs/security.md)). If your guest does not need `Proxy`, treat it like any other optional intrinsic and keep its host availability in mind when reviewing the surface you expose.

`security: "trusted"` can use arbitrary host objects by reference, including their methods, accessors, and prototype chains. Capability tokens in `globals` are unwrapped to their raw host functions, so the same `globals` literal works in both modes. Use it only when the compiled program is fully trusted. The threat model, policies, and audit record are in [Security](docs/security.md).

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

The conformance gate's corpus policy — which Test262 tests are eligible, which are excluded (the dynamic-code policy), which expectations are pinned to ES5.1, and how failures are A/B-attributed — is the contract in executable form: [Compatibility](docs/compatibility.md).

## Performance

Three-run medians on the Linux x64 reference machine (methodology, exclusions, and variance: [Performance](docs/performance.md)):

| Backend | V8 Benchmark Suite 7 score | vs sandbox |
| --- | ---: | ---: |
| sablejs O2 sandbox | 2,202 | — |
| sablejs O2 trusted | 2,783 | 1.26x |
| QuickJS-WASM 0.32.0 | 1,181 | 0.54x |

| Suite (direction) | sablejs trusted | sablejs sandbox | QuickJS-WASM |
| --- | ---: | ---: | ---: |
| Octane 2.0 geometric score (higher is better) | 2,674 | 2,088 | 1,472 |
| SunSpider 1.0 total, 23 tests (ms, lower is better) | 396.1 | 515.5 | 597.7 |
| Kraken 1.1 total, 14 tests (ms, lower is better) | 5,370.9 | 15,935.3 | 27,081.9 |

Sandbox retains 79.1% of trusted throughput on V8 Benchmark Suite 7 under this harness, and beats QuickJS-WASM on seven of the eight real-world workloads (mini-parser sits at parity). On SunSpider and Kraken the sandbox totals are also faster than the QuickJS-WASM reference (1.16x and 1.70x) — the sandbox tax shows as a reduction *relative to the fully trusted sablejs backend*, not as a loss to QuickJS. These numbers characterize this benchmark and harness, not universal application performance. A 137 KB benchmark source compiles to a 657 KB minified sandbox bundle (87.5 KB gzipped; the size-optimized `Os` level: 386 KB / 60.7 KB). Compiled bundle sizes are gated in CI — `npm run benchmark:size -- --check` fails any artifact that exceeds its recorded budget by 5%.

## Security

An internal boundary audit completed on 2026-08-22 found no known usable escape within the tested threat model — no host-code execution and no host-object-graph access through the reviewed paths. The adversarial battery of 100+ probes runs across the O0/O1/O2/Os optimization levels with zero skipped tests, including the boundary-internals sweep (wrapper and intrinsic enumeration, proxy-trap observation and steering) and the clone-shape sweep (sparse, huge, deep, exotic, Map/Set/typed-array identities), and a differential fuzzer compares sablejs against native V8 and QuickJS on generated programs. Security depends on the combination: `sandbox` mode + a dedicated Worker + narrow capabilities + correct host integration. Threat model, trust boundaries, disclosure process, and policies: [Security](docs/security.md) and [Security policy](SECURITY.md).

## Documentation

- [Architecture](docs/architecture.md) 
- [Compatibility](docs/compatibility.md) 
- [Fuel budgets](docs/fuel-budget.md) 
- [Performance](docs/performance.md) 
- [Security](docs/security.md) 
- [Worker isolation](docs/worker-isolation.md) 
- [Roadmap](docs/roadmap.md)

## Development

```sh
npm ci
npm test # unit + adversarial battery
npm run test:e2e:build && npm run test:e2e:node
npm run benchmark:smoke
npm run benchmark:size # artifact sizes; --check enforces the CI budgets
npm run build && npm run check:compliance # bundles + third-party notices
```

Semantic changes must also pass the pinned Test262 gate, and performance changes use three measured runs — both command lists are in [Architecture](docs/architecture.md) (Verification) and [Performance](docs/performance.md) (Reproduction). Keep dependencies directed through `frontend -> ir -> backend -> compiler -> runtime`, add focused regression tests, and update the concise English documentation. The repository uses `package-lock.json` as its only lockfile.

### Releasing

Bump the version in `package.json` (sync `package-lock.json` too), push to master, and wait for Ubuntu CI to go green. Then tag the release and push the tag:

```sh
git tag v2.0.0-beta.4 && git push origin v2.0.0-beta.4
```

The `release.yml` workflow requires the tag commit to be contained in
`master`, runs unit/adversarial, Test262, differential, size, performance,
Node/Deno/Bun, and browser gates under read-only permissions, verifies
third-party notices, and archives the Test262 report. Only the resulting
artifact is passed to a separate OIDC-enabled publish job, which publishes to
npm and creates the GitHub release. Versions containing a hyphen publish
under `beta`; stable versions publish as `latest`.

## License

[Apache-2.0](LICENSE). Licenses and copyright notices for dependencies bundled
into the single-file distribution are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
