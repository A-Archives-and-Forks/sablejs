"use strict";

// Worker side of the isolation example. This script runs inside a dedicated
// worker_threads Worker (or a browser Web Worker). It binds a precompiled
// artifact and lets the host drive it through the message protocol.
//
// Run `node examples/precompile/build.cjs` first — the artifact is loaded
// from the build output, so no compilation happens in this process.

const path = require("node:path");
const { parentPort } = require("node:worker_threads");
const program = require(path.join(__dirname, "..", "precompile", "out", "program.cjs"));

// handleSandboxMessages receives { id, input, program? } messages, runs each
// on a fresh instance, and posts validated { id, ok, value? | error? }
// responses. Requests are serialized; `evaluate` messages load artifact code
// at worker privilege.
//
// The defaults target a browser Web Worker (`self`); under worker_threads,
// the channel is parentPort, which speaks the same onmessage/postMessage
// contract.
const { handleSandboxMessages } = require("sablejs/worker");
handleSandboxMessages(program, {
  scope: parentPort,
  postMessage: (message) => parentPort.postMessage(message),
});

console.log("[worker] sandbox worker ready");
