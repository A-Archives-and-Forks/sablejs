# Migrating from sablejs v1 to v2

[README](../README.md) · [Get started](../README.md#quick-start) · [Choosing an execution model](comparison.md) · [Security](security.md) · [Performance](performance.md)

Sablejs v2 is an architectural redesign, not a drop-in runtime upgrade. V1
compiled source into an opcode payload for an embedded interpreter and exposed
boxed VM values. V2 compiles guest source into a CommonJS artifact that runs as
direct host JavaScript behind copied-data and capability boundaries.

The npm `latest` tag remains on v1 while v2 is in beta. Install v2 explicitly:

```sh
npm install sablejs@beta
```

## What changed

| v1 | v2 |
| --- | --- |
| Global `sablejs` CLI | Programmatic `compile()` API in a build step or cache |
| Base64/JSON opcode payload | Generated CommonJS artifact |
| `require("sablejs/runtime")()` VM constructor | `program.createInstance({ globals })` |
| Boxed values and `create*`/`as*` helpers | Standard JavaScript values copied across the sandbox boundary |
| `vm.createFunction()` host bindings | Raw functions in `globals` or explicit `capability()` tokens |
| `vm.run(payload)` | `instance.run()` on a single-run instance |
| `vm.destroy()` | `instance.dispose()` |
| Embedded interpreter | AOT-generated host JavaScript plus the sablejs runtime |
| Source hiding through encoded opcodes | Identifier aliasing only; never treat client output as secret storage |

V1 artifacts cannot run on v2. Recompile every guest program and deploy the v2
runtime with the resulting artifacts.

## Replace the CLI build

V1 commonly compiled a file with the global CLI:

```sh
sablejs -i guest.js -o output
```

In v2, keep compilation in a trusted build process or server-side cache:

```js
// build.cjs
const fs = require("node:fs");
const { compile } = require("sablejs");

const source = fs.readFileSync("guest.js", "utf8");
const result = compile(source, {
  optimization: "O2",
  security: "sandbox",
  sourceMap: {
    mode: "external",
    sourceFile: "guest.js",
    generatedFile: "guest.cjs",
    sourceMapURL: "guest.cjs.map",
  },
});

fs.writeFileSync("guest.cjs", result.code);
fs.writeFileSync("guest.cjs.map", result.map);
```

Modern JavaScript must first be downleveled to ES5.1 with Babel or SWC. See
[Worker isolation](worker-isolation.md) for a complete Babel + esbuild browser
pipeline.

## Replace the VM lifecycle

V1 created a reusable interpreter instance and passed it an opcode payload.
V2 loads the compiled module, creates a single-run instance, runs it, and
disposes it:

```js
const program = require("./guest.cjs");
const instance = program.createInstance({
  globals: { input: { price: 100 } },
});

try {
  console.log(instance.run());
} finally {
  instance.dispose();
}
```

Create a fresh instance for every run. Cache the compiled artifact, not the
runtime instance.

## Replace boxed values and host bindings

V1 host integrations manually created boxed VM values and functions. V2 uses
ordinary JavaScript data. Plain objects, arrays, supported built-ins, cycles,
and shared references are copied into sandbox mode.

Any raw host function in `globals` becomes a capability automatically:

```js
const instance = program.createInstance({
  globals: {
    input: { id: "record-1" },
    load: async function load(id) {
      return database.get(id); // return plain, copyable data
    },
  },
});
```

Use `capability()` when the host operation needs a stable public name or a
receiver:

```js
const { capability } = require("sablejs");

const save = capability(api.save, {
  name: "save",
  thisValue: api,
});
```

Capability arguments and results are copied, errors are sanitized, and the
guest wrapper is revoked when the instance is disposed. Class instances, DOM
nodes, Node APIs, and other ambient host objects should not be injected
directly; expose narrow operations that consume and return plain data.

## Add resource isolation explicitly

The language boundary restricts what code can reach, but it cannot preempt an
infinite loop or provide a portable browser memory quota. Run untrusted
compute-only programs in a dedicated Worker and enforce a timeout with
`sablejs/worker`. See [Worker isolation](worker-isolation.md) for browser and
Node patterns, including the rules for capabilities created inside a Worker.

## Review these behavioral changes

- Sandbox mode is the default; `security: "trusted"` passes host objects by
  reference and is only for fully trusted programs.
- Guest input is an ES5.1 script with no imports. Its final completion value is
  returned by `run()`.
- Runtime-generated `eval` and `Function` source is unavailable. Literal static
  inputs can be compiled ahead of time.
- Generated output is CommonJS. Bundle it with esbuild for browsers and other
  module formats.
- Source maps are opt-in. They are available as inline or external Source Map
  v3 output.
- A function returned by in-process `run()` can be called by the host, but
  functions cannot cross a Worker message channel.
- Generated identifiers may be aliased, but client-side artifacts and inline
  source maps are not secret storage.

## Migration checklist

1. Install `sablejs@beta` without removing v1 from production until the new
   path is verified.
2. Replace the global CLI with a trusted `compile()` build step or artifact
   cache.
3. Recompile every v1 payload; do not reuse encoded opcode output.
4. Replace boxed VM values with plain data and narrow capabilities.
5. Replace reusable `VM` instances with `createInstance()` → `run()` →
   `dispose()` per execution.
6. Add Worker isolation and host-side size limits where guest code is
   untrusted.
7. Run application tests at `O0` and the production optimization level, then
   verify source maps, timeout behavior, and capability error handling.

For the complete contracts, continue with [Security](security.md),
[Compatibility](compatibility.md), and the [examples](../examples/README.md).
