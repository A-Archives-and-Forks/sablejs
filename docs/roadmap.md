# Roadmap

Status markers: ✅ Done · ◐ Partial · ⬜ Not started.
Priority principle: **security correctness > semantic correctness > real-world evidence > DX > performance > benchmark scores**.

Last updated 2026-08-22.

## Status summary

The 2026-08-22 top-10 priorities are all done:

1. ✅ `docs/security.md` + threat model established (component trust boundaries, object taxonomy, Proxy/Symbol/SAB/Atomics/Intl policies)
2. ✅ Audit findings 1/2/3 fixed; 6 skipped tests activated (110 tests, 0 skipped)
3. ✅ Two compiler bugs fixed: the `$v1_30` cross-block inline-guard reference (region-stack visibility checks) and the giant-literal scalability bug (four sub-issues: SCCP O(V²), frontend table dedup O(n²), O2 const-scope chunking, constant array-literal folding) — Kraken imaging restored, 14/14
4. ✅ Differential fuzzing: `test/differential/fuzz.js` (generator + three-engine comparison + failure saving + ddmin), 16,000 cases with zero mismatches
5. ✅ NavierStokes / Crypto sandbox-tax profile: `createInstance({ profileBoundary: true })` counters + `--profile-boundary` driver; five-suite table in [Performance](performance.md)
6. ✅ Sandbox-tax statistics automated in `benchmark/release.js` (`sandboxTax` JSON + table)
7. ✅ Real-world workloads: 8 ES5.1 workloads + four-backend driver (sandbox/trusted/quickjs/native) with cross-backend result verification
8. ✅ Worker helper: `sablejs/worker` (`createSandboxClient` / `handleSandboxMessages`, timeouts, termination, message validation) + [Worker isolation](worker-isolation.md)
9. ✅ README positioning (versus eval/iframe/QuickJS, ES5.1 core strategy)
10. ✅ ES5.1 strategy documented (README + [Security](security.md))

## Current snapshot (2026-08-22)

- **Security**: a full boundary audit ([Security](security.md), Historical audit record) found no usable escape; the adversarial regression battery lives in `test/unit/security.test.js` (127 tests, 0 skipped), now including the boundary-internals sweep and the clone-shape sweep (P0-S1–S4).
- **Performance**: V8 Benchmark Suite 7 sandbox 1,497, trusted 2,256 (2026-08-22 refresh); Octane/SunSpider/Kraken comparison system across sandbox/trusted/QuickJS in place; the sandbox beats QuickJS-WASM on all 8 real-world workloads after the boundary fast paths, plus the guest-provenance write fast path (local-safe IR distinction, 2026-08-22). Details in [Performance](performance.md).
- **Semantics**: the pinned Test262 gate passes; the 33 pre-existing failures were confirmed unrelated to this work by A/B comparison.

## Next priorities

1. ✅ **Local-safe IR distinction** (v1 shipped 2026-08-22) — the guest-object provenance pass proves which GETLOCAL outputs are guest-created (literals, closures, phi joins) and sandbox property writes to them skip `writeTarget` via the slim `$setGuest` helper, keeping `secureValue` + strict/sloppy dispatch. Security tests pin that unmarked writes (intrinsics, capability tokens, globals, parameters) stay on the guarded path byte-for-byte. The remaining write-guard levers — marking `new` results (constructor-is-guest-function proof) and `this`-targeted writes — are the next step (see P1 Sandbox tax).
2. **Facet fuzzing** — extend the differential fuzzer to parser / optimizer / sandbox boundary / capability serializer facets, add generated-code syntax validation, and a nightly campaign.
3. **Benchmark reporting automation** — automatically generate the performance markdown and archive benchmark JSON with environment info.

## Open work by priority

### P0 — Security

