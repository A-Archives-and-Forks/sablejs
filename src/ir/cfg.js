"use strict";

const TERMINATORS = new Set([
  "JUMP", "JTRUE", "JFALSE", "JCASE", "RETURN", "THROW", "TRY", "ENDTRY",
]);
const TARGETED = new Set(["JUMP", "JTRUE", "JFALSE", "JCASE", "TRY"]);

function unique(values) {
  return Array.from(new Set(values));
}

function buildBasicBlocks(scope) {
  const boundaries = new Set([0, scope.codeLength]);
  scope.instructions.forEach((instruction) => {
    if (TARGETED.has(instruction.op)) boundaries.add(instruction.args[0]);
    if (TERMINATORS.has(instruction.op)) boundaries.add(instruction.end);
  });

  const starts = Array.from(boundaries).sort((left, right) => left - right);
  const blocks = [];
  let instructionIndex = 0;
  for (let index = 0; index < starts.length - 1; index += 1) {
    const start = starts[index];
    const end = starts[index + 1];
    if (start === end) continue;
    const instructions = [];
    while (instructionIndex < scope.instructions.length &&
           scope.instructions[instructionIndex].offset < end) {
      const instruction = scope.instructions[instructionIndex];
      if (instruction.offset >= start) instructions.push(instruction);
      instructionIndex += 1;
    }
    blocks.push({ id: blocks.length, start, end, instructions });
  }
  return blocks;
}

function successorEdges(block, codeLength) {
  const last = block.instructions[block.instructions.length - 1];
  if (!last) return block.end < codeLength ? [{ target: block.end, kind: "fallthrough" }] : [];
  if (last.optimizedBranchTarget !== undefined) {
    return [{ target: last.optimizedBranchTarget, kind: "optimized" }];
  }
  switch (last.op) {
    case "JUMP": return [{ target: last.args[0], kind: "jump" }];
    case "JTRUE":
    case "JFALSE":
    case "JCASE": return unique([last.args[0], last.end]).map((target) => ({
      target,
      kind: target === last.args[0] ? "taken" : "fallthrough",
    }));
    case "TRY": return unique([last.args[0], last.end]).map((target) => ({
      target,
      kind: target === last.args[0] ? "try" : "exception",
    }));
    case "ENDTRY":
      return last.end < codeLength ? [{ target: last.end, kind: "continuation" }] : [];
    case "RETURN":
    case "THROW": return [];
    default: return block.end < codeLength ? [{ target: block.end, kind: "fallthrough" }] : [];
  }
}

function computeDominators(blocks, reachable, entry) {
  const reachableSet = new Set(reachable);
  const all = new Set(reachable);
  const dominators = new Map();
  reachable.forEach((start) => dominators.set(start, start === entry ? new Set([entry]) : new Set(all)));

  let changed = true;
  while (changed) {
    changed = false;
    for (const block of blocks) {
      if (block.start === entry || !reachableSet.has(block.start)) continue;
      const predecessors = block.predecessors.filter((start) => reachableSet.has(start));
      let next = predecessors.length ? new Set(dominators.get(predecessors[0])) : new Set();
      for (let index = 1; index < predecessors.length; index += 1) {
        const other = dominators.get(predecessors[index]);
        next = new Set(Array.from(next).filter((value) => other.has(value)));
      }
      next.add(block.start);
      const current = dominators.get(block.start);
      if (current.size !== next.size || Array.from(current).some((value) => !next.has(value))) {
        dominators.set(block.start, next);
        changed = true;
      }
    }
  }
  return dominators;
}

function computeImmediateDominators(reachable, dominators, entry) {
  const immediateDominators = new Map([[entry, null]]);
  reachable.forEach((start) => {
    if (start === entry) return;
    const strict = Array.from(dominators.get(start)).filter((value) => value !== start);
    let immediate = null;
    for (const candidate of strict) {
      if (strict.every((other) => other === candidate || dominators.get(candidate).has(other))) {
        immediate = candidate;
        break;
      }
    }
    immediateDominators.set(start, immediate);
  });
  return immediateDominators;
}

