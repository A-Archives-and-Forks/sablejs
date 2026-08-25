# Generated-code source maps

Status: **Slices 1-3 implemented (2026-08-25), review fixes applied
(2026-08-25).** This document covers source
maps for the CommonJS artifact returned by `compile()`. It deliberately
separates source-map generation from error sanitization and guest-facing
stack policy. Slice 1 shipped statement-level maps; Slice 2 shipped the
Node/browser integration evidence and recorded the `guestLocation` decision
below; Slice 3 shipped virtual sources for static eval/dynamic-Function
bodies. An independent review found two "legal but wrong" mapping hazards —
virtual-source index misalignment between GenMapping's first-segment order
and the registry order, and synthetic-source identity not inherited by
lexical descendants — plus a fallback-path `preserveSourceLocations` gap;
all three are fixed with regressions (see "Review fixes" below). Expression-
level columns remain explicitly deferred — the design binds that cost to
demonstrated debugger feedback, which statement-level evidence has not shown
a gap in.

## Goal and non-goals

- **Goal**: opt-in Source Map v3 output that maps generated `$exec*` frames and
  debugger locations back to the original ES5.1 guest source.
- **Goal**: statement-level mappings at every optimization level, including
  nested lexical functions and structured control flow.
- **Goal**: deterministic inline and external maps without changing the default
  generated code, runtime behavior, statistics, or artifact size.
- **Non-goal for v1**: expression-level columns. A generated operation within
  `a.b().c` maps to the containing statement's start, not necessarily to the
  exact subexpression that threw.
- **Non-goal for v1**: rewriting or filtering stack strings. Engines and build
  tools consume the map; sablejs does not install `Error.prepareStackTrace` or
  a process-global source-map hook.
- **Non-goal**: expression-level columns for synthetic sources. Static
  `eval` and `Function` bodies map to virtual sources with their own
  identities and offset rules (implemented in Slice 3); runtime-dynamic
  eval values have no statically knowable source and stay unmapped.

## Existing foundation

The frontend already parses with Acorn's `locations: true` and emits a
`LOC(line, column)` operation at the start of each statement. The HIR decoder
retains those operations and their offsets. O2/Os only elide them when
`preserveSourceLocations` is not enabled, and codegen already knows how to
consume a live `LOC` by updating `frame.line` and `frame.column`.

This means v1 does not need AST retention, a new IR node, or provenance through
every optimization. The source map can treat the most recent live `LOC` as the
origin of subsequently emitted guest code. Optimizer rewrites preserve the HIR
offset layout; folded expressions, native literal folds, and structured
control-flow scaffolding therefore inherit the statement containing them.

## Public API

`compile()` accepts an opt-in `sourceMap` option:

```js
const result = compile(source, {
  optimization: "O2",
  sourceMap: {
    mode: "external",             // "external" or "inline"
    sourceFile: "rules/input.js", // logical path, never inferred from cwd
    generatedFile: "rules.cjs",   // `file` in the v3 map
    sourceMapURL: "rules.cjs.map", // optional external URL comment
    sourcesContent: false,         // opt in to embedding guest source
  },
});

result.code; // generated CJS; inline mode includes a data URL
result.map;  // serialized Source Map v3 JSON; undefined when disabled
```

`sourceMap: true` is shorthand for an external map with safe logical defaults:
`sourceFile: "<sablejs-input>"`, `generatedFile: "generated.cjs"`, no URL
comment, and no embedded source. `sourceMap: "inline"` is shorthand for inline
mode with the same names. An explicit `sourceMapURL` is appended only in
external mode; the compiler must not guess the caller's eventual output path.

The normalized map settings are reflected in `result.metadata.sourceMap`, but
the source text and map contents are not copied into `metadata`. Invalid
modes, empty filenames, non-boolean `sourcesContent`, and newline-containing
URLs fail during option normalization before code generation.

When `dumpDir` and source maps are both enabled, inspection output additionally
writes `code.js.map`. The dumped `code.js` uses `code.js.map` as its URL rather
than leaking the absolute `dumpDir`. The returned artifact continues to use the
caller-provided logical names.

## Code-generation design

### 1. Retain locations without changing the normal build

The compiler derives an internal `retainSourceLocations` flag from
`sourceMap || preserveSourceLocations`. The optimizer uses that flag instead of
testing only `preserveSourceLocations`, so O2/Os keep `LOC` while a map is being
built.

