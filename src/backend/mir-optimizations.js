"use strict";

const { lowerToMIR, verifyMIR } = require("../ir/mir");

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function constant(value) {
  return { known: true, value };
}

function unknown() {
  return { known: false };
}

function instructionMap(scope) {
  return new Map(scope.instructions.map((instruction) => [instruction.offset, instruction]));
}

// Locals in a lightweight function are backed by a private array and cannot be
// observed by with/eval or captured closures. Parameters are deliberately
// excluded because sloppy arguments can alias them.
function canPropagateLocal(scope, index) {
  return scope.lightweight && !scope.script && index > scope.parameterCount;
}

function analysisMIR(hirProgram, stats, existingMIR) {
  if (existingMIR) {
    verifyMIR(existingMIR);
    return existingMIR;
  }
  const mir = lowerToMIR(hirProgram);
  if (stats.mir) stats.mir.builds += 1;
  verifyMIR(mir);
  return mir;
}

function runCopyPropagation(hirProgram, stats, existingMIR) {
  const mir = analysisMIR(hirProgram, stats, existingMIR);
  let propagated = 0;

  mir.scopes.forEach((mirScope) => {
    const hirScope = hirProgram.scopes.find((scope) => scope.id === mirScope.id);
    const instructions = instructionMap(hirScope);
    const baseValues = new Map(mirScope.values.map((value) => [
      value.id,
      own(value, "constant") ? constant(value.constant) : unknown(),
    ]));

    // Start with an empty environment in every block. This is intentionally
    // intra-block until local memory Phi nodes are introduced.
    mirScope.blocks.forEach((block) => {
      const locals = new Map();
      const values = new Map(baseValues);
      block.operations.forEach((operation) => {
        if (["GETLOCAL", "GETLOCAL2"].includes(operation.op)) {
          const index = operation.args[0];
          const local = locals.get(index);
          if (canPropagateLocal(hirScope, index) && local && local.known) {
            const instruction = instructions.get(operation.offset);
            instruction.optimized = { kind: "literal", value: local.value };
            operation.outputs.forEach((output) => values.set(output, local));
            propagated += 1;
          }
          return;
        }

        if (["SETLOCAL", "SETLOCAL2"].includes(operation.op)) {
          const index = operation.args[0];
          if (!canPropagateLocal(hirScope, index)) {
            locals.delete(index);
            return;
          }
          const input = values.get(operation.inputs[0]) || unknown();
          if (input.known) locals.set(index, input);
          else locals.delete(index);
          return;
        }

        if (["DELLOCAL", "DELLOCAL2"].includes(operation.op)) {
          locals.delete(operation.args[0]);
        }
      });
    });
  });

  stats.copyPropagation = { constantsPropagated: propagated };
  return mir;
}

function runLocalCSE(hirProgram, stats, existingMIR) {
  const mir = analysisMIR(hirProgram, stats, existingMIR);
  let eliminated = 0;

  mir.scopes.forEach((mirScope) => {
    const hirScope = hirProgram.scopes.find((scope) => scope.id === mirScope.id);
    if (!hirScope.lightweight || hirScope.script) return;
    const instructions = instructionMap(hirScope);

    mirScope.blocks.forEach((block) => {
      let previous = null;
      block.operations.forEach((operation) => {
        if (operation.op === "LOC") return;
        if (["GETLOCAL", "GETLOCAL2"].includes(operation.op) && previous &&
            previous.op === operation.op && previous.args[0] === operation.args[0]) {
          const instruction = instructions.get(operation.offset);
          if (!instruction.optimized) {
            instruction.optimized = { kind: "duplicate" };
            eliminated += 1;
          }
        }
        previous = operation;
      });
    });
  });

  stats.localCSE = { loadsEliminated: eliminated };
  return mir;
}