- ✅ Guest-invisible boundary markers: the `HOST_TARGET` symbol tag was removed entirely (audit finding 4) and replaced with a module-private WeakMap. The sweep (enumeration and introspection paths — `getOwnPropertySymbols`, `getOwnPropertyDescriptors`, `Reflect.ownKeys` — plus proxy-trap observation and trap-steering probes) pins that no boundary marker can be observed, forged, or recovered. Details in [Security](security.md), Historical audit record.
- ✅ Sandbox write-path TOCTOU analysis: `writeTarget` resolves and asserts in one trap-free pass; focused tests (trap steering, protected writes from inside traps) and documentation added.
- ✅ Boundary tests for sparse arrays, huge object graphs, deep nesting (100k levels, iterative clone), and exotic prototypes (null-prototype data, class instances, specials nested in plain data).
- ✅ `Map` / `Set` / typed arrays / Buffer focused boundary tests: key/member identity across the clone graph, cyclic containers, typed-array subclass stripping, DataView bytes, and guest→host round trips. Buffer clones arrive as plain `Uint8Array`.
- ◐ Dedicated security regression corpus directory (currently embedded in `security.test.js`; split when it grows).
- ✅ Proxy / Symbol / SharedArrayBuffer / Atomics / Intl policies are documented in [Security](security.md).

### P0 — Resource control

- ✅ Worker helper, timeouts, message validation, force termination: `sablejs/worker` + [Worker isolation](worker-isolation.md).
- ✅ Source-size / input-size / output-size budget examples ([Worker isolation](worker-isolation.md), Budgets beyond time).
- ✅ Research done (see entry below; implementation pending).
- ✅ Protection for long-blocking or infinite async capabilities: timeout-wrapper pattern documented ([Worker isolation](worker-isolation.md), Timeout-wrapping long or never-ending capabilities) — `Promise.race` wrapper for async capabilities (guest-visible sanitized timeout error, AbortSignal for real cancellation, wrapper timeout below worker `timeoutMs`), and the explicit rule that sync-blocking capabilities can only be enforced by the Worker timeout.
- ✅ Compile-time loop instrumentation and instruction/fuel budgets researched — design doc [fuel-budget.md](fuel-budget.md): `FUELCHECK` ops on natural-loop headers (from `cfg.loops`) + call sites, `host` classification so no pass can eliminate them, zero default-path cost, and the catch-retry hole with the uncatchable-sentinel fix in the `TRY`/`ENDTRY` catch lowering. Implementation pending (prototype + measurement first).

### P1 — Semantic correctness

- ✅ Pinned Test262 runs continuously (gate passes).
- ✅ Differential testing established (return value + exception name, 16,000 cases zero mismatches); finer observation surfaces (observable mutations, descriptors, enumeration order) belong to facet fuzzing.
- ✅ Archive Test262 pass/fail counts and failure lists per release (`npm run test262:archive` → `archives/test262/`, full failure list + environment stamp + `latest.json` pointer; a red gate still archives and still exits non-zero).
- ✅ The ES5.1-contract exclusion list is documented ([Compatibility](compatibility.md)): corpus selection (`es5id`), the token-based dynamic-code policy exclusion, the pinned ES5.1 expectation adjustments, the Babel downlevel path, and the native A/B failure attribution.

### P1 — Fuzzing

- ✅ Program generator, three-engine comparison, failure saving, ddmin minimization ([details](../test/differential/fuzz.js)); CI smoke: `npm run test:differential`.
- ✅ Sandbox-boundary facet fuzzer ([details](../test/differential/fuzz-boundary.js)): contract programs (plain data + capability calls) must agree with the native oracle across trusted/sandbox/QuickJS; proxy-crossing "exotic" cases get a relaxed classification; every compiled artifact is acorn-parsed for generated-code syntax. Found two real sandbox bugs (stack-exhaustion error corruption; raw receiver TypeErrors from Proxy-wrapped branded containers), both fixed with regressions in `test/unit/security.test.js`. CI smoke: `npm run test:differential:boundary`.
- ✅ Generated-code syntax validation (acorn over the compiled output, in the boundary facet fuzzer; any generated artifact that does not parse is saved and reported as a syntax failure).
- ⬜ Nightly full campaign (100k → million-scale differential cases).

