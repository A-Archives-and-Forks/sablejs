# Performance

Higher scores are better. Results below were collected on Linux x64 with Node.js 24.14.0, V8 13.6, an Intel Core i5-12400F, and `quickjs-emscripten` 0.32.0.

## V8 Benchmark Suite 7

Three complete measured runs were used for each backend. The v1 column is a migration baseline captured immediately before the v1 runtime was removed; it is not part of the current repository. The sandbox runner injects only a `print` capability. The benchmark source uses local deterministic-random and inheritance helpers because sandbox mode correctly rejects modifications to `Math`, `Object`, and their prototypes.

| Suite | v1 baseline | sandbox O2 | trusted O2 | QuickJS-WASM |
| --- | ---: | ---: | ---: | ---: |
| Richards | 162 | 835 | 1,158 | 932 |
| Crypto | 198 | 3,593 | 7,200 | 936 |
| RayTrace | 371 | 384 | 444 | 1,226 |
| NavierStokes | 266 | 5,092 | 10,726 | 1,549 |
| DeltaBlue | 174 | 946 | 1,184 | 958 |
| **Geometric score** | **224** | **1,395** | **2,070** | **1,083** |

Full-suite scores were:

- sablejs O2 sandbox: 1,186, 1,395, 1,423 (median 1,395).
- sablejs O2 trusted: 1,745, 2,070, 2,195 (median 2,070).
- QuickJS-WASM: 1,052, 1,083, 1,104 (median 1,083).

Sandbox retains 67.4% of trusted throughput, is 6.23x the removed v1 baseline, and is 1.29x the QuickJS-WASM reference. Property and call guards are kept on optimized locals; only prototype-sensitive reads and host crossings use the full boundary.

### Boundary profile

`benchmark/run.js --profile-boundary` (or `createInstance({ profileBoundary: true })`) counts the boundary hot paths per suite. Scores fluctuate with machine state; the counts identify where the sandbox tax lands:

| Suite | boundary.calls | guest calls | host calls | constructs | writeTargets | mediated gets | wrapper creations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Richards | 18.6M | 18.6M | 148 | 14k | 23.7M | 206 | 0 |
| Crypto | 12.0M | 9.6M | 2.4M | 52k | 108.2M | 352 | 0 |
| RayTrace | 6.7M | 3.4M | 3.2M | 2.8M | 9.9M | 2.7M | 0 |
| NavierStokes | 8.4k | 8.1k | 276 | 247 | 65.1M | 206 | 0 |
| DeltaBlue | 37.1M | 35.7M | 1.4M | 734k | 7.2M | 194k | 64.5k |

- **NavierStokes and Crypto are write-guard dominated** (65M/108M `writeTarget` resolutions). Their tax is the per-write target resolution and mutability assertion, not call mediation. The local-safe IR distinction shipped (guest-provenance write fast path, below), but on these suites it currently fires only on one-time setup writes: their hot loops write `this`-targeted fields and `new` results, which are the next levers (constructor-is-guest-function provenance).
- **Richards and DeltaBlue are call-dispatch dominated** (19M/37M guest calls). The tax is the guest-first dispatch plus the entry counter; argument copies and wrapper creations are negligible.
- **RayTrace is host-call and construction heavy** (3.2M host calls into `Math` intrinsics, 2.8M constructions) with 2.7M prototype-sensitive reads.
- DeltaBlue's 64.5k wrapper creations come from host functions first delivered through mediated reads; wrapper reuse keeps this a one-time cost.

### Boundary fast paths (2026-08-22)

Two boundary hot paths were profiled and specialized without changing sandbox semantics:

- **Pure-intrinsic call fast path.** Intrinsics that appear in no guard set (`MUTATES_ARGUMENT_ZERO`, `MUTATES_RECEIVER`, `INSPECTS_ARGUMENT_ZERO`, the `Function.prototype.call/apply/bind` and `Reflect.apply/construct` rewrites, `Error.captureStackTrace`, `Function.prototype.toString`) skip the per-call argument and receiver inspections. Classification is computed lazily per target and cached in a `WeakMap`; a monomorphic identity cache in `boundary.call` lets single-intrinsic loops skip dispatch entirely. Guarded targets keep the full checks.
- **Shared intrinsic graph.** The protected-intrinsic graph walk consumed ~48% of `createInstance` time and is now captured once and shared by every instance: sandbox `createInstance` + `dispose` dropped from 387 µs to 33.6 µs (trusted is 23.2 µs). Contract: the host must not extend intrinsic prototypes after the first instance is created (see [Security](security.md)).

