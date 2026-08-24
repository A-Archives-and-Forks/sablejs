# Security model and threat model

sablejs compiles ES5.1 source ahead of time into direct JavaScript. The security goal is **controlled execution**: untrusted, user-authored, or AI-generated code must be able to compute with copied data through a narrow, explicit API — and must not reach host objects, host globals, or host code paths.

## Threat model

- **Attacker**: the author of the compiled program. They may write any ES5.1 program, including malicious reflection (`constructor` chains), prototype pollution, exotic objects (proxies, accessors), oversized inputs, and infinite loops.
- **Trusted**: the compiler and its output-generation, the runtime module, the host application that loads the compiled module, and every host function injected as a capability (explicitly or auto-wrapped).
- **Untrusted**: everything the guest program constructs at runtime, plus all values it imports from `globals` (copied, so mutations cannot reach host data).
- **Out of scope**: CPU and memory exhaustion. A Worker supplies time and memory budgets and forceful termination; the language boundary alone does not. Secrets must never be embedded in client-side bundles, because generated code ships to the client.

## Components and their trust boundaries

| Component | Trust | Responsibility |
| --- | --- | --- |
| Compiler (`src/compiler`, `src/frontend`, `src/ir`, `src/backend`, `src/codegen`) | Trusted, build-time | Parse and lower ES5.1 into CommonJS. Rejects dynamic source at runtime; literal `eval`/`Function` inputs are compiled ahead of time. |
| Generated code | Untrusted | Runs guest semantics through the runtime. Contains no `eval`, `new Function`, or dispatcher loop. |
| Runtime (`src/runtime`) | Trusted | Frames, calls, arguments, and property semantics. All guest operations on shared values route through the boundary. |
| Sandbox boundary (`src/runtime/security.js`) | Trusted, the mediation point | Every crossing between guest code and host values: reads, writes, calls, construction, cloning, and capability dispatch. |
| `capability()` | Trusted, host-authored | Explicit capability wrapping; raw host functions in `globals` are auto-wrapped with the same machinery. Arguments and results are deep-copied; errors are sanitized; disposal revokes the guest wrapper. |
| Worker | Host resource layer | Timeouts, memory isolation, termination. Not part of the language boundary. |

The boundary model: the guest may **read** shared intrinsics, but never **mutate** them, never **construct** dynamic code, and never receive an unmediated host function or ambient host object. The full regression corpus for these guarantees lives in `test/unit/security.test.js` (the adversarial battery, run at every optimization level).

## Object taxonomy

- **Protected intrinsics**: `Object`, `Array`, `Math`, prototypes, and everything reachable from the standard intrinsic roots. Readable, callable (mediated), never mutable by the guest. Mutation attempts throw a boundary `TypeError`.
- **Guest-owned objects**: everything the guest creates (`{}`, `new Date`, arrays, proxies). Fully mutable; never reachable from host code except through capability copying.
- **Injected data**: `globals` entries are recursively copied at `createInstance`. Raw host functions are auto-wrapped as capabilities; accessors, symbols, custom prototypes, class instances, and ambient objects (`globalThis`, `process`) are rejected; cycles and shared references are preserved inside the copy.
- **Capability tokens**: frozen null-prototype objects produced by `capability(fn)`. Explicit tokens materialize as wrappers in sandbox mode and are unwrapped back to their raw callables in trusted mode.
- **Wrappers**: mediated host functions delivered to the guest. They re-mediate every call; their raw targets are stored in a module-private WeakMap (trap-free — guest proxies never run a trap during resolution), and their own `toString` is redacted. `Function.prototype.toString` refuses wrapper receivers outright.

## Explicit policies