The existing `preserveSourceLocations` behavior remains available for runtime
frame-location tracking. Source-map generation itself should not emit
`$f.line/$f.column` writes: those writes add runtime cost but are unnecessary
once the positions have been consumed at compile time. If both options are
explicitly requested, emit both the source marker and the runtime assignment.

As today, retaining locations disables small-function expression inlining.
That is the conservative v1 contract: an inlined body otherwise needs mappings
from the caller's generated range to the callee's source range. Other optimizer
passes remain enabled.

### 2. Emit private location markers

Keep `generate()`'s internal string return type. In source-map mode, lower each
`LOC` to a collision-resistant private marker carrying:

```text
source identity, original line, original column
```

Emit reset markers at the start and end of every generated `$exec*` scope. A
reset prevents the last statement of one scope from incorrectly mapping module
metadata, factories, or the next scope's prologue.

Markers are preferable to changing all `lines.push()` call sites to a new
builder: codegen currently performs final string insertions and removals for
temporary declarations and stackless frames. A final pass over the completely
assembled module naturally observes the real generated positions after those
transformations.

Markers must be generated internally, not derived from guest text, and the
finalizer must assert that none remain in returned code.

### 3. Finalize code and mappings together

Add a small `src/codegen/source-map.js` module that scans the assembled module
once, removes markers, and builds the v3 map against the cleaned output:

- source lines from `LOC` are converted from one-based Acorn lines to the map
  generator's indexing convention; columns remain zero-based;
- every non-empty generated line under an active source location receives a
  segment at its first non-whitespace column;
- module imports, metadata, factories, and other reset regions stay unmapped;
- `names` is empty in v1, so identifier protection does not accidentally gain
  an original-name side channel;
- `sourcesContent` is omitted unless explicitly requested;
- inline mode base64-encodes the serialized map and appends one
  `sourceMappingURL` comment after final mapping positions are known;
- external mode appends a URL only when `sourceMapURL` was supplied.

Use `@jridgewell/gen-mapping` rather than maintaining a private VLQ encoder. It
is already present through the development Babel graph, but implementation must
declare it as a direct production dependency: production installs cannot rely
on a transitive dev dependency. The compiler bundle and `THIRD_PARTY_NOTICES`
must be refreshed through the normal build/compliance workflow.

### 4. Keep candidate selection deterministic

Os currently generates multiple closure-factory candidates and selects the
smallest raw CJS body. Location markers and map comments must not participate in
that cost model. Select the candidate exactly as today, then finalize a map only
for the selected code. With source maps disabled, generated bytes and candidate
statistics must remain byte-for-byte unchanged.

## Scope identity and dynamic code

Ordinary nested function declarations and expressions come from the root Acorn
tree, so their `LOC` positions refer to the same `sourceFile` and are mapped.

Static `eval("...")` and `Function("...")` parse synthetic text: the frontend
prepends a `'use strict';` prefix to eval code when the enclosing scope is
strict, and wraps dynamic bodies as `function _dynamic_N(params){ body }`.
The frontend records a per-scope source descriptor — `{ text, lines, columns }`
— where `text` is the guest-recognizable source (the eval string as
concatenated, or the bare body), and `lines`/`columns` is the injected prefix
geometry: how many parsed lines the wrapper occupies and how long its last
line is. The strict-eval prefix is newline-free; the `_dynamic_*` wrapper is
too unless a parameter string spans lines — a multi-line parameter literal
counts its newlines in `lines`, and the body still starts at line 1 of the
virtual source. A newline-free wrapper has `lines: 0`, so only the first
parsed body line carries a column shift. The decoder copies the descriptor
onto the HIR scope; the compile pipeline walks the optimized HIR once and
builds a deterministic registry, one entry per synthetic scope:

- names are `<sourceFile>#eval-N` and `<sourceFile>#dynamic-N`, numbered in
  scope discovery order;
- markers for those scopes carry the registry identity plus the position
  translated through the descriptor (`translateSynthetic`), so segments land
  inside the guest text — a strict eval's statements start at column 0 of the
  virtual source, not column 13 of the parsed text;
- `sourcesContent` (when requested) embeds each descriptor's `text`, never the
  injected scaffolding;
- the identity and geometry rules are recorded here as implemented, so any
  future change to the wrapper text (multi-line parameter lists, new prefixes)
  must update the descriptor at the construction site — the source-map layer
  never recomputes them.

Runtime-dynamic eval values (`eval(expr)` where `expr` is not statically
concatenable) have no source text; those scopes carry no descriptor and lower
to reset markers, staying unmapped. Their invocation sites remain mapped to
the containing root statement.

## Errors, stacks, and the sandbox boundary

