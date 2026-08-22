# Security model and threat model

sablejs compiles ES5.1 source ahead of time into direct JavaScript. The security goal is **controlled execution**: untrusted, user-authored, or AI-generated code must be able to compute with copied data through a narrow, explicit API — and must not reach host objects, host globals, or host code paths.

## Threat model

- **Attacker**: the author of the compiled program. They may write any ES5.1 program, including malicious reflection (`constructor` chains), prototype pollution, exotic objects (proxies, accessors), oversized inputs, and infinite loops.
- **Trusted**: the compiler and its output-generation, the runtime module, the host application that loads the compiled module, and every function wrapped with `capability()`.
- **Untrusted**: everything the guest program constructs at runtime, plus all values it imports from `globals` (copied, so mutations cannot reach host data).
- **Out of scope**: CPU and memory exhaustion. A Worker supplies time and memory budgets and forceful termination; the language boundary alone does not. Secrets must never be embedded in client-side bundles, because generated code ships to the client.

## Components and their trust boundaries

| Component | Trust | Responsibility |
| --- | --- | --- |
| Compiler (`src/compiler`, `src/frontend`, `src/ir`, `src/backend`, `src/codegen`) | Trusted, build-time | Parse and lower ES5.1 into CommonJS. Rejects dynamic source at runtime; literal `eval`/`Function` inputs are compiled ahead of time. |
| Generated code | Untrusted | Runs guest semantics through the runtime. Contains no `eval`, `new Function`, or dispatcher loop. |
| Runtime (`src/runtime`) | Trusted | Frames, calls, arguments, and property semantics. All guest operations on shared values route through the boundary. |
| Sandbox boundary (`src/runtime/security.js`) | Trusted, the mediation point | Every crossing between guest code and host values: reads, writes, calls, construction, cloning, and capability dispatch. |
| `capability()` | Trusted, host-authored | The only supported function crossing. Arguments and results are deep-copied; errors are sanitized; disposal revokes the guest wrapper. |
| Worker | Host resource layer | Timeouts, memory isolation, termination. Not part of the language boundary. |

The boundary model: the guest may **read** shared intrinsics, but never **mutate** them, never **construct** dynamic code, and never receive an unmediated host function or ambient host object. The full regression corpus for these guarantees lives in `test/unit/security.test.js` (the adversarial battery, run at every optimization level).

## Object taxonomy

- **Protected intrinsics**: `Object`, `Array`, `Math`, prototypes, and everything reachable from the standard intrinsic roots. Readable, callable (mediated), never mutable by the guest. Mutation attempts throw a boundary `TypeError`.
- **Guest-owned objects**: everything the guest creates (`{}`, `new Date`, arrays, proxies). Fully mutable; never reachable from host code except through capability copying.
- **Injected data**: `globals` entries are recursively copied at `createInstance`. Functions, accessors, symbols, custom prototypes, class instances, and ambient objects (`globalThis`, `process`) are rejected; cycles and shared references are preserved inside the copy.
- **Capability tokens**: frozen null-prototype objects produced by `capability(fn)`. Only these cross the boundary as callables.
- **Wrappers**: mediated host functions delivered to the guest. They re-mediate every call; their raw targets are stored behind a guest-invisible symbol tag, and their own `toString` is redacted. `Function.prototype.toString` refuses wrapper receivers outright.

## Explicit policies