- **Guest-provenance write fast path** (the local-safe IR distinction, v1). The O2/Os provenance pass (`src/backend/guest-provenance.js`, after the last SSA pass) proves which GETLOCAL outputs are guest-created — object/array/regexp literals, closures, and AND-meet phi joins — and marks them on the HIR. Sandbox `SETPROP`/`SETPROP_S` into a provably guest target lower to a slim `$setGuest` helper: `setSandboxPropertyValue` minus `writeTarget`, keeping `secureValue` on function values and strict/sloppy writer dispatch. Marked ⇒ guest-created ⇒ never a wrapper, capability token, or protected intrinsic, so `writeTarget` would be a no-op; nothing unmarked takes the fast path, and value-side handling is byte-identical between the two paths. Coverage on the V8 suite: 36 fast-path sites in the whole-suite compile, all one-time setup writes (harness config, class enums, `Klass.prototype = ...`); the write-dominated suites' hot loops write `this`-targeted fields and `new` results. Regression evidence: with the fast path disabled, the `writeTargets`/`calls` boundary-counter ratios for Crypto, RayTrace, and DeltaBlue are identical to 4 significant digits (A/B over adaptive-iteration runs); re-measured sandbox median 1,387 vs the documented 1,395 and trusted 2,226 vs 2,070, both inside the documented sample spreads; `benchmark:smoke` green; adversarial `security.test.js` cases at all four optimization levels plus both differential smokes (2,300 generated programs, zero mismatches/failures) pin that unmarked writes (intrinsics, capability tokens, globals, parameters) stay on the guarded path.

These changes took the Octane sandbox geometric score from 1,613 to 1,772, the Kraken sandbox total from 28.6 s to 20.8 s, and every real-world workload above the QuickJS-WASM reference (below).

## Compiled size by optimization level

The input is the same 137.1 KB V8 Benchmark Suite 7 source. Generated CJS excludes the external runtime. Minified browser IIFE figures bundle the runtime with esbuild 0.28.2 — `npm run benchmark:size` reproduces every number, and the same script gates CI on the recorded budgets (`--check`, +5% tolerance). All bytes are deterministic for pinned tool versions.

| Level | Sandbox CJS | Sandbox min IIFE | Trusted CJS | Trusted min IIFE |
| --- | ---: | ---: | ---: | ---: |
| O0 | 834.0 KB | 589.7 KB | 834.0 KB | 589.7 KB |
| O1 | 824.9 KB | 582.9 KB | 824.9 KB | 582.9 KB |
| O2 | 1,225.7 KB | 593.4 KB | 1,062.0 KB | 501.2 KB |
| Os | 617.1 KB | 360.9 KB | 565.5 KB | 337.4 KB |

O2 sandbox is +3.9% minified versus the 2026-08-21 record (571.2 KB): the boundary fast paths (shared intrinsic graph, pure-intrinsic call fast path, guest-object write helper) grew the runtime and guards; raw CJS is +0.9% (1,214.3 KB). Os selects shared factories and remains the smallest sandbox artifact.

### Factory strategies and the size/score Pareto

The compiler's size optimizer chooses per-scope vs shared frame factories per level (raw CJS bytes):

| Level × security | per-scope | shared | winner |
| --- | ---: | ---: | ---: |
| Sandbox O2 | 1,225.7 KB | 789.5 KB | per-scope (+55% — the deliberate speed-for-size trade) |
| Sandbox Os | 1,053.4 KB | 617.1 KB | shared |
| Trusted O2 | 1,062.0 KB | 728.2 KB | per-scope (+46%) |
| Trusted Os | 899.4 KB | 565.5 KB | shared |

The O2 per-scope premium buys throughput: V8 Benchmark Suite 7 sandbox scores by level (single runs, same harness):

