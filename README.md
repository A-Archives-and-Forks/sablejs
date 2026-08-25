<h1 align="center">
  <img src="./logo.jpg" alt="sablejs" width="720">
</h1>

**A fast, debuggable AOT execution layer for user-authored and AI-generated JavaScript—without an embedded JavaScript VM.**

[![Ubuntu CI](https://github.com/ErosZy/sablejs/actions/workflows/ci.yml/badge.svg)](https://github.com/ErosZy/sablejs/actions/workflows/ci.yml)
[![npm beta](https://img.shields.io/npm/v/sablejs/beta?label=npm%20beta)](https://www.npmjs.com/package/sablejs)
[![License](https://img.shields.io/github/license/ErosZy/sablejs)](LICENSE)
[![Release](https://img.shields.io/github/v/release/ErosZy/sablejs)](https://github.com/ErosZy/sablejs/releases)

> sablejs was inspired by Figma's [journey to a WebAssembly-based plugin sandbox](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/) and its later use of the [QuickJS runtime](https://www.figma.com/plugin-docs/updates/2020/07/07/version-1-update-16/). As AI reshapes how software is built, sablejs is evolving around three goals:
>
> 1. **Fast by design.** AOT-compile guest code into host JavaScript instead of interpreting it inside an embedded VM.
> 2. **Built to be debugged.** Emit Source Map v3 mappings and expose generated code, HIR, and MIR for inspection.
> 3. **Built for AI-generated code.** Make generated programs easier to constrain, integrate, inspect, and test.

sablejs compiles ES5.1 guest programs into direct host JavaScript. In the default `sandbox` mode, guest code receives standard ECMAScript objects, copied data, and explicit capabilities—not ambient access to the host object graph or platform APIs. Modern syntax can be downleveled before compilation, and generated artifacts run in browsers, Workers, Node, Deno, and Bun.

[Get started](#quick-start) · [npm](https://www.npmjs.com/package/sablejs) · [Migrate from v1](docs/migration-v2.md) · [Compare approaches](docs/comparison.md) · [Browser example](examples/browser/) · [Worker example](examples/worker/) · [Performance](docs/performance.md) · [Security](docs/security.md)

## Why sablejs

- **Host-engine execution.** Precompiled programs run as direct JavaScript on the host engine; the normal `run()` path does not evaluate guest source at runtime.
- **No embedded JavaScript VM.** There is no interpreter binary to initialize or another VM layer to debug.
- **Explicit boundaries.** Sandbox globals are copied, host functions become revocable capabilities, and ambient platform APIs remain unavailable unless deliberately exposed.
- **Practical debugging.** Source maps, generated code, HIR, and MIR connect runtime failures back to guest programs.
- **Operational isolation.** Dedicated Worker support lets hosts enforce wall-clock timeouts around compute-only programs.

On the reference V8 Benchmark Suite 7 run, sablejs O2 sandbox scores **2,202**, compared with **1,181** for QuickJS-WASM 0.32.0. These are harness-specific results, not a universal performance claim; see the [methodology and full results](docs/performance.md).

## Use cases

- **AI-generated code**: run LLM-generated transforms, formulas, and automation logic behind explicit data and capability boundaries, with dedicated Worker isolation for compute-only programs.
- **User plugins**: execute user-defined extensions without exposing the host environment directly.
- **Rules and formulas**: power validators, pricing logic, workflows, and spreadsheet-like expressions.
- **Code playgrounds**: run interactive user code in a constrained browser environment.

```text
modern JS -> ES5.1 -> sablejs AOT -> Worker -> application
```

## Install

Install the published v2 beta from npm. The v2 series is currently under the
`beta` tag; `latest` remains on the v1 line until v2 goes stable.

```sh
npm install sablejs@beta
```

## Quick start

Compile an ES5.1 program — a script with no imports that returns its result as the final expression — then create an instance and run it:

```js
// build.cjs
const fs = require("node:fs");
const { compile } = require("sablejs");
const generated = compile("({ total: input.price * 1.2 });");
fs.writeFileSync("program.cjs", generated.code);
```

```js
// run.cjs
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

```sh
node build.cjs && node run.cjs
```

The default `security: "sandbox"` mode recursively copies plain `globals` data, so guest mutations do not reach the host object graph. One `instance.run()` call executes the program; instances are single-run and meant to be disposed.

## Examples

- [Node quick start, errors, and guest functions](examples/node/)
- [Browser bundle with inline source maps](examples/browser/)
- [Worker isolation and timeouts](examples/worker/)
- [Build-time precompilation](examples/precompile/)
- [Compiled-artifact caching](examples/caching/)
- [Deno](examples/deno/) and [Bun](examples/bun/)
- [All examples and expected output](examples/README.md)

Modern JavaScript should be downleveled with Babel or SWC before compilation.
Browser artifacts can then be bundled with tools such as esbuild; the browser
and Worker examples show the complete pipeline.

## TypeScript

sablejs ships TypeScript declarations (`types/`), wired through the package
`exports` map's `types` condition for `sablejs`, `sablejs/runtime`, and
`sablejs/worker`. All public options — including capability and source-map
settings — are typed, and the type-check gate (`npm run check:types`) pins
both CJS and ESM consumers against the declarations:

```ts
import { compile } from "sablejs";
import type { CompileOptions, CompileResult, SourceMapSettings } from "sablejs";

const options: CompileOptions = {
  optimization: "O2",
  security: "sandbox",
  sourceMap: { mode: "external", sourceFile: "rules/input.js" },
};
const result: CompileResult = compile(source, options);
```

The generated artifact can be typed with the exported `CompiledProgram`
shape: `program.createInstance({ globals })` returns a single-run
`RuntimeInstance`. In sandbox mode, `globals` may carry any host function —
it becomes a capability automatically — and `capability(fn, options)` returns
an opaque `CapabilityToken` type. The worker client (`sablejs/worker`) is
typed over a structural `SandboxWorker`, which the browser `Worker` satisfies
directly and Node's `worker_threads.Worker` satisfies through a small adapter
(see `examples/worker/host.cjs`).

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

## Debugging generated code: source maps

`compile()` can emit a deterministic Source Map v3 for the generated CommonJS,
mapping every statement's generated code back to the original guest source.
Opt in with `sourceMap`:

| `sourceMap` value | meaning |
| --- | --- |
| `true` | external map with logical defaults: `sourceFile: "<sablejs-input>"`, `generatedFile: "generated.cjs"` |
| `"external"` | same as `true` |
| `"inline"` | same names, but the map is base64-embedded as a `//# sourceMappingURL=data:...` comment |
| `{ mode, sourceFile, generatedFile, sourceMapURL, sourcesContent }` | full control (see below) |

```js
const result = compile(source, {
  sourceMap: {
    mode: "external",               // "external" | "inline"
    sourceFile: "rules/input.js",   // logical path; never inferred from cwd
    generatedFile: "rules.cjs",     // becomes `file` in the v3 map
    sourceMapURL: "rules.cjs.map",  // optional; appended only in external mode
    sourcesContent: false,          // opt in to embedding the guest source
  },
});
// result.map   — serialized Source Map v3 JSON (undefined when disabled)
// result.code  — inline mode appends the data URL comment
// result.metadata.sourceMap — the normalized settings
```

The mapping contract is statement-level at every optimization level: folded
constants, native literals, and structured-control-flow scaffolding inherit
the statement containing them. Nested lexical function bodies map to their own
lines. Static `eval` and `Function("...")` bodies map to virtual sources named
`<sourceFile>#eval-N` / `#dynamic-N` with their own line/column offsets
(strict-mode eval prefixes and the `_dynamic_*` wrapper are translated away;
runtime-dynamic `eval(value)` has no statically knowable source and stays
unmapped). `names` is empty, no absolute path ever appears, and
`sourcesContent` is omitted unless requested. With `dumpDir`, inspection also
writes `code.js.map` and the dumped `code.js` references it by relative URL.

Maps are consumed by the engine or build tool, not by sablejs: written next to
the artifact and loaded with Node's `--enable-source-maps`, an external map
remaps uncaught `$exec*` frames back to the guest filename and statement line
(covered end-to-end in `test/unit/source-map-e2e.test.js`), and the browser
bundle emits and runs inline-mapped artifacts in-page
(`test/e2e/browser.test.js`).

Source maps are invisible to the default build: with `sourceMap` unset (or
`false`), generated code, statistics, and runtime behavior are byte-for-byte
unchanged, and the marker-free size model keeps Os candidate selection
identical. Maps are for debugging and build-tool integration — sablejs does
not rewrite stacks, and sandbox-boundary errors keep their stacks deleted
regardless. Full design in [docs/source-maps.md](docs/source-maps.md).

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

`evaluate()` accepts compiler-produced artifacts, not arbitrary guest source.
The default loader uses `new Function` at Worker privilege, so only evaluate
artifacts the host trusts.

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

Results from the Linux x64 reference machine are shown below. V8 Benchmark
Suite 7 and SunSpider use three-run medians; Octane and Kraken are single
measured runs. See [Performance](docs/performance.md) for methodology,
exclusions, and variance.

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
- [Choosing an execution model](docs/comparison.md)
- [Compatibility](docs/compatibility.md)
- [Fuel budgets — research design, not implemented](docs/fuel-budget.md)
- [Migrating from v1 to v2](docs/migration-v2.md)
- [Performance](docs/performance.md)
- [Security](docs/security.md)
- [Source maps](docs/source-maps.md)
- [Worker isolation](docs/worker-isolation.md)
- [Roadmap](docs/roadmap.md)
- [Changelog](CHANGELOG.md)

## Development

### Build from source

```sh
git clone https://github.com/ErosZy/sablejs.git
cd sablejs
npm ci
npm run build
```

`npm run build` creates the publishable single-file artifacts in `dist/`:

| artifact | description |
| --- | --- |
| `dist/runtime.js` | standalone runtime only, for Worker and browser use |
| `dist/compiler.js` | compiler, runtime, and Worker helpers |

`npm publish` runs the build automatically via `prepublishOnly`.

### Verification

```sh
npm ci
npm test # unit + adversarial battery
npm run check:types # TypeScript declarations, CJS and ESM consumers
npm run check:examples # every example runs and produces its documented output
npm run test:e2e:build && npm run test:e2e:node
npm run benchmark:smoke
npm run benchmark:size # artifact sizes; --check enforces the CI budgets
npm run build && npm run check:compliance # bundles + third-party notices
```

Semantic changes must also pass the pinned Test262 gate, and performance changes use three measured runs — both command lists are in [Architecture](docs/architecture.md) (Verification) and [Performance](docs/performance.md) (Reproduction). Keep dependencies directed through `frontend -> ir -> backend -> compiler -> runtime`, add focused regression tests, and update the concise English documentation. The repository uses `package-lock.json` as its only lockfile.

### Releasing

Bump the version in `package.json` (sync `package-lock.json` too), push to master, and wait for Ubuntu CI to go green. Then tag the release and push the tag:

```sh
version=$(node -p '"v" + require("./package.json").version')
git tag "$version" && git push origin "$version"
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