### P1 — Benchmark system

- ✅ V8 Benchmark Suite 7 + Octane/SunSpider/Kraken, all pinned in `tools/upstreams.js`; three-backend comparison; median/MAD/min/max/p95 reporting; raw/minified/gzip size reporting; compile once + sample reuse per backend; machine/CPU/OS recorded in [Performance](performance.md).
- ⬜ Measured runs 3 → 10–20, warmup tuning.
- ⬜ Separate compile-time vs execution-time reporting, cold start vs warm throughput.
- ⬜ Peak memory reporting.
- ⬜ Automated Performance Markdown generation + benchmark JSON and environment archiving.

### P1 — Sandbox tax

- ✅ Tax formula automated in `benchmark/release.js`; NavierStokes/Crypto profiled (write-guard dominated) and Richards/DeltaBlue/RayTrace profiled (call/construct dominated).
- ✅ Pure-intrinsic call fast path + shared intrinsic graph (2026-08-22): call-heavy workloads gained 3–9x and now beat QuickJS-WASM across the board; `createInstance` dropped from 387 µs to 33.6 µs.
- ✅ Guest-provenance write fast path (2026-08-22, the local-safe IR distinction v1): O2/Os provenance pass after the last SSA pass marks GETLOCAL outputs that are provably guest-created; sandbox `SETPROP`/`SETPROP_S` into them lower to a slim `$setGuest` helper (sandbox write minus `writeTarget`; `secureValue` and strict/sloppy writer dispatch kept). Marked ⇒ guest-created ⇒ never a wrapper, capability token, or protected intrinsic ⇒ `writeTarget` provably a no-op. On the V8 suite the 36 fast-path sites are all one-time setup writes (harness config, class enums, `Klass.prototype = ...`); the write-dominated suites' hot loops write `this`-targeted fields and `new` results, so the per-iteration counters are unchanged to 4 significant digits (A/B with the fast path disabled) and the sandbox median re-measured 1,387 vs the documented 1,395 (within sample spread). Regression battery: `security.test.js` adversarial cases at all four levels + differential smokes.
- ⬜ Next write-guard levers: marking `new` results and `this`-targeted writes (needs constructor-is-guest-function provenance), provenance through property-read chains, INITPROP object-literal fast path, array-index fast path, numeric-local specialization. Never break sandbox invariants for a score.

### P1 — Real-world workloads

- ✅ 8 workloads in `benchmark/workloads/` with a four-backend driver and cross-backend result verification.
- ⬜ 10k-scale pricing rules, AI-generated data transforms, UI decision logic, repeated execution, many-short-programs, cold Worker startup, compiled artifact cache reuse.

### P2 — Size

- ✅ `benchmark/size.js` measures raw CJS + minified IIFE for every level × security and gates CI on recorded budgets (`npm run benchmark:size -- --check`, +5% tolerance); reproducible Pareto data: O2 per-scope factories cost +55% raw CJS over shared at sandbox (1,225.7 vs 789.5 KB) for the deliberate speed-for-size trade, Os picks shared (617.1 KB sandbox); sandbox O2 min IIFE 593.4 KB (81.5 KB gzip) — full tables in [Performance](performance.md).
- ⬜ Factory safe-sharing (emit shared factories only when frame layouts provably match — could recover most of the O2 per-scope premium), helper dedup, descriptor table sharing, literal pooling, common guard factoring.
- ⬜ Size regression CI on every optimization level (currently the O2/Os min-IIFE budgets are gated; extend the gate to per-suite generated code).

### P2 — Compiler architecture

