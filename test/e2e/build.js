"use strict";

const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");
const { compile } = require("../../src/compiler");

const repositoryRoot = path.resolve(__dirname, "../..");
const outputDirectory = path.join(repositoryRoot, ".cache/e2e");
const generatedPath = path.join(outputDirectory, "generated.cjs");
const entryPath = path.join(outputDirectory, "entry.cjs");
const outputPath = path.join(outputDirectory, "program.js");
const runtimeModule = path.join(repositoryRoot, "src/runtime");

const source = `
var total = 0;

function Counter(start) {
  this.value = start;
}

Counter.prototype.add = function (step) {
  this.value += step;
  return this.value;
};

function multiplier(factor) {
  return function (value) {
    return value * factor;
  };
}

var counter = new Counter(seed);
var twice = multiplier(2);

for (var index = 0; index < 4; index += 1) {
  total += twice(counter.add(index));
}

({ total: total, finalValue: counter.value, label: platformLabel });
`;

const compiled = compile(source, { optimization: "O2", runtimeModule });

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(generatedPath, compiled.code);
fs.writeFileSync(entryPath, `
"use strict";

const program = require(${JSON.stringify(generatedPath)});
const instance = program.createInstance({
  globals: { seed: 7, platformLabel: "portable" },
});

let value;
try {
  value = instance.run();
} finally {
  instance.dispose();
}

const actual = {
  total: value.total,
  finalValue: value.finalValue,
  label: value.label,
};
const expected = { total: 76, finalValue: 13, label: "portable" };

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error("sablejs E2E mismatch: " + JSON.stringify(actual));
}

globalThis.__sablejs_e2e_result__ = actual;
console.log("sablejs E2E: " + JSON.stringify(actual));
`);

esbuild.buildSync({
  entryPoints: [entryPath],
  outfile: outputPath,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  logLevel: "warning",
});

console.log(
  `Built ${path.relative(repositoryRoot, outputPath)} ` +
  `(${(fs.statSync(outputPath).size / 1000).toFixed(1)} KB)`
);
