"use strict";

// Quick start: compile an ES5.1 program, write the artifact, run it.
//
//   node examples/node/basic.cjs
//
// The guest program reads the `input` global, computes, and returns its
// final expression. `compile()` is the expensive part — in production do it
// at build time (see ../precompile) and ship only the artifact.

const fs = require("node:fs");
const path = require("node:path");
const { compile } = require("sablejs");

const guestSource = [
  "function price(input) {",
  "  return { total: input.price * 1.2, units: input.units };",
  "}",
  "price(input);",
].join("\n");

// Compile once. `security: "sandbox"` (the default) deep-copies `globals`
// so guest mutations never reach the host object graph.
const result = compile(guestSource, {
  optimization: "O2",
  security: "sandbox",
  sourceMap: {
    mode: "external",
    sourceFile: "guest.js",
    generatedFile: "program.cjs",
    sourceMapURL: "program.cjs.map",
  },
});

const outDir = path.join(__dirname, "..", ".cache", "node");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "program.cjs"), result.code);
if (result.map) {
  fs.writeFileSync(path.join(outDir, "program.cjs.map"), result.map);
}
console.log(`wrote ${result.code.length} bytes of generated code (+ map)`);

// The artifact is a plain CommonJS module — its only runtime dependency is
// the sablejs runtime. Run it:
const program = require(path.join(outDir, "program.cjs"));
const instance = program.createInstance({
  globals: { input: { price: 100, units: 2 } },
});

try {
  const value = instance.run(); // synchronous
  console.log("guest returned:", value); // { total: 120, units: 2 }
} finally {
  instance.dispose(); // revokes sandbox capabilities, frees the instance
}
