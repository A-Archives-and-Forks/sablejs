"use strict";

const { verifyProgram } = require("../ir/verify");

function liveInstructionCount(program) {
  return program.scopes.reduce((total, scope) => total + scope.instructions.reduce(
    (count, instruction) => count + (instruction.elided || instruction.unreachable ? 0 : 1),
    0
  ), 0);
}

class PassManager {
  constructor(program, stats, options = {}) {
    this.program = program;
    this.stats = stats;
    this.trace = typeof options.tracePasses === "function" ? options.tracePasses : null;
  }

  run(name, transform) {
    const before = liveInstructionCount(this.program);
    const startedAt = process.hrtime.bigint();
    transform(this.program, this.stats);
    verifyProgram(this.program);
    const after = liveInstructionCount(this.program);
    const pass = {
      name,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      nodesBefore: before,
      nodesAfter: after,
      nodesChanged: after - before,
    };
    this.stats.passes.push(pass);
    if (this.trace) this.trace(pass);
    return pass;
  }
}

module.exports = { PassManager, liveInstructionCount };
