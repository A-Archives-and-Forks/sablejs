# Architecture

sablejs compiles ES5.1 source into CommonJS ahead-of-time modules. The generated code uses native JavaScript values and objects; it does not ship an opcode dispatcher or evaluate source at runtime.

## Layers

```text
source
  -> frontend      parse ES5.1 and emit structured frontend operations
  -> IR            decode and verify HIR, CFG, SSA, and MIR
  -> backend       optimize and lower structured control flow
  -> codegen       emit direct JavaScript and runtime calls
  -> runtime       manage scopes, calls, arguments, and host boundaries
```

The implementation follows the same layout:

- `src/frontend`: ES5.1 parser and the 88-operation frontend contract.
- `src/ir`: HIR/MIR definitions, CFG analysis, decoding, and verification.
- `src/backend`: optimization passes.
- `src/codegen`: direct JavaScript generation.
- `src/compiler`: pipeline orchestration and public compile API.
- `src/runtime`: native-value runtime and sloppy-assignment helpers.

`src/compiler` composes the pipeline. The runtime remains independent of compiler layers.

## Optimization levels

- `O0`: semantic oracle; no optimizer rewrites.
- `O1`: conservative CFG, constant, copy, and dead-code passes.
- `O2`: adds stack-to-local lowering, cross-block GVN, safe LICM, guarded small-function inlining, and specialized leaf and inline fast-frame factories whose frame literals only carry the fields each scope reads.
- `Os`: uses measured output size to choose closure factories, reuses temporary slots, prunes runtime imports, and disables growth-oriented inlining.

Unknown calls, property access, dynamic environments, captured values, parameter/`arguments` aliasing, and observable coercion remain optimization barriers unless a pass proves safety.

## Runtime and security boundary

- Generated modules contain no `eval`, `new Function`, or bytecode dispatch loop.
- `security: "sandbox"` is the default. It copies plain `globals` data, mediates built-ins, blocks dynamic code-constructor escapes, and auto-wraps raw host functions in `globals` as capabilities (rejecting callables the runtime itself manufactured).
- Hot boundary paths stay monomorphic: guest calls dispatch through `guestFunctions` first, wrapper-to-target resolution uses a module-private `WeakMap`, argument arrays are secured by copy-on-write, and property writes resolve and assert their target in a single trap-free pass.
- `capability(fn)` is the explicit function crossing; raw host functions in `globals` are auto-wrapped with the same machinery. Arguments and results are copied, errors are sanitized, and disposal revokes the guest wrapper.
- Direct static ES5 `eval`/`Function` inputs may be compiled ahead of time. Runtime-generated source is rejected.
- `security: "trusted"` is an explicit compatibility mode. It preserves raw host identity, prototypes, getters, functions, and mutation behavior, and unwraps capability tokens in `globals` back to their raw callables so one literal serves both modes.
- ES5.1 does not standardize browser or application host objects. DOM, Figma, network, and Node APIs must cross sandbox mode as narrow `capability()` functions that consume and return copied data.
- A Worker provides a separately terminable execution agent and the host-side
  wall-clock timeout. Browser Workers have no portable hard memory quota;
  enforce source/input/output limits and use host-specific memory controls
  where available.
- Identifier protection is deterministic aliasing, not encryption. Minification, private source maps, and delivery controls belong in the deployment layer.
- Secrets must not be embedded in client-side output.

## Public API

```js
const { capability, compile } = require("sablejs");

const result = compile("var answer = 40 + 2; answer;", {
  optimization: "O2",
  security: "sandbox",
});

const save = capability((plainRecord) => ({ saved: true }));
```

`compile` returns generated CommonJS code, metadata, and deterministic pass/codegen statistics. Load the module, call `createInstance`, then call `run` and `dispose`.

TypeScript declarations for the whole surface (compile options, capability and source-map settings, the artifact's `CompiledProgram`/`RuntimeInstance` shapes, the worker client) ship in `types/` and are wired through the `exports` map; `npm run check:types` type-checks CJS and ESM fixtures against them. Runnable examples for Node, browser, Worker, Deno, Bun, build-time precompilation, artifact caching, and error handling live in `examples/`.

Compile options include the optimization level, security mode, inspection options (`dumpDir`, `includeHIR`, `dumpIR`), and the opt-in `sourceMap` option. Source maps are built from the `LOC` operations the frontend already places at each statement start: in map mode the optimizer retains them (via the shared `retainSourceLocations` flag it also uses for `preserveSourceLocations`), codegen lowers them to private markers stripped by a final pass that simultaneously builds the v3 map, and the Os candidate size model measures marker-free bytes so candidate selection is unchanged. Statement-level mappings at all four optimization levels, deterministic output, inline/external forms, `dumpDir` integration, the Node engine and browser integration evidence, and the virtual-source handling for static eval/Function bodies (runtime-dynamic eval stays unmapped) are covered in [source-maps.md](source-maps.md). With `sourceMap` unset, generated code and statistics are byte-for-byte identical to the pre-map build.

## Verification

- Unit tests: `npm test`
- Type declaration gate: `npm run check:types`
- Runnable examples gate: `npm run check:examples` — spawns every example in `examples/` exactly as `examples/README.md` documents (Node unconditionally; Deno and Bun when installed) and asserts on their documented output, so the corpus stays working in CI
- Pinned Test262 ES5.1 gate: `npm run upstream:fetch -- test262 && npm run test262`
- Performance smoke test: `npm run benchmark:smoke`
- Multi-suite comparison backends: `npm run benchmark:sunspider -- --backend=quickjs` and `npm run benchmark:kraken -- --backend=sablejs-sandbox`
- Real-world workloads: `npm run benchmark:workloads -- --backend=sablejs-sandbox`
- Differential fuzzing: `npm run test:differential` (2,000-case CI smoke) and `npm run fuzz:differential` (100,000-case campaign); mismatches land in `.cache/differential-failures/` with seeds, and `--minimize` runs statement-level delta debugging.

Test262 is pinned in `tools/upstreams.js`. The conformance runner verifies the checkout commit before executing any case and fails on a mismatch.
