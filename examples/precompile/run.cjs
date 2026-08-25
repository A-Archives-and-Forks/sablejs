"use strict";

// Runtime side of the precompiled artifact. This file never imports the
// compiler — it requires the artifact produced by build.cjs and runs it
// with host data. In production this is your application code; the build
// step lives in CI and the artifact ships as a regular file.

//   node examples/precompile/build.cjs   (once, build time)
//   node examples/precompile/run.cjs     (every time, at runtime)

const fs = require("node:fs");
const path = require("node:path");

const outDir = path.join(__dirname, "out");
const programPath = path.join(outDir, "program.cjs");
if (!fs.existsSync(programPath)) {
  console.error("out/program.cjs is missing — run `node examples/precompile/build.cjs` first");
  process.exit(1);
}

const program = require(programPath);
const metadata = JSON.parse(fs.readFileSync(path.join(outDir, "metadata.json"), "utf8"));
console.log("artifact:", metadata.inputLanguage, "·", metadata.security, "·", metadata.optimize);

// `globals` is the host data the guest reads. Sandbox mode deep-copies it:
// the guest mutating `input` cannot reach the host object.
const instance = program.createInstance({
  globals: {
    input: {
      vip: true,
      items: [
        { price: 10, count: 2 },
        { price: 5, count: 4 },
      ],
    },
  },
});

try {
  const receipt = instance.run(); // synchronous
  console.log("receipt:", receipt); // { line: 32, ship: 10 }
} finally {
  instance.dispose();
}
