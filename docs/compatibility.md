# Compatibility: the ES5.1 conformance contract

The pinned Test262 gate is the executable form of sablejs's ES5.1 contract:
every run compiles each eligible test, executes it in a trusted-mode instance,
and A/B-compares failures against the same source on native V8. This document
is the policy record of that runner — what is in the corpus, what is excluded,
what is adjusted to ES5.1 expectations, and how results are attributed.

Runner: `test/conformance/test262.js`. Invocation and archiving:

```
npm run upstream:fetch -- test262   # pinned revision checkout
npm run test262                     # gate; exits non-zero on sablejs failures
npm run test262:archive             # full-failure-list report -> archives/test262/
```

## Corpus selection

Only files under `test/language/**` and `test/built-ins/**` whose frontmatter
carries an `es5id` are eligible. That key is Test262's own marker for tests
whose assertions describe an ES5-era specification clause, which is the
population sablejs claims. Everything else in the upstream suite — ES2015+
feature tests without ES5 ids, annex B material, and harness-only files —
is outside the corpus by definition, not by policy exclusion.

Each eligible file runs in the variants its flags declare: `onlyStrict` and
`noStrict`/`raw` narrow to one mode, otherwise both strict and sloppy.

## Dynamic-code policy exclusion

sablejs deliberately removes the runtime dynamic-code surface: global `eval`
and `Function` constructed with runtime-generated source are rejected
(literal `eval`/`Function` inputs are AOT-compiled at build time). Tests that
would require that surface cannot pass by design and are excluded:

- all of `built-ins/eval/*`, and
- `built-ins/Object/getOwnPropertyNames/15.2.3.4-4-1.js` (asserts the `eval`
  global exists, which sablejs intentionally removes).

The remaining exclusion is token-based, not text-based: the source is run
through acorn's tokenizer, and a file is excluded only when it actually
touches the surface — a `name` token `eval`, or `Function` followed by `(` or
by `.call`/`.apply`/`.bind(`. Descriptions, comments, string literals, and
regular expressions that merely contain the words are not enough, and a file
whose *tested early error is the tokenization itself* can never execute
dynamic code, so it stays eligible.

## ES5.1 expectation adjustments

Test262 is a living suite: its tests evolve to describe current engines even
when their `es5id` is unchanged. Where a current copy asserts behavior newer
than ES5.1, the runner pins the ES5.1 expectation instead:

- `language/statements/function/13.2-15-1.js` — the upstream copy asserts the
  function-length descriptor is configurable (`configurable: true`, the
  ES2015+ form); ES5.1 13.2 step 15 requires `[[Configurable]]: false`. The
  runner patches the expected value back to `false`.
- `language/expressions/object/prop-dup-*` — ES5.1 makes duplicate properties
  in object literals an early error for the strict mode and for the
  non-(data,data) forms (getter/setter collisions) even in sloppy mode. The
  runner attaches the ES5.1 `SyntaxError` expectation to exactly those
  variants where the current upstream copy allows the program.
- `language/expressions/object/11.1.5-2gs.js` and
  `language/statements/break/S12.8_A3.js`, `S12.8_A4_*` — strict-mode
  object-literal and `break` early errors that ES5.1 requires but the current
  copies dropped; the runner restores the `SyntaxError` expectations.

These paths are enumerated in `es5VariantMetadata` and
`hasES5SourceAdjustment` and are counted in the report as `es5Adjusted`.

## Modern-syntax downlevel

Positive-syntax tests that no longer parse as ES5 (current Test262 is written
for modern engines even when the clause is old) are transpiled with
Babel `preset-env` targeting IE 11 before running — syntax downlevel only,
no polyfills. Negative tests whose expected failure phase is `parse`/`early`
are never transpiled: the early error is exactly what is being tested.

## Host-failure attribution (A/B comparison)

Every sablejs failure is re-run on native V8 inside the same harness with the
same source. When native also fails, the case is counted as `hostFailures`,
not as a sablejs failure: it is an upstream/environment problem, and the
runner policy is to attribute it rather than silently pass or silently fail.
The pre-existing failure population was confirmed unrelated to the sablejs
work precisely through this A/B output. The report's `failures` array carries
the first N entries with the native verdict attached (`native: "pass"` when
native succeeded).

## Report and archive

The runner prints one JSON report on stdout:

```
{ revision, optimization, elapsedMs, files, variants, passed, negativePassed,
  es5Adjusted, policyExcluded, hostFailures, failed, codegen, failures }
```

The gate defaults to a 30-entry failure detail cap; `npm run test262:archive`
reruns with the cap raised to the full list, stamps the report with the
environment (node version, platform, arch, OS release, CPU count, time), and
writes `archives/test262/<revision>-<timestamp>.json` plus a `latest.json`
pointer. A red gate still archives the report (the failure list is the point
of an archive) and still exits non-zero so the release checklist cannot pass
on it. Archives are git-tracked: each release records its pass/fail counts
and its full failure list.