A source map changes how a consumer presents generated locations; it does not
guarantee that every thrown value has a stack, nor does it remove runtime helper
frames. A normal runtime exception should contain at least one mapped `$exec*`
caller frame, while its top frame may still be in `sablejs/runtime`.
Returning a map alone does not activate stack remapping: the host must write or
embed the map and enable its engine, debugger, or bundler's source-map support.

Sandbox boundary violations and sanitized host errors intentionally have their
stacks deleted so host paths and frames cannot cross the boundary. Source-map
support must not weaken that policy or attach the original source to those
errors. A host-facing `guestLocation: { source, line, column }` surface using
the existing frame fields was considered and explicitly deferred — the
decision record and its triggers live in the Slice 2 section.

Inline maps and `sourcesContent: true` disclose source to anyone who receives
the generated artifact. Defaults therefore use logical filenames, omit source
content, and never serialize absolute compiler or dump paths. Applications are
responsible for keeping external maps private when source confidentiality
matters.

## Implementation slices

### Slice 1 — statement-level map ✅ (2026-08-25)

- Normalize and validate the public options in `src/compiler/index.js`
  (`normalizeSourceMapOptions`, exported for host reuse).
- Derive `retainSourceLocations` and keep v1 inlining disabled while mapping.
- Add codegen markers, scope resets, and the final map builder
  (`src/codegen/source-map.js`).
- Return `map`, support inline/external comments, and extend `dumpDir`
  (`code.js.map`; the dump URL is `code.js.map`, never the absolute `dumpDir`).
- Map the root program and ordinary lexical functions; deliberately leave
  static eval/dynamic-Function scopes unmapped.
- Document the API in the README and architecture guide.
- Verified by `test/unit/source-map.test.js` (22 tests as of the review
  fixes: 17 at Slice 1, plus eval/dynamic virtual sources, review
  regressions, and the finalizer/gate suite) and the acceptance
  checks in the verification matrix below.

### Slice 2 — stack integration evidence ✅ (2026-08-25)

- Node end-to-end coverage: `test/unit/source-map-e2e.test.js` compiles with
  an external map, writes the artifact + map + driver into a temp directory,
  and runs `node --enable-source-maps`. The uncaught `$exec*` frames resolve
  to the guest filename and statement (`guest/input.js:7:5` for the throw,
  `11:1` for the root call) in both sandbox and trusted modes, with a
  control run proving the raw trace stays generated-file-only without the
  flag. A third test captures the remapped stack through Node's own `Error`
  API — the host consumer path.
- Browser coverage: the Playwright build emits a `map-inline.js` bundle that
  compiles a throwing program with `sourceMap: "inline"` in-page, runs the
  inline-mapped artifact through a CommonJS shim backed by the bundled
  runtime, and surfaces the compile-time map plus the runtime outcome.
  `test/e2e/browser.test.js` decodes the data URL with the browser's base64
  path (no Buffer), round-trips it against the returned map, and checks the
  generated throw resolves to the guest's statement line. Runs on
  chromium/firefox/webkit in CI.
- `guestLocation` decision (recorded): **no new host-facing error surface in
  the source-map work.** The engine evidence above already gives hosts a
  stable location for ordinary runtime errors. The remaining stackless
  errors — sandbox boundary violations and sanitized host errors — have
  their stacks deleted by deliberate policy (`src/runtime/security.js`), and
  reattaching a location to them has unsolved problems: frames carry
  `line`/`column` only under the `preserveSourceLocations` runtime-cost
  opt-in (independent of source maps), a boundary error caught and rethrown
  by guest code would be attributed to the rethrow statement rather than the
  original violation (the plausible-but-wrong trap the markers avoid), and a
  forgeable `guestLocation` property is a new guest-observable error-object
  contract needing its own adversarial review. Revisit when a concrete
  consumer demonstrates the need for structured locations on policy-stripped
  errors; a future design must snapshot the location at throw time and carry
  source identity per frame.

### Slice 3 — optional precision and dynamic sources ✅ (2026-08-25)

- Static eval/Function scopes now carry stable virtual source identities
  (`<sourceFile>#eval-N`, `<sourceFile>#dynamic-N`) with the offset rules
  defined and implemented as described under "Scope identity and dynamic
  code" above; runtime-dynamic eval stays unmapped. Covered by
  `test/unit/source-map.test.js` (virtual sources, strict-prefix column
  translation, multi-line dynamic bodies) and the acceptance checks.