function sameAvailable(left, right) {
  if (left === right) return true;
  if (left === null || right === null || left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function meetAvailable(predecessors, outgoing) {
  let result = null;
  for (const predecessor of predecessors) {
    const available = outgoing.get(predecessor);
    // Do not infer availability from a partially processed predecessor set.
    // In particular, a loop header must wait for its backedge state.
    if (available === null) return null;
    if (result === null) {
      result = new Map(available);
      continue;
    }
    for (const [index, offset] of result) {
      if (available.get(index) !== offset) result.delete(index);
    }
  }
  return result;
}

function transferAvailable(block, incoming, hirInstructions, annotate, eligibleLocal) {
  if (incoming === null) return null;
  const available = new Map(incoming);
  block.operations.forEach((operation) => {
    if (["SETLOCAL", "SETLOCAL2", "DELLOCAL", "DELLOCAL2"].includes(operation.op)) {
      available.delete(operation.args[0]);
      return;
    }
    if (!["GETLOCAL", "GETLOCAL2"].includes(operation.op)) return;
    const instruction = hirInstructions.get(operation.offset);
    const index = operation.args[0];
    if (!eligibleLocal(index)) return;
    const producer = available.get(index);
    if (producer !== undefined && annotate && instruction && !instruction.optimized) {
      instruction.optimized = { kind: "reuse", sourceOffset: producer };
    } else if (producer === undefined) {
      available.set(index, operation.offset);
    }
  });
  return available;
}

// This is a conservative memory-aware GVN slice for private function locals.
// A value number remains available across blocks only when every predecessor
// carries the exact same dominating load and no path writes that local.
function runGlobalValueNumbering(hirProgram, stats, existingMIR) {
  const mir = analysisMIR(hirProgram, stats, existingMIR);
  let loadsEliminated = 0;
  let crossBlockLoadsEliminated = 0;

  mir.scopes.forEach((mirScope) => {
    const hirScope = hirProgram.scopes.find((scope) => scope.id === mirScope.id);
    if (!hirScope.lightweight || hirScope.script) return;
    const instructions = instructionMap(hirScope);
    const incoming = new Map();
    const outgoing = new Map();
    mirScope.blocks.forEach((block) => {
      incoming.set(block.start, block.start === mirScope.entry ? new Map() : null);
      outgoing.set(block.start, block.start === mirScope.entry ? new Map() : null);
    });

    let changed = true;
    let iterations = 0;
    while (changed) {
      changed = false;
      if (iterations++ > Math.max(100, mirScope.blocks.length * mirScope.blocks.length * 2)) {
        throw new Error(`GVN did not converge in scope ${mirScope.id}`);
      }
      mirScope.blocks.forEach((block) => {
        const nextIncoming = block.start === mirScope.entry
          ? new Map()
          : meetAvailable(block.predecessors, outgoing);
        const nextOutgoing = transferAvailable(
          block,
          nextIncoming,
          instructions,
          false,
          (index) => canPropagateLocal(hirScope, index)
        );
        if (!sameAvailable(incoming.get(block.start), nextIncoming)) {
          incoming.set(block.start, nextIncoming);
          changed = true;
        }
        if (!sameAvailable(outgoing.get(block.start), nextOutgoing)) {
          outgoing.set(block.start, nextOutgoing);
          changed = true;
        }
      });
    }

    const blockForOffset = new Map();
    mirScope.blocks.forEach((block) => block.operations.forEach((operation) => {
      blockForOffset.set(operation.offset, block.start);
    }));
    mirScope.blocks.forEach((block) => {
      const before = Array.from(instructions.values()).filter((instruction) =>
        instruction.optimized && instruction.optimized.kind === "reuse"
      ).length;
      transferAvailable(
        block,
        incoming.get(block.start),
        instructions,
        true,
        (index) => canPropagateLocal(hirScope, index)
      );
      const reused = Array.from(instructions.values()).filter((instruction) =>
        instruction.optimized && instruction.optimized.kind === "reuse"
      ).slice(before);
      loadsEliminated += reused.length;
      reused.forEach((instruction) => {
        if (blockForOffset.get(instruction.optimized.sourceOffset) !== block.start) {
          crossBlockLoadsEliminated += 1;
        }
      });
    });
  });

  stats.globalValueNumbering = { loadsEliminated, crossBlockLoadsEliminated };
  return mir;
}

function naturalLoopBlocks(scope, loop) {
  const blocks = new Map(scope.blocks.map((block) => [block.start, block]));
  const members = new Set([loop.header, loop.backedge]);
  const work = loop.backedge === loop.header ? [] : [loop.backedge];
  while (work.length) {
    const start = work.pop();
    const block = blocks.get(start);
    if (!block) continue;
    block.predecessors.forEach((predecessor) => {
      if (members.has(predecessor)) return;
      members.add(predecessor);
      if (predecessor !== loop.header) work.push(predecessor);
    });
  }
  return members;
}

function loopRegionForHeader(hirScope, header) {
  return (hirScope.controlRegions || []).find((region) =>
    ["While", "DoWhile", "For", "ForIn"].includes(region.kind) &&
    [region.testStart, region.bodyStart, region.start].includes(header)
  );
}

// Only private non-parameter local reads are hoisted. Such reads cannot invoke
// guest code, and lightweight scopes prove that with/eval/closures cannot
// mutate the slot. A loop-local write remains a hard kill.
function runLoopInvariantCodeMotion(hirProgram, stats, existingMIR) {
  const mir = analysisMIR(hirProgram, stats, existingMIR);
  let loadsHoisted = 0;
  let usesReplaced = 0;

  mir.scopes.forEach((mirScope) => {
    const hirScope = hirProgram.scopes.find((scope) => scope.id === mirScope.id);
    if (!hirScope.lightweight || hirScope.script || !mirScope.loops.length) return;
    const instructions = instructionMap(hirScope);
    const loopPlans = mirScope.loops.map((loop) => ({
      ...loop,
      blocks: naturalLoopBlocks(mirScope, loop),
      region: loopRegionForHeader(hirScope, loop.header),
    })).filter((loop) => loop.region);
    if (!loopPlans.length) return;
    loopPlans.sort((left, right) => left.blocks.size - right.blocks.size);

    const operationsByBlock = new Map(mirScope.blocks.map((block) => [block.start, block.operations]));
    loopPlans.forEach((loop) => {
      loop.writes = new Set();
      loop.blocks.forEach((start) => (operationsByBlock.get(start) || []).forEach((operation) => {
        if (["SETLOCAL", "SETLOCAL2", "DELLOCAL", "DELLOCAL2"].includes(operation.op)) {
          loop.writes.add(operation.args[0]);
        }
      }));
      loop.hoisted = new Map();
    });

    mirScope.blocks.forEach((block) => block.operations.forEach((operation) => {
      if (!["GETLOCAL", "GETLOCAL2"].includes(operation.op)) return;
      const index = operation.args[0];
      if (!canPropagateLocal(hirScope, index)) return;
      const loop = loopPlans.find((candidate) =>
        candidate.blocks.has(block.start) && !candidate.writes.has(index)
      );
      if (!loop) return;
      const instruction = instructions.get(operation.offset);
      if (!instruction || instruction.optimized) return;
      if (!loop.hoisted.has(index)) {
        loop.hoisted.set(index, operation.offset);
        loadsHoisted += 1;
      }
      instruction.optimized = {
        kind: "licm",
        header: loop.header,
        sourceOffset: loop.hoisted.get(index),
        localIndex: index,
      };
      usesReplaced += 1;
    }));

    hirScope.loopInvariantLoads = loopPlans.flatMap((loop) =>
      Array.from(loop.hoisted, ([localIndex, sourceOffset]) => ({
        header: loop.header,
        localIndex,
        sourceOffset,
      }))
    );
  });

  stats.loopInvariantCodeMotion = { loadsHoisted, usesReplaced };
  return mir;
}

function runDeadCodeElimination(hirProgram, stats, existingMIR) {
  const mir = analysisMIR(hirProgram, stats, existingMIR);
  let operationsRemoved = 0;
  let stackDropsInserted = 0;

  mir.scopes.forEach((mirScope) => {
    const hirScope = hirProgram.scopes.find((scope) => scope.id === mirScope.id);
    const instructions = instructionMap(hirScope);
    const values = new Map(mirScope.values.map((value) => [value.id, value]));

    mirScope.blocks.forEach((block) => {
      for (let index = 0; index < block.operations.length; index += 1) {
        const producer = block.operations[index];
        if (producer.effect !== "Pure" || producer.outputs.length !== 1) continue;
        const output = values.get(producer.outputs[0]);
        if (!output || output.uses.length !== 1 || output.uses[0].kind !== "Operation") continue;

        let consumerIndex = index + 1;
        while (consumerIndex < block.operations.length && block.operations[consumerIndex].op === "LOC") {
          consumerIndex += 1;
        }
        const consumer = block.operations[consumerIndex];
        if (!consumer || consumer.op !== "POP" || consumer.inputs[0] !== output.id) continue;

        const producerInstruction = instructions.get(producer.offset);
        const popInstruction = instructions.get(consumer.offset);
        if (!producerInstruction || !popInstruction || producerInstruction.elided || popInstruction.elided) continue;

        if (producer.inputs.length === 0) {
          producerInstruction.elided = true;
        } else {
          producerInstruction.optimized = { kind: "drop-inputs", count: producer.inputs.length };
          stackDropsInserted += producer.inputs.length;
        }
        popInstruction.elided = true;
        operationsRemoved += 2;
      }
    });
  });

  stats.deadCodeElimination = { operationsRemoved, stackDropsInserted };
  stats.deadOperationsRemoved += operationsRemoved;
  return mir;
}

module.exports = {
  runCopyPropagation,
  runDeadCodeElimination,
  runGlobalValueNumbering,
  runLocalCSE,
  runLoopInvariantCodeMotion,
};