- **Dynamic code**: `Function`/`eval` with runtime-generated source are rejected. Literal inputs are AOT-compiled into guest code whose `this` is the guest global.
- **Shared intrinsic mutation**: blocked through every mutator family, including indirect forms (`Object.defineProperty.call`, `bind`, `Reflect.*`, `Array.prototype.push.call`, `__defineGetter__`, the `__proto__` setter, `Error.captureStackTrace`, and proxy-wrapping protected targets).
- **`Error.captureStackTrace`**: not part of ES5.1; the sandbox refuses it outright (it would write a host stack onto guest receivers).
- **Host stack disclosure**: boundary errors carry no stack; capability errors are sanitized copies. Host file paths do not cross the boundary.
- **`Proxy`**: the guest may wrap its own objects; wrapping protected intrinsics is blocked. Traps execute as guest code with mediated entries.
- **`Symbol`**: guest symbols work normally. The boundary keeps no symbol tags on wrappers or guest-visible values: the wrapper→target mapping lives in a module-private WeakMap, so introspection (ownKeys/descriptors) and proxy traps can never observe, forge, or strip a boundary marker. The only symbols a guest may enumerate on an intrinsic are the intrinsic's own spec tags (`Symbol.toStringTag` on `Math`/`JSON`).
- **Write-target resolution**: `writeTarget` resolves the write target and asserts mutability in one pass, trap-free. The WeakMap lookup and the protected-set check are synchronous — no guest code can run between resolution and the write — so guest proxies cannot steer resolution (their traps never fire during it), and the resolved object is always the written object. Writes made inside guest proxy traps are mediated the same as any guest write.
- **`SharedArrayBuffer` / `Atomics`**: `Atomics` is exposed as an optional intrinsic. SharedArrayBuffer values are rejected by capability copying, so shared memory cannot cross the boundary.
- **`Intl`**: exposed as an optional host intrinsic only; no data is copied or cached by sablejs.
- **`Map` / `Set` / typed arrays / Buffer**: constructible and mutable by the guest; capability copies clone them. Node `Buffer` clones into plain `Uint8Array` views so host-only prototype methods never cross.
- **`arguments.callee` / `caller`**: resolved only across compiled guest frames; strict-mode accessors throw. Host frames never appear.
- **Cross-instance smuggling**: every callable the runtime manufactures — guest closures from either mode, capability wrappers, mediated intrinsic wrappers — is branded; passing one as `globals` to another instance is rejected.
- **Auto-wrapped functions**: a raw host function anywhere in `globals` becomes a per-instance capability — name `fn.name` or the property path it was found at or `"capability"`, `thisValue` `undefined` unless set explicitly, one shared wrapper per clone when the same function appears at several paths, and only the function value crosses (its own properties do not). `capability()` remains the explicit form for custom names and receivers. In trusted mode the same literal is served by unwrapping tokens to raw callables, preserving reference identity.
- **Intrinsic snapshot**: the protected-intrinsic graph is captured when the first sandbox instance is created and shared by every instance (the walk cost dominated short-program startup). The host must not extend intrinsic prototypes after that point: functions added later are still wrapped on read but are denied on call (fail-closed), while non-function objects added later are not in the protected set and could be written by the guest. Extend intrinsics before creating the first instance.
- **Host-initiated guest entries**: a guest function returned from `run()` and called by the host copies its arguments and receiver like `globals`, so guest mutations cannot reach host objects through them. Nested host callbacks during execution (proxy traps, `Map`/`Set` iteration callbacks, `JSON.stringify`'s `toJSON`, regex replace callbacks) keep guest reference semantics. The distinction is per-instance execution state, not caller identity.

## What the boundary does not provide

- CPU or memory budgets — use a dedicated Worker and terminate it on budget exhaustion.
- Protection of secrets placed in the client bundle.
- Identifier encryption — identifier protection is deterministic aliasing for obfuscation, not secrecy.

## Verification

- Adversarial battery: `npm test` (127 tests, 0 skipped, every optimization level).
- Pinned Test262 gate: `npm run upstream:fetch -- test262 && npm run test262`.
- Differential fuzzing: `npm run test:differential` (CI smoke) and `npm run fuzz:differential` (campaign).
- New escape fixes must add a permanent regression test to the adversarial battery.

### Historical audit record (2026-08-22)

An internal boundary audit completed on 2026-08-22 found no known usable escape within the tested threat model — no host-code execution and no host-object-graph access through the reviewed paths. It produced three findings, all fixed with permanent regressions:

- **Finding 1 (high) — O2/Os codegen/mediation contract mismatch.** Direct property reads assumed bare host values, but dynamic scopes (`eval`/`with`/`try-catch`) delivered wrappers through `getVar`; legal programs crashed under default O2, and observable behavior drifted across optimization levels. Fixed by mediating all property reads in non-direct scopes and propagating the mediated source through chained reads; behavior is now consistent across O0/O1/O2/Os.
- **Finding 2 (low) — host stack-frame disclosure.** Host file paths leaked through `Error.captureStackTrace.call(guestObj)`, boundary errors thrown unwashed into guest catches, and `Function.prototype.toString.call(wrapper)`. Fixed by stripping boundary-error stacks, rejecting `Error.captureStackTrace` outright (not ES5.1), and a redacted shared wrapper `toString` with refusal of bare `Function.prototype.toString` on wrapper receivers.
- **Finding 3 (defense-in-depth) — `callHost` re-dispatch of raw functions outside the protection sets.** The reachable set was audited and found benign; Buffer clones now arrive as plain `Uint8Array` (no `Buffer.prototype`), and the `HOST_TARGET` tag narrowed the surface. A hard whitelist was deliberately not added — revisit when new host APIs cross.
- **Finding 4 (low, defense-in-depth) — guest-observable wrapper tag.** The `HOST_TARGET` symbol tag could be *observed*: guest proxy get traps fired with the symbol during write-target resolution and ownKeys redirection, `Reflect.ownKeys` enumerated it on wrappers, and a trap returning a wrapper could steer resolution toward that wrapper's host target. Not usable alone (the resolved target was still protected-checked), but it disclosed boundary internals and invited future attacks on the tag. Fixed by replacing the symbol tag with a module-private `wrapperTargets` WeakMap: `WeakMap.get` is trap-free, unforgeable, and unobservable, so write-target resolution is now single-pass and guest traps cannot influence it. Regressions: the boundary-internals sweep (no symbols on wrappers or intrinsics beyond their own spec tags), trap-observation checks during writes and introspection, and trap-steering checks.
- **Clone hardening (same audit)** — the recursive `cloneValue` was rewritten iteratively (an explicit work stack bounds depth by memory instead of the host call stack, so pathologically deep payloads clone instead of overflowing the stack inside the boundary), and the entry-level checks (ambient objects, capability records, functions, primitives) now run per node so nested values keep their specific messages. New regressions cover sparse arrays, 100k-deep graphs with cycles, 50k-key objects, null-prototype data, Map/Set key and member identity across the graph, and typed-array/DataView/Buffer prototype stripping.

Verified-sound mechanisms (instrumented checks): the `pendingGuestEntries` counter closes the nested-callback re-entry window (a guest entry always re-secures values); every `Function`-constructor path converges on the sentinel/`CODE_CONSTRUCTORS` check; literal `eval`/`Function` inputs are AOT-compiled and runtime-generated source is rejected; capability copying (clone, sanitization, thenable rejection, `SharedArrayBuffer` rejection, revoke on dispose) held; cross-instance smuggling is rejected.

Blocked-probe checklist (100+ probes × O0/O2/Os): Function-constructor chains (A1–A21), prototype pollution (B1–B39: the `defineProperty` family, `Reflect.*`, all array mutators, `Date` setters, `Map`/`Set`/`WeakMap`/`WeakSet`, `RegExp.compile`, `captureStackTrace` on protected targets, proxy-wrapping protected objects, `delete`, `with`-writes, `TypedArray.set`, the `__proto__` setter), intrinsic read-onlyness, absent host globals (`process`/`require`/`global`/`module` undefined), `arguments.callee`/`caller` guest isolation, strict-mode restricted accessors, host proxies executing traps host-side only, and the boundary-internals sweep: enumeration of wrappers and intrinsics (no symbols beyond `Symbol.toStringTag`), trap observation during writes and introspection, trap attempts to steer write resolution, and protected writes attempted from inside proxy traps.
