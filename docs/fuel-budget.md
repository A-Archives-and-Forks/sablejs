# Fuel budgets: compile-time loop instrumentation (research design)

[README](../README.md) · [Get started](../README.md#quick-start) · [Migration](migration-v2.md) · [Security](security.md) · [Performance](performance.md)

Status: **research + design, not implemented.** The Worker timeout remains the
wall-clock enforcement mechanism. This design is an optional, opt-in,
never-the-default resource-control layer that bounds *productive work*
(loop iterations, calls) rather than wall-clock time.

## Goal and non-goals

- **Goal**: a per-instance instruction/iteration budget that stops runaway
  guest programs (infinite loops, unbounded recursion, pathological
  call-retry loops) with a guest-visible error, deterministically and
  without host stack exhaustion.
- **Non-goals**: wall-clock bounds (that is the Worker's job — a program that
  completes an iteration per fuel unit faster than the clock can measure
  still needs `timeoutMs`), memory bounds, and any change to the default
  compiled output. When the option is off, generated code must be
  byte-identical to today.

## Why the existing architecture makes this cheap

Three properties of the current pipeline are the design's foundation:

1. **Natural loops are already computed.** `src/ir/cfg.js` `analyze()`
   returns `cfg.loops: [{ header, backedge }]` (used by backend
   optimizations). A fuel check inserted on the loop header dominates every
   iteration of that loop — one decrement + compare per iteration, not per
   instruction, is the coarse-grained but effective default.
2. **Op classification is enforced.** `src/ir/op-spec.js` classifies every
   op (`pure`/`allocate`/`read`/`write`/`host`/`dynamic`/`call`); SCCP and
   the optimizer only move pure ops. A `FUELCHECK` op classified `host`
   (side-effecting: it can throw) is automatically exempt from
   elimination/hoisting — no pass can delete it by accident.
3. **Lowering coverage is checked at startup.** `src/codegen/index.js`
   requires every non-`STATIC_CONTROL_OPS` op to name a concrete runtime
   helper (`validateLoweringCoverage`), so a new opcode cannot silently fall
   through to interpretation.

## Design: `FUELCHECK` on loop headers and call sites

- **Compile**: `compile(source, { fuel: true })` (optionally a default
  budget). With the option off, the pass manager never inserts the ops and
  output is unchanged.
- **Insertion**:
  - One `FUELCHECK` at each natural-loop header (from `cfg.loops`).
  - One `FUELCHECK` at each call/construct site (catches unbounded
    recursion *before* the host stack does, turning it into a clean
    budget error).
  - Inlined bodies keep their checks per inline copy (still one per
    iteration, correctness unaffected).
- **Runtime**: `frame.fuel` starts from
  `createInstance({ fuel: N })` (per-instance override) or the compile
  default. The helper is trivial:

  ```js
  fuelCheck(frame) {
    if (--frame.fuel <= 0) throw new RangeError("sablejs fuel budget exceeded");
  }
  ```

  `frame.fuel` is runtime-internal, exactly like `currentFrame`: the guest
  can neither read nor forge it. The decrement is exact for every integer
  budget up to 2^53 (no overflow, monotonic, never resets — a caught
  exhaustion can never be "recharged" by any guest-visible action).
- **Cost when enabled**: one integer decrement + compare per loop iteration
  and per call — small next to the mediated call/property dispatch it sits
  beside in sandbox mode; in trusted mode it is the dominant new cost for
  call-heavy loops, which is why call-site checks should be optional
  (`fuel: "loops"` vs `fuel: true`).

## The catch-retry hole, and the uncatchable-sentinel fix

A *catchable* budget error cannot bound a program shaped like this:

```js
try { while (true) { /* every backedge throws once fuel is exhausted */ } }
catch (e) { /* empty */ }
```

After exhaustion, each cycle costs exactly one check (throw → catch →
backedge → throw) with zero fuel consumed — an unbounded spin that fuel
alone cannot stop, because the error is caught by guest code that itself
never hits a check. This is a fundamental property of catchable budget
errors, not an implementation bug.

**Fix (recommended)**: make exhaustion uncatchable from the guest's
perspective by intercepting it in the catch lowering. `TRY`/`ENDTRY` are
static control ops whose catch bodies lower to native JS `catch` blocks;
when fuel is enabled, the lowering emits a sentinel comparison first:

```js
catch (e) { if (e === FUEL_SENTINEL) throw e; /* guest catch body */ }
```

The sentinel propagates through every nested catch (each lowering rethrows
it) until it exits the program. The guest never sees it as a catchable
value, so catch-retry spinners die on the first post-exhaustion backedge
instead of spinning. Cost: one identity comparison per `catch` block in the
generated code, only when fuel is enabled.

Acceptable v1 fallback if the sentinel proves disruptive: ship catchable
fuel errors, and document that fuel bounds productive work while the Worker
timeout remains the backstop for catch-retry spinners.

## Semantics and security notes

- **Sandbox interplay**: `FUELCHECK` is an ordinary guest op; its throw
  crosses the boundary like any other guest error and is sanitized to the
  guest as `RangeError: sablejs fuel budget exceeded`. No host state, no
  stack, no paths leak.
- **Error surface**: `RangeError` is ES5.1; a budget error adds no new
  built-in or global. The feature is explicitly non-standard behavior when
  enabled (ES5.1 has no budgets), so it can never be the default path.
- **Optimization interplay**: the `host` classification blocks SCCP
  elimination; later, a *sound* optimization is to remove `FUELCHECK` from
  loops whose iteration count the optimizer can prove statically below the
  budget (the check is then dead). Loop-invariant code motion must never
  hoist the check out of its loop — it counts backedges, so it must stay on
  the backedge.
- **Recursion**: call-site checks turn stack-overflow recursion into a
  deterministic budget error at `budget` calls, instead of the host's
  nondeterministic `RangeError: Maximum call stack size exceeded`. This is a
  quality improvement for sandboxed code (deterministic, host-stack-depth
  independent), worth pinning in tests if implemented.

## Interface sketch

```js
const artifact = compile(source, { fuel: true, fuelBudget: 1e6 });
const instance = artifact.createInstance({ fuel: 5e5 }); // per-instance override
instance.run(); // RangeError: sablejs fuel budget exceeded after 5e5 work units
```

`createInstance` without `fuel` falls back to the compile-time budget; a
compile without `fuel: true` emits no checks regardless of instance options.

## Open questions

- Default budget magnitude and whether per-loop-header vs per-call is
  sufficient in practice (measure with a prototype on the differential
  corpus and the V8 Benchmark Suite before committing to `fuel: "loops"`).
- Sentinel interplay with `finally` blocks and `dispose()` paths (must not
  mask the budget error in cleanup).
- Whether `evaluate()`d artifacts in the Worker should force `fuel: true`
  for many-short-program workloads (they are the natural first deployment).