| Level | Sandbox score | Sandbox min IIFE |
| --- | ---: | ---: |
| O0 | 25.5 | 589.7 KB |
| O1 | 26.3 | 582.9 KB |
| O2 | 1,387 (median) | 593.4 KB |
| Os | 884 | 360.9 KB |

The per-scope choice at O2 is the right trade: the same suite with shared factories scores 1,035 (single run) — +34% throughput for +55% raw CJS. Os keeps shared factories and still lands at 884, i.e. O2's other optimizations buy +17% over Os at 3.9x the min-IIFE delta. Factory safe-sharing — emitting a shared factory only when frame layouts are provably identical — is the next size lever: it could recover most of the O2 premium for scopes whose frames happen to match, without the score loss of forcing all-shared.

## Source vs compiled artifact on the wire

Gzip is level 9, minification by esbuild 0.28.2. The compiled IIFE figures bundle the external runtime.

| Artifact | Raw | Minified | Minified gzip |
| --- | ---: | ---: | ---: |
| benchmark source (`v8-suite.js`) | 137.1 KB | 57.4 KB | 18.1 KB |
| compiled sandbox O2 (CJS, no runtime) | 1,225.7 KB | 524.9 KB | 56.4 KB |
| compiled sandbox O2 (IIFE + runtime) | 593.4 KB | 593.4 KB | 81.5 KB |
| compiled trusted O2 (IIFE + runtime) | 501.2 KB | 501.2 KB | 75.2 KB |

The deployable sandbox artifact costs about 63 KB gzipped over the minified source: AOT compilation removes the parser and dispatch loop from the client, but the generated code, guards, and runtime remain. Os narrows this further for size-sensitive deployments (sandbox Os IIFE 360.9 KB, 58.8 KB gzipped).

## Octane 2.0 applicable subset

Octane is pinned to final revision `570ad1ccfe86e3eecba0636c8f932ac08edec517`. Only suites that do not require runtime-generated source are included. The sandbox runner rewrites the three shared-intrinsic mutations in the octane sources (deterministic `Math.random`, RayTrace's `Object.extend`, DeltaBlue's `Object.prototype.inheritsFrom`) into guest-local helpers, mirroring the V8 benchmark suite's adaptation. QuickJS runs the untransformed sources.

| Suite | sablejs O2 trusted | sablejs O2 sandbox | QuickJS-WASM |
| --- | ---: | ---: | ---: |
| Richards | 110 | 858 | 899 |
| DeltaBlue | 1,346 | 1,013 | 977 |
| Crypto | 7,685 | 3,506 | 891 |
| RayTrace | 460 | 252 | 1,175 |
| RegExp | 5,096 | 2,414 | 237 |
| Splay | 1,752 | 1,376 | 2,670 |
| NavierStokes | 11,901 | 4,683 | 1,507 |
| Box2D | 2,861 | 2,230 | 3,329 |
| **Geometric score** | **2,205** | **1,772** | **1,413** |

Sandbox retains 80.4% of trusted throughput on the Octane subset and scores 1.25x QuickJS-WASM. All generated scopes used structured or straight-line codegen (`fallbackScopes=0`). Octane figures are single measured runs; the other suites below use three-sample medians.

## SunSpider 1.0 subset

SunSpider is pinned from the `Action-Kamen/JavaScript-Benchmarks` mirror (`benchmark_suites/sunspider-1.0`). Three tests that extend shared intrinsics (`date-format-tofte`, `date-format-xparb`, `string-tagcloud`) are excluded from every backend so all three compare the same 23-test subset. Lower totals are better; medians of three samples.

| Backend | Total (23 tests) |
| --- | ---: |
| sablejs O2 trusted | 302.9 ms |
| sablejs O2 sandbox | 482.3 ms |
| QuickJS-WASM | 619.0 ms |

Sandbox runs at 62.8% of trusted throughput and 1.28x QuickJS-WASM. Trusted mode passes all 23 tests; the `$v1_30` temporary-scoping bug that failed `string-unpack-code` was fixed by a `temporaryRegions` visibility check (see [Roadmap](roadmap.md), Recent fixes).

## Kraken 1.1 subset