- **Dynamic code**: `Function`/`eval` with runtime-generated source are rejected. Literal inputs are AOT-compiled into guest code whose `this` is the guest global.
- **Shared intrinsic mutation**: blocked through every mutator family, including indirect forms (`Object.defineProperty.call`, `bind`, `Reflect.*`, `Array.prototype.push.call`, `__defineGetter__`, the `__proto__` setter, `Error.captureStackTrace`, and proxy-wrapping protected targets).
- **`Error.captureStackTrace`**: not part of ES5.1; the sandbox refuses it outright (it would write a host stack onto guest receivers).
- **Host stack disclosure**: boundary errors carry no stack; capability errors are sanitized copies. Host file paths do not cross the boundary.
- **`Proxy`**: the guest may wrap its own objects; wrapping protected intrinsics is blocked. Traps execute as guest code with mediated entries.
- **`Symbol`**: guest symbols work normally. The boundary's wrapper tag is a module-private symbol that introspection entry points (ownKeys/descriptors) redirect away from, so guests cannot discover, forge, or strip it.
- **`SharedArrayBuffer` / `Atomics`**: `Atomics` is exposed as an optional intrinsic. SharedArrayBuffer values are rejected by capability copying, so shared memory cannot cross the boundary.
- **`Intl`**: exposed as an optional host intrinsic only; no data is copied or cached by sablejs.
- **`Map` / `Set` / typed arrays / Buffer**: constructible and mutable by the guest; capability copies clone them. Node `Buffer` clones into plain `Uint8Array` views so host-only prototype methods never cross.
- **`arguments.callee` / `caller`**: resolved only across compiled guest frames; strict-mode accessors throw. Host frames never appear.
- **Cross-instance smuggling**: guest functions passed as `globals` to another instance are rejected; each instance owns its guest-function registry.
- **Intrinsic snapshot**: the protected-intrinsic graph is captured when the first sandbox instance is created and shared by every instance (the walk cost dominated short-program startup). The host must not extend intrinsic prototypes after that point: functions added later are still wrapped on read but are denied on call (fail-closed), while non-function objects added later are not in the protected set and could be written by the guest. Extend intrinsics before creating the first instance.
- **Host-initiated guest entries**: a guest function returned from `run()` and called by the host copies its arguments and receiver like `globals`, so guest mutations cannot reach host objects through them. Nested host callbacks during execution (proxy traps, `Map`/`Set` iteration callbacks, `JSON.stringify`'s `toJSON`, regex replace callbacks) keep guest reference semantics. The distinction is per-instance execution state, not caller identity.

## What the boundary does not provide

- CPU or memory budgets — use a dedicated Worker and terminate it on budget exhaustion.
- Protection of secrets placed in the client bundle.
- Identifier encryption — identifier protection is deterministic aliasing for obfuscation, not secrecy.

## Verification

- Adversarial battery: `npm test` (110 tests, 0 skipped, every optimization level).
- Pinned Test262 gate: `npm run upstream:fetch -- test262 && npm run test262`.
- Differential fuzzing: `npm run test:differential` (CI smoke) and `npm run fuzz:differential` (campaign).
- New escape fixes must add a permanent regression test to the adversarial battery.

### Historical audit record (2026-08-22)

An internal boundary audit completed on 2026-08-22 found no known usable escape within the tested threat model — no host-code execution and no host-object-graph access through the reviewed paths. It produced three findings, all fixed with permanent regressions:

- **Finding 1 (high) — O2/Os codegen/mediation contract mismatch.** Direct property reads assumed bare host values, but dynamic scopes (`eval`/`with`/`try-catch`) delivered wrappers through `getVar`; legal programs crashed under default O2, and observable behavior drifted across optimization levels. Fixed by mediating all property reads in non-direct scopes and propagating the mediated source through chained reads; behavior is now consistent across O0/O1/O2/Os.
- **Finding 2 (low) — host stack-frame disclosure.** Host file paths leaked through `Error.captureStackTrace.call(guestObj)`, boundary errors thrown unwashed into guest catches, and `Function.prototype.toString.call(wrapper)`. Fixed by stripping boundary-error stacks, rejecting `Error.captureStackTrace` outright (not ES5.1), and a redacted shared wrapper `toString` with refusal of bare `Function.prototype.toString` on wrapper receivers.
- **Finding 3 (defense-in-depth) — `callHost` re-dispatch of raw functions outside the protection sets.** The reachable set was audited and found benign; Buffer clones now arrive as plain `Uint8Array` (no `Buffer.prototype`), and the `HOST_TARGET` tag narrowed the surface. A hard whitelist was deliberately not added — revisit when new host APIs cross.

Verified-sound mechanisms (instrumented checks): the `pendingGuestEntries` counter closes the nested-callback re-entry window (a guest entry always re-secures values); every `Function`-constructor path converges on the sentinel/`CODE_CONSTRUCTORS` check; literal `eval`/`Function` inputs are AOT-compiled and runtime-generated source is rejected; capability copying (clone, sanitization, thenable rejection, `SharedArrayBuffer` rejection, revoke on dispose) held; cross-instance smuggling is rejected.

Blocked-probe checklist (100+ probes × O0/O2/Os): Function-constructor chains (A1–A21), prototype pollution (B1–B39: the `defineProperty` family, `Reflect.*`, all array mutators, `Date` setters, `Map`/`Set`/`WeakMap`/`WeakSet`, `RegExp.compile`, `captureStackTrace` on protected targets, proxy-wrapping protected objects, `delete`, `with`-writes, `TypedArray.set`, the `__proto__` setter), intrinsic read-onlyness, absent host globals (`process`/`require`/`global`/`module` undefined), `arguments.callee`/`caller` guest isolation, strict-mode restricted accessors, and host proxies executing traps host-side only.
