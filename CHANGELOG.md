# Changelog

This file records user-visible changes. GitHub releases remain the source for
the exact commit list and downloadable artifacts.

## Unreleased

- Reworked the public documentation around the v2 product positioning,
  migration path, execution-model comparison, and benchmark sampling.
- Removed hard-coded beta versions from installation documentation.

## 2.0.0-beta.5 — 2026-08-25

- Added deterministic inline and external Source Map v3 output, including
  statement mappings and virtual sources for static `eval` and `Function`
  bodies.
- Added TypeScript declarations for the compiler, runtime, capabilities,
  generated programs, and Worker helpers.
- Added verified Node, browser, Worker, Deno, Bun, precompile, caching, and
  error-handling examples.
- Restored complete ESM named exports for the root package and subpaths.
- Fixed O2/Os stack fallback behavior, multi-line dynamic-function source-map
  geometry, source-map metadata gating, and browser bundle map chaining.

## 2.0 beta series

- Replaced the v1 opcode interpreter and boxed-value VM API with AOT-generated
  CommonJS artifacts that use standard JavaScript values.
- Added default sandbox mode with copied data, protected intrinsics, explicit
  capabilities, and an optional trusted pass-through mode.
- Added `sablejs/worker` for per-run message validation, wall-clock timeouts,
  and Worker termination.
- Added O0, O1, O2, and Os optimization levels, inspection output, pinned
  Test262 conformance, differential fuzzing, and reproducible benchmark gates.

See [Migrating from sablejs v1 to v2](docs/migration-v2.md) for the breaking
API and artifact changes.