- ✅ `frontend -> ir -> backend -> compiler -> runtime` one-way dependencies.
- ✅ Giant-literal superlinearity fixed (four sub-issues) with regressions in `test/unit/compiler.test.js`.
- ✅ IR explicitly distinguishes local-safe from boundary-sensitive operations (2026-08-22, v1): the guest-object provenance pass (`src/backend/guest-provenance.js`, after the last SSA pass, O2/Os) writes `guestObjectOutput` marks onto the HIR; codegen replays them as temporary origins and picks the slim `$setGuest` write helper only for provably guest-created targets. Soundness: marked values are never folded/DCE'd/copy-propagated, so the mark cannot go stale; unmarked operands keep today's guarded path. Follow-ups: provenance through property-read chains and `new` results, INITPROP fast path.
- ✅ Each optimization pass documents its semantic invariants (2026-08-22): every pass in `src/backend/optimizer.js` carries a contract note — what it proves, what it preserves, and which instruction fields it may write; the security-sensitive guest-object-provenance pass documents its mark soundness and has adversarial regression tests at all four optimization levels plus differential coverage.
- ✅ IR dump / generated-code inspection mode (2026-08-22): `compile({ dumpDir })` writes `hir.txt` (annotated optimized HIR), `mir.txt` (MIR blocks/phis/operations), and `code.js`; `includeHIR`/`includeMIR`/`dumpIR: "hir"|"mir"|"all"` attach the graph objects (`dumpIR: "all"` now includes both forms). The text printer lives in `src/ir/print.js`; covered in `test/unit/compiler.test.js`.

### P2 — API / DX

- ✅ Minimal `compile → createInstance → run → dispose` example, capability example, Worker helper + [Worker isolation](worker-isolation.md).
- ⬜ TypeScript declarations (including capability types), browser/Worker/Node/Bun/Deno examples, error handling, precompile-at-build-time, compiled artifact cache examples.

### P2 — Docs

- ✅ `docs/architecture.md`, `docs/performance.md`, `docs/security.md` (with threat model), `docs/worker-isolation.md`.
- ◐ O0/O1/O2/Os design goals (brief version in [Architecture](architecture.md); expand).
- ⬜ Dedicated compatibility, capabilities, migration, and limitations documents — only if the content outgrows the current ones.

### P3 — ES version strategy

- ✅ Documented (README + [Security](security.md)): keep the ES5.1 core stable, recommend modern JS → Babel/SWC → ES5.1 → sablejs; add modern features natively only when the benefit is clear and the implementation boundary is clean; no native Proxy semantics beyond the guest, module loaders, or generator/async runtimes. The limited language surface is a security and maintainability advantage.

### P3 — Release quality

- ⬜ Release checklist: Test262, E2E browser matrix, security regression, benchmark regression, bundle-size regression, fuzz smoke; archive benchmark JSON + environment info; auto-generate the performance markdown; flag security-sensitive changes in release notes.

## Recent fixes (2026-08-22)

