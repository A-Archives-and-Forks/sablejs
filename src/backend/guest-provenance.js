"use strict";

// Guest-object provenance: proves which GETLOCAL loads produce guest-created
// objects (object/array/regexp literals and closures) so sandbox property
// writes to them can skip writeTarget resolution — the dominant sandbox-tax
// lever (write-dominated workloads spend hundreds of millions of
// per-write WeakMap + protected-set lookups on provably local objects).
//
// The mark seeds at the allocate ops (NEWARRAY/NEWOBJECT/NEWREGEXP/CLOSURE),
// flows only through SETLOCAL slots and phi joins (AND meet), and is written
// back onto the HIR as `instruction.guestObjectOutput = true` on
// GETLOCAL/GETLOCAL2, which codegen replays as a "guest-object" temporary
// origin. Nothing unmarked ever takes the fast path: a marked value is
// guest-created by construction, hence never a wrapper, a capability token,
// or a protected intrinsic, so writeTarget would be a no-op for it.
//
// Marked-value stability: allocate ops are never folded, never DCE'd, and
// never copy-propagated, so the mark cannot go stale. The pass runs after
// the last SSA pass (ssa-dead-code-elimination) and before the literal-only
// peepholes.

const { lowerToMIR, verifyMIR } = require("../ir/mir");

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

const ALLOCATE_OPS = new Set(["NEWARRAY", "NEWOBJECT", "NEWREGEXP", "CLOSURE"]);
const SET_OPS = new Set(["SETLOCAL", "SETLOCAL2"]);
const GET_OPS = new Set(["GETLOCAL", "GETLOCAL2"]);
const DEL_OPS = new Set(["DELLOCAL", "DELLOCAL2"]);

