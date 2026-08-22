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

- **Security**: a full boundary audit ([Security](security.md), Historical audit record) found no usable escape; the adversarial regression battery lives in `test/unit/security.test.js` (110 tests, 0 skipped).
- **Performance**: V8 Benchmark Suite 7 sandbox 1,395, trusted 2,070; Octane/SunSpider/Kraken comparison system across sandbox/trusted/QuickJS in place; the sandbox beats QuickJS-WASM on all 8 real-world workloads after the boundary fast paths. Details in [Performance](performance.md).
- **Semantics**: the pinned Test262 gate passes; the 33 pre-existing failures were confirmed unrelated to this work by A/B comparison.

## Next priorities

1. **Local-safe IR distinction** — the boundary profile shows per-write target resolution as the biggest sandbox-tax lever. Distinguish local-safe from boundary-sensitive operations in the IR, prove locals at compile time, and fall back to the guarded slow path otherwise (P2, Compiler architecture).
2. **Facet fuzzing** — extend the differential fuzzer to parser / optimizer / sandbox boundary / capability serializer facets, add generated-code syntax validation, and a nightly campaign.
3. **Benchmark reporting automation** — automatically generate the performance markdown and archive benchmark JSON with environment info.

## Open work by priority

### P0 — Security

- ⬜ Guest-invisible symbol-tag (`HOST_TARGET`) test sweep: enumeration and introspection paths (`getOwnPropertySymbols`, `getOwnPropertyDescriptors`, `Reflect.ownKeys`, `in`, `for-in`, JSON) must never reveal or recover wrapper targets.
- ⬜ Sandbox write-path TOCTOU analysis (`writeTarget` single-pass resolution; add focused tests and documentation).
- ⬜ Boundary tests for sparse arrays, huge object graphs, deep nesting, and exotic prototypes.
- ◐ `Map` / `Set` / typed arrays / Buffer focused boundary tests (mutator coverage exists; clone and prototype-stripping tests to extend). Buffer clones arrive as plain `Uint8Array`.
- ◐ Dedicated security regression corpus directory (currently embedded in `security.test.js`; split when it grows).
- ✅ Proxy / Symbol / SharedArrayBuffer / Atomics / Intl policies are documented in [Security](security.md).

### P0 — Resource control

- ✅ Worker helper, timeouts, message validation, force termination: `sablejs/worker` + [Worker isolation](worker-isolation.md).
- ✅ Source-size / input-size / output-size budget examples ([Worker isolation](worker-isolation.md), Budgets beyond time).
- ⬜ Research compile-time loop instrumentation and instruction/fuel budgets (optional feature; never the default path).
- ⬜ Protection for long-blocking or infinite async capabilities (timeout-wrapper example or documentation).

### P1 — Semantic correctness

- ✅ Pinned Test262 runs continuously (gate passes).
- ✅ Differential testing established (return value + exception name, 16,000 cases zero mismatches); finer observation surfaces (observable mutations, descriptors, enumeration order) belong to facet fuzzing.
- ⬜ Archive Test262 pass/fail counts and failure lists per release (the runner emits JSON; add an archiving script).
- ⬜ Document the ES5.1-contract exclusion list (runner policy).

### P1 — Fuzzing

- ✅ Program generator, three-engine comparison, failure saving, ddmin minimization ([details](../test/differential/fuzz.js)); CI smoke: `npm run test:differential`.
- ⬜ Facet fuzzers: parser / optimizer / sandbox boundary / capability serializer.
- ⬜ Generated-code syntax validation (acorn over the compiled output).
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
- ⬜ Array-index fast path, numeric-local specialization, and guard elimination for provably local objects (depends on the local-safe IR distinction). Never break sandbox invariants for a score.

### P1 — Real-world workloads

- ✅ 8 workloads in `benchmark/workloads/` with a four-backend driver and cross-backend result verification.
- ⬜ 10k-scale pricing rules, AI-generated data transforms, UI decision logic, repeated execution, many-short-programs, cold Worker startup, compiled artifact cache reuse.

### P2 — Size

- ◐ `Os` is a separate optimization target (size essentially unchanged); O2 per-scope factory duplication quantified (O2 min bundle +29%, the deliberate speed-for-size trade).
- ⬜ Factory safe-sharing analysis, helper dedup, descriptor table sharing, literal pooling, common guard factoring.
- ⬜ O2 vs Os Pareto curve report + bundle-size regression threshold.

### P2 — Compiler architecture

- ✅ `frontend -> ir -> backend -> compiler -> runtime` one-way dependencies.
- ✅ Giant-literal superlinearity fixed (four sub-issues) with regressions in `test/unit/compiler.test.js`.
- ⬜ IR explicitly distinguishes local-safe from boundary-sensitive operations; compile-time proof where possible, guarded slow path otherwise.
- ⬜ Each optimization pass documents its semantic invariants; security-sensitive optimizations require differential/regression tests.
- ⬜ IR dump / generated-code inspection mode.

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

- **`$v1_30` cross-block inline-guard bug** — trusted sunspider `string-unpack-code` failed with `$v1_30 is not defined`: an inlined identity guard referenced a closure temporary emitted in a sibling region block. Fix: `temporaryRegions` records each temporary's emission region stack; inline guards fall back to the runtime call when the temporary is invisible, and the reuse optimization gets the same check. Sunspider trusted restored, 23/23.
- **Giant-literal superlinearity** — Kraken's ~1.8 MB imaging literals hit four scaling bugs: SCCP post-pass O(V²) linear lookup → `Map` index (25.2s→1.0s at 8,000 objects), frontend number/string table `indexOf` dedup → parallel `Map` (400k elements 58.0s→0.76s), O2 scope overflow → 200-`const` block chunking (visibility checks aware of block boundaries), and codegen constant array-literal chains now fold into native literals (47.6 MB→1.8 MB generated code per test). Kraken imaging restored, 14/14.
- **Audit findings 1/2/3** — fixed with permanent regressions; see [Security](security.md), Historical audit record.
- **Boundary fast paths** — profiling the real-world workloads showed two dominant costs: the per-call guard checks on pure intrinsics (call-mediation dominated form-validator, template-logic, mini-parser) and the per-instance intrinsic graph walk (48% of `createInstance`, dwarfing form-validator's 12 boundary calls per run). Fixes: a lazily classified pure-intrinsic fast path plus a monomorphic identity cache in `boundary.call`, and a module-level shared intrinsic graph (contract: the host must not extend intrinsic prototypes after the first instance — documented in [Security](security.md)). Sandbox now beats QuickJS-WASM on every workload and every suite where it previously lost (Octane 1,613→1,772, Kraken 28.6 s→20.8 s, form-validator 2,546→22,114 ops/sec).