- **Boundary facet fuzzer: stack-exhaustion error corruption** — an infinite recursion inside a mediated call exhausted the host stack; the exception sanitizer then ran its boundary-message check on the exhausted stack, so the guest saw `SyntaxError: Invalid regular expression: ... Maximum call stack size exceeded` instead of the engine's `RangeError`. The sanitizer now tags boundary errors in a module-private `WeakSet` (identity check, no regex) and rethrows the original error if even `safeError` fails on a degraded stack. Regression: recursive mediated calls surface the same `RangeError` in sandbox and trusted across O0/O1/O2/Os.
- **Boundary facet fuzzer: Proxy-wrapped branded containers leaked raw receiver TypeErrors** — a guest passing `new Proxy(new Set(...))` to a capability reached the clone internals' branded methods, which threw unlabeled receiver TypeErrors instead of the documented boundary rejection. Every branded clone path (Date/RegExp/ArrayBuffer/typed arrays/Map/Set/Error) now converts receiver-identity failures into `sablejs sandbox boundary: <path> is a Proxy-wrapped <tag>; only plain data or explicit capabilities cross`; proxies over plain data still clone as the data they present. Regressions cover all branded shapes.
- **Bundled guests keep ES5 sloppy `arguments` semantics** — esbuild hoists `"use strict"` from any strict module to the top of the bundle, which turns the runtime's sloppy `arguments`-capture helper strict: its Arguments object then carries PoisonPill `callee`/`caller` accessors (non-configurable), and the runtime's mapped-parameter defines threw `Cannot redefine property: callee`. The runtime now detects a strict capture and, for sloppy guest frames, routes the exposed Arguments object through a Proxy with `callee`/`caller` in closure cells, so `arguments.callee === f` and legacy `caller` reads keep working in bundled artifacts. This also fixed the shipped `dist/runtime.js` (same bundle shape). E2E regression: the bundled build test now probes `arguments.length` / mapped parameters / `callee` identity (`test/e2e/build.js`).
- **Guest-invisible wrapper mapping (audit finding 4)** — the `HOST_TARGET` symbol tag on wrappers could be observed by guest proxy get traps during write-target resolution and by `Reflect.ownKeys` enumeration, and a trap returning a wrapper could steer resolution toward that wrapper's host target. Replaced with a module-private `wrapperTargets` WeakMap: `WeakMap.get` is trap-free, unforgeable, and unobservable, so write-target resolution is single-pass and guest traps cannot influence it. The boundary-internals sweep (P0-S1/S2) pins the fix with trap-observation, trap-steering, and enumeration regressions.
- **Iterative value clone + per-node checks** — `cloneValue` was rewritten with an explicit work stack (depth bounded by memory instead of the host call stack: 100k-deep graphs clone without stack overflow), and the entry-level checks (ambient objects, capability records, functions, primitives) now run per node so nested values keep their specific boundary messages. The P0 clone sweep (P0-S3/S4) covers sparse arrays, huge graphs, deep cycles, null-prototype data, Map/Set identity, typed-array subclass stripping, and DataView bytes (127 tests, 0 skipped).
- **`$v1_30` cross-block inline-guard bug** — trusted sunspider `string-unpack-code` failed with `$v1_30 is not defined`: an inlined identity guard referenced a closure temporary emitted in a sibling region block. Fix: `temporaryRegions` records each temporary's emission region stack; inline guards fall back to the runtime call when the temporary is invisible, and the reuse optimization gets the same check. Sunspider trusted restored, 23/23.
- **Giant-literal superlinearity** — Kraken's ~1.8 MB imaging literals hit four scaling bugs: SCCP post-pass O(V²) linear lookup → `Map` index (25.2s→1.0s at 8,000 objects), frontend number/string table `indexOf` dedup → parallel `Map` (400k elements 58.0s→0.76s), O2 scope overflow → 200-`const` block chunking (visibility checks aware of block boundaries), and codegen constant array-literal chains now fold into native literals (47.6 MB→1.8 MB generated code per test). Kraken imaging restored, 14/14.
- **Audit findings 1/2/3** — fixed with permanent regressions; see [Security](security.md), Historical audit record.
- **Boundary fast paths** — profiling the real-world workloads showed two dominant costs: the per-call guard checks on pure intrinsics (call-mediation dominated form-validator, template-logic, mini-parser) and the per-instance intrinsic graph walk (48% of `createInstance`, dwarfing form-validator's 12 boundary calls per run). Fixes: a lazily classified pure-intrinsic fast path plus a monomorphic identity cache in `boundary.call`, and a module-level shared intrinsic graph (contract: the host must not extend intrinsic prototypes after the first instance — documented in [Security](security.md)). Sandbox now beats QuickJS-WASM on every workload and every suite where it previously lost (Octane 1,613→1,772, Kraken 28.6 s→20.8 s, form-validator 2,546→22,114 ops/sec).
