"use strict";

// Browser build: compile the guest source at build time, then bundle the
// artifact together with the sablejs runtime into a single script the page
// loads. Nothing compiles in the browser.
//
//   node examples/browser/build.cjs
//   then open examples/browser/index.html (or serve the directory)
//
// The inline source map keeps devtools usable: generated code maps back to
// guest.js (which is embedded as sourcesContent). For release builds drop
// `sourceMap` and `sourcesContent` — the default build is byte-identical to
// the map-off artifact.

const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const { compile } = require("sablejs");

const root = path.join(__dirname, "..", "..");
const guestPath = path.join(__dirname, "guest.js");
const outDir = path.join(__dirname, "dist");
const source = fs.readFileSync(guestPath, "utf8");

// `runtimeModule` makes the generated code import the runtime from this
// location so esbuild can resolve and bundle it (the runtime is a normal
// dependency in Node; the browser needs it in the bundle).
const result = compile(source, {
  optimization: "O2",
  security: "sandbox",
  runtimeModule: path.join(root, "src", "runtime"),
  sourceMap: {
    mode: "inline",
    sourceFile: "guest.js",
    generatedFile: "bundle.js",
    sourcesContent: true,
  },
});

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "artifact.cjs"), result.code);

// The bundle entry: load the artifact, run it once with host data, and put
// the guest's return value on the page.
const entry = `
"use strict";
const program = require("./artifact.cjs");
const instance = program.createInstance({
  globals: {
    input: {
      titles: ["sablejs", "ahead-of-time", "compiler", "runtime"],
      stamp: "from index.html",
    },
  },
});
try {
  globalThis.__sablejsResult__ = instance.run();
} finally {
  instance.dispose();
}
`;
fs.writeFileSync(path.join(outDir, "entry.cjs"), entry);

// esbuild traces the artifact's inline data-URL map when bundling, so the
// final bundle's inline map chains back to guest.js (devtools shows the
// guest source). The chained map is byte-identical in the source field to
// the one sablejs emitted: `sourceFile` is the logical "guest.js", never a
// path derived from this machine.
esbuild.buildSync({
  entryPoints: [path.join(outDir, "entry.cjs")],
  outfile: path.join(outDir, "bundle.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  sourcemap: "inline",
  logLevel: "warning",
});

const bundleBytes = fs.statSync(path.join(outDir, "bundle.js")).size;
console.log(`built dist/bundle.js (${bundleBytes} bytes): guest.js → artifact → browser bundle`);
console.log("open examples/browser/index.html");