- Expression-level columns remain deferred by design: the emitter would need
  AST origins threaded per instruction and the map would grow
  proportionally. The design binds that cost to real debugger feedback, and
  statement-level evidence (Node engine remapping, browser devtools-ready
  inline maps) has not shown a gap. Revisit if debugging sessions surface a
  concrete need for sub-statement positions.

## Verification matrix

Unit tests should decode the returned map with a source-map consumer and pin:

- `O0`, `O1`, `O2`, and `Os`, in sandbox and trusted modes;
- straight-line code, nested functions, if/else, all loop forms, switch,
  try/catch/finally, labelled exits, with, and thrown runtime errors;
- folded constants, native object/array literals, promoted locals, LICM output,
  and Os factory selection;
- inline data URLs, external URLs, omitted/embedded `sourcesContent`, custom
  logical filenames, and deterministic repeated output;
- static eval and dynamic-Function bodies map to their virtual sources
  (`#eval-N` / `#dynamic-N`) with correct line/column offsets, strict eval
  prefixes translated, and runtime-dynamic eval unmapped — while call sites
  remain mapped to the root file;
- custom `dumpDir` filesystem adapters receive `code.js.map` without absolute
  path leakage;
- malformed options fail clearly;
- source-map-off code, statistics, runtime results, and security behavior are
  byte-for-byte or deep-equal to the existing baseline.

Slice 2 evidence tests additionally pin the integration contract:

- an external map written next to the generated artifact remaps uncaught
  `$exec*` frames to the guest filename and statement line under Node's own
  `--enable-source-maps`, in both security modes, with a no-flag control run
  showing the raw trace;
- a caught guest error's stack is remapped through Node's `Error` API;
- the browser bundle compiles and runs an inline-mapped artifact in-page,
  and the data URL round-trips through the browser's base64 path.

Integration gates:

- generated CJS plus its external map loads and runs under Node;
- the compiler browser bundle can emit and consume an inline map;
- unit, adversarial security, differential, build, bundle-size, and compliance
  checks stay green;
- a source-map-off benchmark confirms zero runtime and artifact-size change;
  a map-enabled compile benchmark records compile-time and map-size overhead
  without establishing it as a release performance gate.

## Review fixes (2026-08-25)

An independent review of the Slice 1-3 implementation surfaced two
"legal but wrong" mapping hazards and one integration gap; all are fixed
with regression tests in `test/unit/source-map.test.js`:

- **Virtual-source index alignment.** GenMapping assigns source indices by
  first-segment order, which is not guaranteed to match the registry order
  encoded in the markers (a nested eval's factory can be emitted before the
  root eval's, and empty evals shift the numbering). The finalizer now
  serializes `sources` as GenMapping's own array — the array the segment
  indices point into — and aligns `sourcesContent` by name, so a nested
  eval's segments can never resolve to the root eval's identity.
- **Synthetic-source inheritance.** Only the direct eval/Function scope was
  marked synthetic; a function declared inside an eval body mapped its
  (parsed-text-relative) LOC into the root file, possibly past its last
  line. Codegen now walks the parent chain (`inheritSynthetic`) and every
  lexical descendant inherits the nearest synthetic source identity and
  offset descriptor — or the reset marker for runtime-dynamic eval bodies.
- **Fallback lowering kept `preserveSourceLocations`.** The stack-to-local
  fallback path (O0/O1, and `stackToLocal: false` at any level) returned the
  compile-time marker and dropped the runtime `$f.line` write when both
  modes were requested. It now emits both, matching the direct lowering
  path; verified at all four optimization levels with and without
  `stackToLocal`.
- Minor: the dumped `code.js.map` sets `file: "code.js"` (the returned map
  keeps the caller's `generatedFile`); `encodeUtf8` returns a `Uint8Array`
  so the btoa chunking fallback cannot crash on `subarray`; and
  `smallFunctionInlining` in the size-optimization decisions reports the
  actual enablement (false while source maps retain LOC).

## Acceptance criteria

Slice 1 is complete when all of the following hold:

1. Source maps are opt-in and valid Source Map v3 JSON.
2. Every tested generated `$exec*` location resolves to the correct guest
   source file and containing statement at all four optimization levels.
3. Default generated code and compiler statistics are unchanged.
4. No private marker, absolute host path, original identifier-name table, or
   source content escapes unless explicitly requested.
5. Unsupported synthetic-source scopes are visibly unmapped, never mapped to
   a plausible but incorrect root location.
6. Inline/external artifacts, inspection dumps, browser compiler builds, and
   compliance checks are covered by automated tests and user documentation.
