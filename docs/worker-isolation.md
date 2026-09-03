# Worker isolation

[README](../README.md) · [Get started](../README.md#quick-start) · [Migration](migration-v2.md) · [Security](security.md) · [Performance](performance.md)

The language boundary controls what guest code can reach. It deliberately does not control how long guest code runs or how much memory it uses. A dedicated Worker gives the host a separately terminable execution agent; `sablejs/worker` enforces a wall-clock timeout. Browser Workers do not expose a portable hard memory quota, so combine termination with source/input/output limits and host-specific memory controls where available. Never reuse a terminated Worker.

`sablejs/worker` provides the two small pieces that make this workflow reliable: a host-side client with per-run timeouts and response validation, and a worker-side message handler that creates and disposes an instance per request.

## Compiling at build time

Install the sablejs v2 beta, Babel, and esbuild:

```sh
npm install sablejs@beta
npm install --save-dev @babel/core @babel/preset-env esbuild
```

esbuild cannot fully lower ES6+ to ES5. Use it to normalize the input and build the final browser bundle; use Babel for the ES5.1 downlevel step.

Create `user-code.js`. Sandbox code should be a script with no imports and return its result as the final expression:

```js
const taxRate = 0.2;
({ total: input.price * (1 + taxRate) });
```

Create `build-sandbox.js`:

```js
const fs = require("node:fs");
const path = require("node:path");
const babel = require("@babel/core");
const presetEnv = require("@babel/preset-env");
const esbuild = require("esbuild");
const { compile } = require("sablejs");

async function build() {
  const source = fs.readFileSync("user-code.js", "utf8");
  const normalized = await esbuild.transform(source, {
    loader: "js",
    target: "es2015",
  });

  const es5 = babel.transformSync(normalized.code, {
    babelrc: false,
    configFile: false,
    sourceType: "script",
    presets: [[presetEnv, {
      modules: false,
      targets: { ie: "11" },
      useBuiltIns: false,
    }]],
  }).code;

  const generated = compile(es5, {
    optimization: "O1",
    runtimeModule: "sablejs/runtime",
  });

  fs.mkdirSync(".sable", { recursive: true });
  fs.writeFileSync(".sable/program.cjs", generated.code);

  await esbuild.build({
    entryPoints: [path.resolve("sandbox.worker.js")],
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile: "public/sandbox.worker.js",
  });
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

## Worker script

Wire the handler onto the compiled program (see Compiling at build time above):

```js
// sandbox.worker.js
const program = require("./.sable/program.cjs");
require("sablejs/worker").handleSandboxMessages(program);
```

Each message runs a fresh `createInstance` with the copied `input` and disposes it afterwards, so state never leaks between runs.

## Host side

```js
const { createSandboxClient } = require("sablejs/worker");

const worker = new Worker("/sandbox.worker.js");
const sandbox = createSandboxClient(worker, { timeoutMs: 1000 });

sandbox.run({ price: 100 }).then(
  (value) => console.log(value),            // { total: 120 }
  (error) => console.error(error.message)   // sanitized error string
);

// Later: terminate the worker and never reuse it.
sandbox.terminate();
```

- **The worker survives many runs**: `run()` can be called repeatedly on the same client. Each message creates a fresh instance in the worker and disposes it afterwards (program instances are single-run by design), so state never leaks between executions. A timeout, Worker error, or explicit `terminate()` makes the client unusable.
- **Results cross the message channel as plain data**: whatever the program returns must be structured-cloneable. Functions cannot cross the channel (the worker reports a sanitized error instead), so the "return a function from `run()`" pattern in the README works in-process only — through the worker, call one function invocation per message and pass its arguments in `input` (see Calling functions through the worker below).
- **Timeout**: `timeoutMs` (per run, overridable per call). On expiry the worker is terminated and the promise rejects; recreate the worker for further runs.
- **Response validation**: successes must carry `value`, failures must carry a sanitized `error` string. Malformed responses reject.
- **One run at a time is enforced** — the handler serializes messages, including Promise-returning capability calls, and does not create the next instance until the previous one is disposed. Callers may queue requests, though awaiting each call keeps backpressure explicit.

## Calling functions through the worker

The program ends with a function call, so each message runs one invocation with its arguments in `input`. `run()` is asynchronous — it returns a promise:

```js
// user-code.js
function price(input) {
  var tax = input.region === "eu" ? 0.2 : 0;
  return { total: input.base * (1 + tax) };
}
price(input);
```

```js
await sandbox.run({ base: 100, region: "us" }); // { total: 100 }
await sandbox.run({ base: 100, region: "eu" }); // { total: 120 }
```

To expose several functions behind one worker, dispatch on an `input` field:

```js
// user-code.js
var handlers = {
  price: function (args) { return { total: args.base * 1.2 }; },
  discount: function (args) { return { base: args.base, off: Math.min(args.off, args.base) }; },
};
handlers[input.op](input.args);
```

```js
async function call(op, args) {
  return sandbox.run({ op: op, args: args });
}

await call("price", { base: 100 });            // { total: 120 }
await call("discount", { base: 100, off: 30 }); // { base: 100, off: 30 }
```

Results come back as plain data (functions cannot cross the message channel; the in-process "return a function from `run()`" pattern in the README does not apply here). Each message runs a fresh instance, so calls are stateless by design — persist state on the host between calls. Calls may be queued, but one Worker executes them serially; use separate Workers for actual parallel execution.

## Capabilities and the Worker

The message channel carries structured-cloneable data only — functions, raw or wrapped, cannot cross it — so the stock handler injects just `input` (see Worker script above). Capabilities are an in-process feature of `createInstance`: the unified `globals` DX — raw host functions auto-wrap in sandbox mode, capability tokens unwrap in trusted mode — applies wherever you construct an instance yourself.

When a program needs host operations and a termination boundary together, write a custom worker script that builds the instance with its own globals, and let the host client enforce the timeout:

```js
// budget.worker.js — custom handler, capabilities built worker-side
const { capability } = require("sablejs");
const program = require("./.sable/program.cjs");

const save = capability(async function (record) {
  const response = await fetch("/api/records", {
    method: "POST",
    body: JSON.stringify(record),
  });
  return { saved: response.ok };
}, { name: "save" });

async function runMessage(message) {
  if (!message || typeof message.id !== "number") return;
  let instance;
  try {
    // Same globals literal as in-process code: raw functions auto-wrap,
    // explicit capability tokens are honored as-is.
    instance = program.createInstance({
      globals: { 
        save, 
        input: message.input 
      },
    });
    const result = instance.run();
    const value = result instanceof Promise ? await result : result;
    self.postMessage({
      id: message.id, 
      ok: true, 
      value,
    });
  } catch (error) {
    // Errors crossing the message channel must be sanitized strings.
    self.postMessage({
      id: message.id,
      ok: false,
      error: String((error && error.message) || error),
    });
  } finally {
    if (instance) instance.dispose();
  }
}

let queue = Promise.resolve();
self.onmessage = (event) => {
  const message = event.data;
  queue = queue.then(
    () => runMessage(message),
    () => runMessage(message)
  );
};
```

`globals` are fixed when the worker script is written — keep per-call data in `input`. Drive this handler with the same host client (`createSandboxClient(new Worker("/budget.worker.js"), ...)`), and it inherits per-run timeouts, response validation, and terminate-on-expiry. The `await` is required when a program can finish with a Promise-returning capability; the stock `handleSandboxMessages` performs the same wait and serialization.

Two caveats. First, in sandbox mode the guest never holds the raw host function: the auto-wrapped capability is a per-instance guest wrapper, so calls stay mediated inside the worker exactly as in-process. Second, `timeoutMs` budgets the whole run — keep it above the longest capability call so legitimate work is not killed (see Timeout-wrapping below for the per-call version).

**Node hosts.** The protocol targets the browser `Worker` shape (`addEventListener`, events with `.data`, `self` on the worker side). Under Node, run the worker script with `worker_threads` and pass the `parentPort` channel to `handleSandboxMessages` (`{ scope: parentPort, postMessage }`), and give the host client an adapter — `worker_threads.Worker` is an EventEmitter whose `"message"` events deliver the value directly rather than a `MessageEvent` with `.data`, so `addEventListener` must rebind `on` and normalize (`listener({ data: value })`). A complete working pair is in `examples/worker/` (`host.cjs` + `sandbox.worker.cjs`).

## Evaluating other programs

`run` executes the one program the worker was built with. `evaluate` executes any compiled artifact through the same worker — useful for many-short-program workloads such as AI-generated code:

```js
const { compile } = require("sablejs");

const artifact = compile("({ total: input.price * 1.2 });").code;
sandbox.evaluate(artifact, { price: 100 }).then(console.log, console.error);
```

- `evaluate(program, input)` ships the artifact code with the message; the worker loads it (caching the last artifact), runs a fresh instance, and disposes it — same protocol, validation, and timeout semantics as `run`. Results cross the message channel as plain data, so programs evaluated through the worker must return structured-cloneable values; for callable results use the in-process function pattern in the README.
- **Only send AOT-compiled artifacts, never user source.** The worker loads artifact code at worker privilege, exactly like the build pipeline does; the language boundary applies to the guest program, not to code the trusted host chooses to load. `compile()` belongs on the trusted host side.
- The default Node artifact loader uses `new Function` at Worker privilege. It
  therefore requires a CSP that permits dynamic code and must never receive
  attacker-controlled source. Deployments with a strict CSP should use
  build-time artifacts and `run()`, or provide a separately reviewed
  `options.loadProgram` implementation.
- The default artifact loader (`loadCompiledArtifact`) resolves the `sablejs/runtime` import through Node's package exports. In browser builds the runtime is bundled into the worker script; pass `options.loadProgram` to `handleSandboxMessages` to supply the bundled runtime when you load artifacts at runtime.

## Budgets beyond time

- **Source size**: enforce a limit before compilation (a few hundred KB is plenty for ES5.1 programs).
- **Input size**: validate and size-check `input` on the host before `run`.
- **Output size**: check the returned value's size on the host after the run.
- **Message validation**: never trust messages from the page to the worker or back; validate shape and types before use.

```js
function runWithBudgets(source, input, budgets) {
  if (source.length > budgets.sourceBytes) throw new Error("source too large");
  if (JSON.stringify(input).length > budgets.inputBytes) throw new Error("input too large");
  return sandbox.run(input).then((value) => {
    const bytes = JSON.stringify(value).length;
    if (bytes > budgets.outputBytes) throw new Error("output too large");
    return value;
  });
}
```

### Timeout-wrapping long or never-ending capabilities

A capability whose host promise never settles hangs the guest call forever:
the boundary awaits the promise before cloning the result back. Budgeting
that is the host's job, not the boundary's. Two cases, two tools. The
explicit `capability()` form is used below rather than the auto-wrap in
`globals` because the timeout wrapper needs its own `name` (surfaced in the
error the guest sees) — raw functions you pass in `globals` are wrapped with
the same machinery, but with no receiver and a derived name:

- **Async capabilities (promise-returning)** — wrap the host function in a
  `Promise.race` against a timer, so the guest call fails with a
  guest-visible error instead of hanging:

  ```js
  const { capability } = require("sablejs");

  function timeoutCapability(hostFunction, { name, timeoutMs, onTimeout } = {}) {
    return capability(async function (...args) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`capability ${name} timed out after ${timeoutMs} ms`);
          error.name = "TimeoutError";
          if (onTimeout) onTimeout(error, args);   // host-side bookkeeping
          reject(error);
        }, timeoutMs);
      });
      try {
        return await Promise.race([Promise.resolve(hostFunction(...args)), timeout]);
      } finally {
        clearTimeout(timer);
      }
    }, { name });
  }

  // The guest sees a sanitized TimeoutError instead of a permanent hang.
  const lookup = timeoutCapability(async (id) => querySlowBackend(id), {
    name: "lookup",
    timeoutMs: 250,
  });
  ```

  Two caveats that matter: `Promise.race` does **not** cancel the underlying
  operation — the host promise keeps running and its effects still happen;
  pass an `AbortSignal` through to the host function when cancellation is
  required. And keep the capability timeout well below the Worker's
  `timeoutMs`, so the failure surfaces as a guest-visible error first and
  the Worker kill is the backstop, not the primary mechanism.

- **Synchronous capabilities (busy loops, blocking I/O)** — no in-process
  wrapper can preempt these: while the host function spins, the event loop
  never gets to run the race timer. The Worker timeout is the only
  enforcement here; keep sync-blocking work short and run it inside the
  `timeoutMs` envelope of a dedicated Worker that you terminate on expiry
  (never reuse a terminated Worker).

## What the Worker does not provide

The Worker provides a termination boundary and host-enforced wall-clock
timeout, not a portable hard memory quota or the semantics of the language
boundary. Sandbox mode and Worker isolation are complementary: the boundary
restricts reach; the Worker lets the host stop execution. Neither protects
secrets placed in client-side bundles.