function buildCFG(scope) {
  const blocks = buildBasicBlocks(scope);
  const byStart = new Map(blocks.map((block) => [block.start, block]));
  blocks.forEach((block) => {
    block.edges = successorEdges(block, scope.codeLength);
    block.successors = block.edges.map((edge) => edge.target).filter((target) => byStart.has(target));
    block.predecessors = [];
  });
  blocks.forEach((block) => block.successors.forEach((target) => {
    byStart.get(target).predecessors.push(block.start);
  }));

  const entry = blocks.length ? blocks[0].start : null;
  const reachable = [];
  const seen = new Set();
  const work = entry === null ? [] : [entry];
  while (work.length) {
    const start = work.pop();
    if (seen.has(start)) continue;
    seen.add(start);
    reachable.push(start);
    const block = byStart.get(start);
    for (let index = block.successors.length - 1; index >= 0; index -= 1) {
      work.push(block.successors[index]);
    }
  }
  reachable.sort((left, right) => left - right);

  const dominators = entry === null ? new Map() : computeDominators(blocks, reachable, entry);
  const immediateDominators = entry === null
    ? new Map()
    : computeImmediateDominators(reachable, dominators, entry);
  const loops = [];
  blocks.forEach((block) => block.successors.forEach((target) => {
    if (seen.has(block.start) && dominators.get(block.start).has(target)) {
      loops.push({ header: target, backedge: block.start });
    }
  }));

  return {
    kind: "ControlFlowGraph",
    scopeId: scope.id,
    codeLength: scope.codeLength,
    entry,
    blocks,
    byStart,
    reachable: seen,
    dominators,
    immediateDominators,
    loops,
  };
}

function verifyCFG(cfg) {
  if (!cfg || cfg.kind !== "ControlFlowGraph" || !Array.isArray(cfg.blocks)) {
    throw new TypeError("Invalid ControlFlowGraph");
  }
  if (cfg.blocks.length && cfg.entry !== cfg.blocks[0].start) {
    throw new Error(`CFG scope ${cfg.scopeId} has an invalid entry`);
  }
  let previousEnd = 0;
  const starts = new Set();
  cfg.blocks.forEach((block, index) => {
    if (block.id !== index || block.start !== previousEnd || block.end <= block.start) {
      throw new Error(`Malformed basic block ${block.id} in scope ${cfg.scopeId}`);
    }
    if (starts.has(block.start)) throw new Error(`Duplicate basic block ${block.start}`);
    starts.add(block.start);
    previousEnd = block.end;
  });
  if (previousEnd !== cfg.codeLength) throw new Error(`CFG scope ${cfg.scopeId} does not cover its HIR`);

  cfg.blocks.forEach((block) => {
    block.edges.forEach((edge) => {
      if (edge.target !== cfg.codeLength && !starts.has(edge.target)) {
        throw new Error(`CFG edge from ${block.start} has invalid target ${edge.target}`);
      }
    });
    block.successors.forEach((target) => {
      const successor = cfg.byStart.get(target);
      if (!successor || !successor.predecessors.includes(block.start)) {
        throw new Error(`CFG successor/predecessor mismatch at ${block.start} -> ${target}`);
      }
    });
    block.predecessors.forEach((source) => {
      const predecessor = cfg.byStart.get(source);
      if (!predecessor || !predecessor.successors.includes(block.start)) {
        throw new Error(`CFG predecessor/successor mismatch at ${source} -> ${block.start}`);
      }
    });
  });

  cfg.reachable.forEach((start) => {
    const dominators = cfg.dominators.get(start);
    if (!dominators || !dominators.has(start) || !dominators.has(cfg.entry)) {
      throw new Error(`Invalid dominators for reachable block ${start}`);
    }
    const immediate = cfg.immediateDominators.get(start);
    if (start === cfg.entry ? immediate !== null : !dominators.has(immediate)) {
      throw new Error(`Invalid immediate dominator for block ${start}`);
    }
  });
  cfg.loops.forEach((loop) => {
    const dominators = cfg.dominators.get(loop.backedge);
    if (!dominators || !dominators.has(loop.header)) {
      throw new Error(`Invalid natural loop ${loop.backedge} -> ${loop.header}`);
    }
  });
  return true;
}

module.exports = { buildBasicBlocks, buildCFG, verifyCFG };
