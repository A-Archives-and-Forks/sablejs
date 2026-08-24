"use strict";

const assert = require("assert");
const { describe, it } = require("node:test");
const { parseRunnerReport } = require("../../tools/archive-test262");

describe("Test262 archive report parser", function () {
  it("parses the pretty JSON that follows quiet-mode progress lines", function () {
    const report = {
      revision: "3655e7464de3d52643ecddd4b5f9f4f3e7f62398",
      files: 100,
      failed: 0,
      failures: [],
    };
    const output = [
      "[ES5 PROGRESS] files=100, variants=200, passed=200, failed=0, host=0, policy=0",
      JSON.stringify(report, null, 2),
      "",
    ].join("\n");
    assert.deepStrictEqual(parseRunnerReport(output), report);
  });

  it("rejects output without a revision", function () {
    assert.throws(() => parseRunnerReport("{}"), /missing its revision/);
  });
});
