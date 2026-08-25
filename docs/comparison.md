# Choosing an execution model

[README](../README.md) · [Get started](../README.md#quick-start) · [Migration](migration-v2.md) · [Security](security.md) · [Performance](performance.md)

Sablejs is one way to run user-authored or AI-generated JavaScript. It is most
useful when an application wants host-engine execution, build-time inspection,
source maps, and a narrow copied-data/capability boundary. It is not a universal
replacement for browser isolation or an embedded JavaScript VM.

## At a glance

| Model | Execution | Host boundary | Debugging | Typical fit |
| --- | --- | --- | --- | --- |
| sablejs | AOT-generated host JavaScript | copied data + explicit capabilities; use a Worker for termination | generated code, HIR/MIR, Source Map v3 | rules, formulas, transforms, plugins, and constrained AI-generated programs |
| QuickJS-WASM | JavaScript interpreted by a VM compiled to WebAssembly | explicit VM/host bridge | VM-specific tooling; browser DevTools do not directly execute guest frames | applications that need an embedded language runtime and broader runtime parsing |
| cross-origin iframe | browser JavaScript in a separate origin | asynchronous message passing and browser origin isolation | ordinary browser tooling in the frame | browser-only plugins that need their own document/UI and an origin boundary |
| raw `eval` / `new Function` | host JavaScript in the current realm | none unless the host builds and validates one | ordinary host-engine tooling | trusted code only |

These models do not provide interchangeable security guarantees. Deployment
details, browser behavior, the exposed API, resource controls, and the trusted
computing base matter more than the label of the mechanism.

## Why choose sablejs

- You can compile guest programs before deployment or cache compilation on a
  trusted server.
- You want to run on the host JavaScript engine without shipping an embedded
  interpreter.
- You need source maps and inspectable compiler output for generated code.
- Your host API can be expressed as copied data and narrow capabilities.
- ES5.1 is an acceptable compiler core, with modern syntax downleveled first.
- A dedicated Worker can provide the required wall-clock termination boundary.

## When another model may fit better

Choose an embedded VM such as QuickJS-WASM when runtime parsing, a VM-specific
language surface, or isolation from host-engine semantics matters more than AOT
output and direct DevTools integration.

Choose a cross-origin iframe when browser origin isolation, an independent DOM,
or plugin-owned UI is central to the design and asynchronous message passing is
acceptable.

Use raw `eval` or `new Function` only for code already trusted at the privilege
level of the surrounding realm. A Worker can make that code terminable, but a
Worker alone does not remove its access to APIs available inside that Worker.

## Performance comparisons

Performance depends on workload shape, startup, compilation strategy, host
engine, and boundary traffic. On the documented Linux x64 reference harness,
sablejs O2 sandbox reaches 1.86x the QuickJS-WASM V8 Benchmark Suite 7 score,
completes the 23-test SunSpider subset 1.16x faster, and completes the 14-test
Kraken subset 1.70x faster. These are harness-specific results, not universal
application claims. See [Performance](performance.md) for raw data, sampling,
adaptations, exclusions, artifact sizes, and reproduction commands.

## Security and resource boundaries

For untrusted programs, the intended sablejs deployment is the combination of:

1. `security: "sandbox"`;
2. copied input and narrow capabilities;
3. a dedicated Worker with a wall-clock timeout; and
4. host-enforced source, input, output, and platform-specific memory limits.

Read the [threat model](security.md) and [Worker isolation](worker-isolation.md)
before treating the boundary as part of a production security design.

Sablejs was inspired by Figma's
[journey to a WebAssembly-based plugin sandbox](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/)
and its later use of the
[QuickJS runtime](https://www.figma.com/plugin-docs/updates/2020/07/07/version-1-update-16/).
