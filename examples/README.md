# sablejs examples

Runnable examples for every documented way to use sablejs. Each directory is
self-contained; run them from the repository root. They `require("sablejs")`
through the package's own `exports` map (Node-style self-reference), so no
install beyond `npm install` at the repository root is needed.

CI keeps every example working: `npm run check:examples` spawns each one
exactly as the table below says and asserts on its documented output (Deno
and Bun cases skip when those runtimes are not installed).

| directory | what it shows | run it |
| --- | --- | --- |
| `node/basic.cjs` | compile → write artifact → run → dispose (quick start) | `node examples/node/basic.cjs` |
| `node/error-handling.cjs` | guest throws, capability errors, boundary sanitization, lifecycle errors | `node examples/node/error-handling.cjs` |
| `node/functions.cjs` | **calling guest functions**: stateful closures across calls, host capabilities called from the guest (globals and arguments), `capability()` with `thisValue`, the `input`-global one-call-per-run pattern | `node examples/node/functions.cjs` |
| `trusted/trusted.cjs` | `security: "trusted"`: direct `globalThis` access by reference, in-place host-object mutation, prototypes/getters/`instanceof`, raw host errors with stacks, capability-token unwrapping — with sandbox contrasts | `node examples/trusted/trusted.cjs` |
| `precompile/` | **compile at build time**, ship only the artifact + map + metadata; the runtime app never imports the compiler | `node examples/precompile/build.cjs && node examples/precompile/run.cjs` |
| `caching/cache.cjs` | compiled-artifact cache keyed by a source hash — recompile only on change | `node examples/caching/cache.cjs` |
| `worker/` | run programs in a dedicated Worker with wall-clock timeouts (Node `worker_threads` adapter + browser pattern) | `node examples/worker/host.cjs` |
| `browser/` | bundle a precompiled artifact for the browser (esbuild) and run it in a page | `node examples/browser/build.cjs` then open `examples/browser/index.html` |
| `deno/` | bundle for a neutral platform and run under Deno | `node examples/deno/build.mjs && deno run examples/deno/main.ts` |
| `bun/` | run under Bun (Node-compatible `require` path) | `bun examples/bun/main.ts` |

## Mental model

`sablejs` splits into three pieces that these examples exercise in different
combinations:

- **`compile()`** — the compiler. Takes ES5.1 guest source and options, returns
  `{ code, map, metadata }`. Expensive; call it at build time or when caching.
- **the artifact** — the generated CommonJS file (`result.code`). Its only
  runtime dependency is the sablejs runtime module; it contains no evaluator.
- **the runtime** — bundled with the artifact or resolved from
  `sablejs/runtime`. `program.createInstance({ globals })` → `instance.run()`.

The `precompile` and `caching` examples are the recommended shape for
production: compile once (build step, CI, or a cache), then run the artifact
wherever you need it — Node, browser, Deno, Bun, or a Worker.
