"use strict";

const OpSpec = require("./op-spec");

function verifyScope(scope, scopeIds) {
  if (!scope || scope.kind !== "FunctionHIR") throw new Error("Invalid FunctionHIR node");
  const boundaries = new Set([scope.codeLength]);
  let previousEnd = 0;

  scope.instructions.forEach((instruction) => {
    if (instruction.offset !== previousEnd) {
      throw new Error(`Non-contiguous HIR in scope ${scope.id} at ${instruction.offset}`);
    }
    const spec = OpSpec.byName[instruction.op];
    if (!spec) throw new Error(`Unknown HIR operation ${instruction.op}`);
    if (instruction.args.length !== spec.operands.length) {
      throw new Error(`Wrong operand count for ${instruction.op} in scope ${scope.id}`);
    }
    boundaries.add(instruction.offset);
    previousEnd = instruction.end;
  });

  if (previousEnd !== scope.codeLength) {
    throw new Error(`HIR length mismatch in scope ${scope.id}`);
  }

  scope.instructions.forEach((instruction) => {
    const spec = OpSpec.byName[instruction.op];
    spec.operands.forEach((type, index) => {
      const value = instruction.args[index];
      if (type === "jumpTarget" && !boundaries.has(value)) {
        throw new Error(`Jump from ${instruction.offset} targets the middle of an instruction: ${value}`);
      }
      if ((type === "functionIndex" || type === "evalIndex") && value !== -1) {
        if (!value || !scopeIds.has(value.id)) {
          throw new Error(`Invalid nested scope reference from scope ${scope.id}`);
        }
      }
    });
  });

  scope.dynamicFunctions.forEach((dynamicScope) => {
    if (dynamicScope !== -1 && (!dynamicScope || !scopeIds.has(dynamicScope.id))) {
      throw new Error(`Invalid dynamic function reference from scope ${scope.id}`);
    }
  });

  if (!Array.isArray(scope.controlRegions)) {
    throw new Error(`Missing control-region metadata in scope ${scope.id}`);
  }
  const regionIds = new Set();
  scope.controlRegions.forEach((region) => {
    if (!region || !Number.isInteger(region.id) || regionIds.has(region.id) ||
        !["If", "Conditional", "Logical", "While", "DoWhile", "For", "ForIn", "Switch", "TryCatch", "TryFinally", "Label"].includes(region.kind)) {
      throw new Error(`Invalid control region in scope ${scope.id}`);
    }
    regionIds.add(region.id);
    if (!boundaries.has(region.start) || !boundaries.has(region.end) || region.end < region.start) {
      throw new Error(`Invalid ${region.kind} region range in scope ${scope.id}`);
    }
    Object.keys(region).forEach((key) => {
      if (["id", "kind"].includes(key) || region[key] === null) return;
      if (typeof region[key] === "number" && key !== "id" && !boundaries.has(region[key])) {
        throw new Error(`Control region ${region.id} ${key} is not an instruction boundary`);
      }
    });
  });
  if (!Array.isArray(scope.syntheticRanges)) {
    throw new Error(`Missing synthetic-range metadata in scope ${scope.id}`);
  }
  scope.syntheticRanges.forEach((range) => {
    if (!range || range.kind !== "AbruptFinally" || !boundaries.has(range.start) ||
        !boundaries.has(range.end) || range.end <= range.start) {
      throw new Error(`Invalid synthetic range in scope ${scope.id}`);
    }
  });

  return true;
}

function verifyProgram(program) {
  if (!program || program.kind !== "ProgramHIR" || !Array.isArray(program.scopes)) {
    throw new TypeError("Invalid ProgramHIR");
  }
  const ids = new Set(program.scopes.map((scope) => scope.id));
  if (ids.size !== program.scopes.length || !ids.has(program.entry)) {
    throw new Error("ProgramHIR has duplicate scopes or an invalid entry scope");
  }
  program.scopes.forEach((scope) => verifyScope(scope, ids));
  return true;
}

module.exports = { verifyProgram, verifyScope };