function analyzeScope(mirScope) {
  const values = new Map(mirScope.values.map((value) => [value.id, value]));
  const opsByOffset = new Map();
  const blockByOffset = new Map();
  mirScope.blocks.forEach((block) => block.operations.forEach((operation) => {
    opsByOffset.set(operation.offset, operation);
    blockByOffset.set(operation.offset, block.start);
  }));
  const cap = Math.max(100, mirScope.blocks.length * mirScope.blocks.length * 4);

  // Phi marks persist across outer iterations and only grow (monotone):
  // a phi is marked iff every input is marked.
  const phiMarked = new Set();
  // Complete per-block slot states (localIndex -> marked). Entry states are
  // the AND meet of predecessor exit states; absent slots are unmarked.
  const entryState = new Map();
  const exitState = new Map();

  // Markedness of a value in the current outer iteration. Same-block
  // GETLOCAL outputs are recorded by the walk itself (SSA dominance
  // guarantees they precede their uses); cross-block values are phis, which
  // consult phiMarked.
  function inputMarked(valueId, slots, valueMarked) {
    if (valueMarked.has(valueId)) return valueMarked.get(valueId);
    const definition = values.get(valueId).definition;
    if (definition.kind === "Phi") return phiMarked.has(valueId);
    if (definition.kind === "Operation") {
      const operation = opsByOffset.get(definition.offset);
      if (ALLOCATE_OPS.has(operation.op)) return true;
      if (GET_OPS.has(operation.op)) return valueMarked.get(valueId) === true;
    }
    return false;
  }

  function walk(block, entry) {
    const slots = new Map(entry);
    const valueMarked = new Map();
    const getLocalMarked = new Map();
    block.operations.forEach((operation) => {
      if (SET_OPS.has(operation.op)) {
        slots.set(operation.args[0], inputMarked(operation.inputs[0], slots, valueMarked));
      } else if (DEL_OPS.has(operation.op)) {
        slots.set(operation.args[0], false);
      } else if (GET_OPS.has(operation.op)) {
        const marked = slots.get(operation.args[0]) === true;
        valueMarked.set(operation.outputs[0], marked);
        getLocalMarked.set(operation.offset, marked);
      }
    });
    return { slots, getLocalMarked };
  }

  function mergeEntry(block) {
    const merged = new Map();
    block.predecessors.forEach((predecessor) => {
      const exit = exitState.get(predecessor);
      if (!exit) return;
      exit.forEach((marked, index) => {
        merged.set(index, merged.has(index) ? merged.get(index) && marked : marked);
      });
    });
    return merged;
  }

  // Outer loop: grow phi marks (monotone), then re-solve the slot flow with
  // them. Terminates because each outer iteration adds at least one phi mark
  // or converges.
  let outerChanged = true;
  let outerIterations = 0;
  const getLocalMarkedByBlock = new Map();
  while (outerChanged) {
    outerChanged = false;
    outerIterations += 1;
    if (outerIterations > cap) {
      throw new Error(`guest-object provenance did not converge in scope ${mirScope.id}`);
    }

    let changed = true;
    let iterations = 0;
    while (changed) {
      changed = false;
      iterations += 1;
      if (iterations > cap) {
        throw new Error(`guest-object provenance did not converge in scope ${mirScope.id}`);
      }
      mirScope.blocks.forEach((block) => {
        const entry = mergeEntry(block);
        const result = walk(block, entry);
        getLocalMarkedByBlock.set(block.start, result.getLocalMarked);
        const entryChanged = !sameState(entryState.get(block.start), entry);
        const exitChanged = !sameState(exitState.get(block.start), result.slots);
        if (!entryChanged && !exitChanged) return;
        entryState.set(block.start, entry);
        exitState.set(block.start, result.slots);
        changed = true;
      });
    }

    let phiChanged = true;
    while (phiChanged) {
      phiChanged = false;
      mirScope.blocks.forEach((block) => {
        block.phis.forEach((phi) => {
          if (phiMarked.has(phi.id)) return;
          if (phi.inputs.every((input) => {
            const definition = values.get(input.value).definition;
            if (definition.kind === "Phi") return phiMarked.has(input.value);
            if (definition.kind === "Operation") {
              const operation = opsByOffset.get(definition.offset);
              if (ALLOCATE_OPS.has(operation.op)) return true;
              if (GET_OPS.has(operation.op)) {
                const perBlock = getLocalMarkedByBlock.get(blockByOffset.get(operation.offset));
                return perBlock != null && perBlock.get(operation.offset) === true;
              }
            }
            return false;
          })) {
            phiMarked.add(phi.id);
            phiChanged = true;
            outerChanged = true;
          }
        });
      });
    }
  }

  // Final deterministic walk with the converged entry states; collect the
  // marked GETLOCAL offsets for the HIR writeback.
  const markedOffsets = new Set();
  mirScope.blocks.forEach((block) => {
    const result = walk(block, entryState.get(block.start) || new Map());
    result.getLocalMarked.forEach((marked, offset) => {
      if (marked) markedOffsets.add(offset);
    });
  });
  return markedOffsets;
}

function sameState(left, right) {
  if (!left || !right) return false;
  if (left.size !== right.size) return false;
  return Array.from(left.entries()).every(([index, marked]) => right.get(index) === marked);
}

function runGuestProvenance(hirProgram, stats, existingMIR) {
  const mir = analysisMIR(hirProgram, stats, existingMIR);
  let markedLoads = 0;
  mir.scopes.forEach((mirScope) => {
    const hirScope = hirProgram.scopes.find((scope) => scope.id === mirScope.id);
    if (!hirScope) return;
    const instructions = new Map(
      hirScope.instructions.map((instruction) => [instruction.offset, instruction])
    );
    analyzeScope(mirScope).forEach((offset) => {
      const instruction = instructions.get(offset);
      if (instruction) {
        instruction.guestObjectOutput = true;
        markedLoads += 1;
      }
    });
  });
  stats.guestProvenance = { markedLoads };
  return mir;
}

module.exports = { runGuestProvenance };