Kraken is pinned from `mozilla/krakenbenchmark.mozilla.org` (`tests/kraken-1.1`). The full LIST runs on every backend: the giant ~1.8 MB imaging literals previously hit quadratic table dedup, a quadratic SCCP result scan, O2 const-scope overflow, and 47 MB generated code per test; all four are fixed and the codegen now folds constant literal-array chains into native literals (~1.8 MB output per test). `ai-astar`'s `Array.prototype` helpers are lowered to local functions for every backend, like the Octane adaptations. Lower totals are better; single measured runs.

| Backend | Total (14 tests) |
| --- | ---: |
| sablejs O2 trusted | 6,094.2 ms |
| sablejs O2 sandbox | 20,829.8 ms |
| QuickJS-WASM | 22,402.1 ms |

Sandbox runs at 29.3% of trusted throughput and 1.08x QuickJS-WASM on the Kraken subset. The imaging tests dominate the sandbox total: their per-pixel property writes pay the boundary write guard on every element, which is exactly the cost the sandbox tax section tracks on the V8 suite. The pure-intrinsic call fast path took the sandbox total from 28.6 s to 20.8 s.

## Real-world workloads

Eight self-contained ES5.1 workloads (`benchmark/workloads/`) model the product scenarios in the README: data transforms, pricing rules, form validation, spreadsheet formulas, workflow rules, template rendering, event aggregation, and a small parser. Each embeds a deterministic input and returns a value that all four backends must agree on; `benchmark/workloads.js` runs them with 300 timed iterations per workload. Ops/sec, higher is better. Native is the raw V8 ceiling and is not a security alternative.

| Workload | sablejs sandbox | sablejs trusted | QuickJS-WASM | native V8 |
| --- | ---: | ---: | ---: | ---: |
| json-transform | 233 | 259 | 245 | 16,377 |
| pricing-rules | 245 | 267 | 147 | 4,697 |
| form-validator | 22,114 | 31,147 | 16,469 | 1,327,580 |
| spreadsheet-formulas | 7,033 | 8,447 | 3,315 | 44,057 |
| workflow-rules | 4,749 | 5,203 | 2,552 | 244,789 |
| template-logic | 12,522 | 12,461 | 10,012 | 291,445 |
| data-aggregation | 70 | 76 | 63 | 5,453 |
| mini-parser | 11,165 | 14,441 | 10,293 | 298,478 |

Sandbox now beats QuickJS-WASM on every workload: the string- and regex-heavy ones (form-validator, template-logic, mini-parser) were call-mediation dominated and gained 5–9x from the pure-intrinsic fast path, while form-validator additionally paid the per-instance graph walk (its 12 boundary calls per run are dwarfed by `createInstance`). Template-logic reaches trusted parity; the remaining sandbox tax on the rest is 8–29% (per-instance boundary setup, the mandated `globals` copy, and per-call dispatch). These workloads double as a lightweight differential check: a backend whose result diverges from the trusted reference fails the run.

## Reproduction

```sh
npm ci
npm run benchmark:release -- --samples=3
npm run benchmark
npm run benchmark -- --security=sandbox
npm run upstream:fetch -- octane sunspider kraken
npm run benchmark:octane -- --suite=Richards,DeltaBlue,Crypto,RayTrace,RegExp,Splay,NavierStokes,Box2D
npm run benchmark:octane -- --backend=quickjs
npm run benchmark:sunspider -- --backend=sablejs-sandbox --samples=3
npm run benchmark:kraken -- --backend=quickjs --samples=3
npm run benchmark:workloads -- --backend=sablejs-sandbox
npm run benchmark:workloads -- --backend=native
npm run benchmark:workloads -- --backend=sablejs-sandbox --profile-boundary
```

`benchmark:release` defaults to three measured runs for `sablejs-sandbox`, `sablejs-trusted`, and `quickjs`. Use `--backend=sablejs-sandbox` to isolate one backend. The SunSpider/Kraken drivers accept `--backend=sablejs-sandbox|sablejs-trusted|quickjs`, `--samples=N`, and `--suite=a,b` filters; each test is compiled once per backend and samples re-run the same program. The workloads driver accepts `--workload=name`, `--iterations=N`, and `--profile-boundary` (accumulated per-workload boundary counters). QuickJS-WASM is a WASM interpreter reference, not native QuickJS or browser performance.
