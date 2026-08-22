"use strict";

const OpSpec = require("./op-spec");
const { buildCFG, verifyCFG } = require("./cfg");

const PUSH_OPERATIONS = new Set([
  "INTEGER", "NUMBER", "STRING", "CLOSURE", "NEWARRAY", "NEWOBJECT", "NEWREGEXP",
  "EMPTY", "UNDEF", "NULL", "TRUE", "FALSE", "THIS", "CURRENT", "GETLOCAL",
  "GETLOCAL2", "DELLOCAL", "DELLOCAL2", "HASVAR", "GETVAR", "DELVAR", "REFVAR",
]);
const PEEK_OPERATIONS = new Set(["SETLOCAL", "SETLOCAL2", "SETVAR"]);
const UNARY_OPERATIONS = new Set([
  "GETPROP_S", "DELPROP_S", "ITERATOR", "EVAL", "TYPEOF", "POS", "NEG", "BITNOT",
  "LOGNOT", "INC", "DEC",
]);
const BINARY_OPERATIONS = new Set([
  "IN", "GETPROP", "DELPROP", "MUL", "DIV", "MOD", "ADD", "SUB", "SHL", "SHR",
  "USHR", "LT", "GT", "LE", "GE", "EQ", "NE", "STRICTEQ", "STRICTNE", "BITAND",
  "BITXOR", "BITOR", "INSTANCEOF",
]);
const NO_STACK_OPERATIONS = new Set([
  "DEBUGGER", "LOC", "ENDCATCH", "ENDWITH", "ENDTRY", "JUMP",
]);

function valueTypeForOperation(op) {
  if (["UNDEF", "EMPTY"].includes(op)) return "Undefined";
  if (op === "NULL") return "Null";
  if (["TRUE", "FALSE", "DELLOCAL", "DELLOCAL2", "DELVAR", "DELPROP", "DELPROP_S",
       "LT", "GT", "LE", "GE", "EQ", "NE", "STRICTEQ", "STRICTNE", "IN",
       "INSTANCEOF", "LOGNOT"].includes(op)) return "Boolean";
  if (["INTEGER", "NUMBER", "POS", "NEG", "BITNOT", "INC", "DEC", "POSTINC",
       "POSTDEC", "MUL", "DIV", "MOD", "SUB", "SHL", "SHR", "USHR", "BITAND",
       "BITXOR", "BITOR"].includes(op) || /_(?:VAR|CONST)_(?:CONST_)?N$/.test(op)) return "Number";
  if (["STRING", "TYPEOF"].includes(op)) return "String";
  if (op === "CLOSURE") return "Function";
  if (["NEWARRAY", "NEWOBJECT", "NEWREGEXP"].includes(op)) return "Object";
  return "Unknown";
}

function typeForConstant(value) {
  if (value === undefined) return "Undefined";
  if (value === null) return "Null";
  if (typeof value === "boolean") return "Boolean";
  if (typeof value === "number") return "Number";
  if (typeof value === "string") return "String";
  if (typeof value === "function") return "Function";
  if (typeof value === "object") return "Object";
  return "Unknown";
}

function literalForInstruction(instruction) {
  if (instruction.optimized && instruction.optimized.kind === "literal") {
    return { known: true, value: instruction.optimized.value };
  }
  switch (instruction.op) {
    case "INTEGER":
    case "NUMBER":
    case "STRING": return { known: true, value: instruction.args[0] };
    case "UNDEF": return { known: true, value: undefined };
    case "NULL": return { known: true, value: null };
    case "TRUE": return { known: true, value: true };
    case "FALSE": return { known: true, value: false };
    default: return { known: false };
  }
}

function effectForOperation(op) {
  const spec = OpSpec.byName[op];
  switch (spec.effect) {
    case "pure": return "Pure";
    case "read": return "ReadEnvironment";
    case "write": return "WriteEnvironment";
    case "call": return "CallUnknown";
    case "throw": return "MayThrow";
    case "allocate": return "Allocate";
    case "dynamic": return "HostEffect";
    case "host":
      if (["GETPROP", "GETPROP_S", "DELPROP", "DELPROP_S", "IN", "INSTANCEOF"].includes(op)) {
        return "ReadProperty";
      }
      if (["SETPROP", "SETPROP_S", "INITPROP", "INITGETTER", "INITSETTER"].includes(op)) {
        return "WriteProperty";
      }
      return "MayCoerce";
    default: return "Pure";
  }
}

function sameStack(left, right) {
  return left && right && left.length === right.length && left.every((value, index) => value === right[index]);
}

function lowerScope(scope) {
  const cfg = buildCFG(scope);
  verifyCFG(cfg);
  const structuredExits = new Map();
  (scope.controlRegions || []).forEach((region) => {
    (region.exits || []).forEach((exit) => structuredExits.set(exit.offset, { exit, region }));
  });
  const values = new Map();
  const blockOperations = new Map();
  const entryStacks = new Map([[cfg.entry, []]]);
  const edgeStacks = new Map();
  const phiIds = new Map();
  const stacksAtOffsets = new Map();

  function defineValue(id, definition, type = "Unknown", constant) {
    if (!values.has(id)) {
      const value = { id, type, definition, uses: [] };
      if (constant && constant.known) value.constant = constant.value;
      values.set(id, value);
    }
    return id;
  }

  function instructionValue(instruction, index, type, constant) {
    return defineValue(
      `s${scope.id}.o${instruction.offset}.v${index}`,
      { kind: "Operation", offset: instruction.offset, output: index },
      type,
      constant
    );
  }

  function phiValue(blockStart, slot) {
    const key = `${blockStart}:${slot}`;
    if (!phiIds.has(key)) {
      phiIds.set(key, defineValue(
        `s${scope.id}.b${blockStart}.p${slot}`,
        { kind: "Phi", block: blockStart, slot }
      ));
    }
    return phiIds.get(key);
  }

  function simulate(block, inputStack) {
    const stack = inputStack.slice();
    const operations = [];
    let edgeResult = null;

    function requireDepth(count, instruction) {
      if (stack.length < count) {
        throw new Error(`MIR stack underflow in scope ${scope.id} at ${instruction.offset}`);
      }
    }

    function emit(instruction, inputs = [], outputTypes = []) {
      const constant = literalForInstruction(instruction);
      const outputs = outputTypes.map((type, index) =>
        instructionValue(instruction, index, type, index === 0 ? constant : null)
      );
      operations.push({
        kind: "Operation",
        op: instruction.optimized && instruction.optimized.kind === "literal" ? "CONST" : instruction.op,
        offset: instruction.offset,
        end: instruction.end,
        args: instruction.args.slice(),
        inputs: inputs.slice(),
        outputs,
        effect: instruction.optimized && instruction.optimized.kind === "literal"
          ? "Pure"
          : effectForOperation(instruction.op),
      });
      return outputs;
    }

    // Keep elided instructions in the walk so structured-region boundaries
    // still receive an exact stack snapshot. In particular, O2 removes LOC
    // nodes, and a labelled break may use such a LOC offset as the region
    // entry whose stack height must be restored. Elided nodes have no MIR
    // effect, but dropping their offsets made that restoration fall back to
    // the containing block entry and could discard a live completion value.
    const instructions = block.instructions.filter((instruction) => !instruction.unreachable);
    for (let index = 0; index < instructions.length; index += 1) {
      const instruction = instructions[index];
      stacksAtOffsets.set(instruction.offset, stack.slice());
      if (instruction.elided) continue;
      let nextIndex = index + 1;
      while (nextIndex < instructions.length && instructions[nextIndex].elided) nextIndex += 1;
      const next = instructions[nextIndex];

      if (instruction.optimized && instruction.optimized.kind === "literal") {
        stack.push(emit(instruction, [], [typeForConstant(instruction.optimized.value)])[0]);
        continue;
      }

      if (instruction.op === "NEXTITER" && next && ["JTRUE", "JFALSE"].includes(next.op)) {
        requireDepth(1, instruction);
        const iterator = stack[stack.length - 1];
        const [key, hasNext] = emit(instruction, [iterator], ["String", "Boolean"]);
        emit(next, [hasNext]);
        const success = stack.concat([key]);
        const exhausted = stack.slice(0, -1);
        edgeResult = new Map(block.edges.map((edge) => {
          const successEdge = next.op === "JTRUE" ? edge.kind === "taken" : edge.kind === "fallthrough";
          return [edge.target, successEdge ? success : exhausted];
        }));
        index = nextIndex;
        break;
      }

      if (instruction.op === "JCASE") {
        requireDepth(2, instruction);
        const candidate = stack[stack.length - 1];
        const discriminant = stack[stack.length - 2];
        emit(instruction, [discriminant, candidate]);
        edgeResult = new Map(block.edges.map((edge) => [
          edge.target,
          edge.kind === "taken" ? stack.slice(0, -2) : stack.slice(0, -1),
        ]));
        break;
      }

      if (instruction.op === "TRY") {
        emit(instruction);
        const exception = defineValue(
          `s${scope.id}.o${instruction.offset}.exception`,
          { kind: "Exception", offset: instruction.offset },
          "Unknown"
        );
        edgeResult = new Map(block.edges.map((edge) => [
          edge.target,
          edge.kind === "exception" ? stack.concat([exception]) : stack.slice(),
        ]));
        break;
      }

      if (PUSH_OPERATIONS.has(instruction.op)) {
        stack.push(emit(instruction, [], [valueTypeForOperation(instruction.op)])[0]);
      } else if (PEEK_OPERATIONS.has(instruction.op)) {
        requireDepth(1, instruction);
        emit(instruction, [stack[stack.length - 1]]);
      } else if (instruction.op === "POP") {
        requireDepth(1, instruction);
        emit(instruction, [stack.pop()]);
      } else if (instruction.op === "DUP") {
        requireDepth(1, instruction);
        const value = stack[stack.length - 1];
        emit(instruction, [value]);
        stack.push(value);
      } else if (instruction.op === "DUP2") {
        requireDepth(2, instruction);
        const pair = stack.slice(-2);
        emit(instruction, pair);
        stack.push(pair[0], pair[1]);
      } else if (["ROT2", "ROT3", "ROT4"].includes(instruction.op)) {
        const count = Number(instruction.op.slice(3));
        requireDepth(count, instruction);
        const inputs = stack.slice(-count);
        emit(instruction, inputs);
        stack.splice(stack.length - count, count, inputs[count - 1], ...inputs.slice(0, -1));
      } else if (["INITPROP", "INITGETTER", "INITSETTER"].includes(instruction.op)) {
        requireDepth(3, instruction);
        emit(instruction, stack.slice(-3));
        stack.splice(stack.length - 2, 2);
      } else if (UNARY_OPERATIONS.has(instruction.op)) {
        requireDepth(1, instruction);
        const input = stack.pop();
        stack.push(emit(instruction, [input], [valueTypeForOperation(instruction.op)])[0]);
      } else if (BINARY_OPERATIONS.has(instruction.op) || /_(?:VAR|CONST)_/.test(instruction.op)) {
        requireDepth(2, instruction);
        const inputs = stack.splice(stack.length - 2, 2);
        stack.push(emit(instruction, inputs, [valueTypeForOperation(instruction.op)])[0]);
      } else if (["SETPROP", "SETPROP_S", "PUTVAR"].includes(instruction.op)) {
        const count = instruction.op === "SETPROP" ? 3 : 2;
        requireDepth(count, instruction);
        const inputs = stack.splice(stack.length - count, count);
        emit(instruction, inputs);
        stack.push(inputs[inputs.length - 1]);
      } else if (["POSTINC", "POSTDEC"].includes(instruction.op)) {
        requireDepth(1, instruction);
        const outputs = emit(instruction, [stack.pop()], ["Number", "Number"]);
        stack.push(outputs[0], outputs[1]);
      } else if (instruction.op === "CALL" || instruction.op === "NEW") {
        const count = instruction.args[0] + (instruction.op === "CALL" ? 2 : 1);
        requireDepth(count, instruction);
        const inputs = stack.splice(stack.length - count, count);
        stack.push(emit(instruction, inputs, ["Unknown"])[0]);
      } else if (["JTRUE", "JFALSE"].includes(instruction.op)) {
        requireDepth(1, instruction);
        emit(instruction, [stack.pop()]);
      } else if (["THROW", "RETURN", "CATCH", "WITH"].includes(instruction.op)) {
        requireDepth(1, instruction);
        emit(instruction, [stack.pop()]);
      } else if (NO_STACK_OPERATIONS.has(instruction.op)) {
        emit(instruction);
      } else {
        throw new Error(`MIR lowering does not describe ${instruction.op} in scope ${scope.id}`);
      }
    }

    if (!edgeResult) edgeResult = new Map(block.edges.map((edge) => [edge.target, stack.slice()]));
    return { operations, edges: edgeResult };
  }

  function mergeEntry(target) {
    const block = cfg.byStart.get(target);
    const incoming = block.predecessors
      .filter((source) => cfg.reachable.has(source))
      .map((source) => ({ source, stack: edgeStacks.get(`${source}->${target}`) }))
      .filter((entry) => entry.stack);
    if (!incoming.length) return null;
    const height = incoming[0].stack.length;
    if (incoming.some((entry) => entry.stack.length !== height)) {
      const detail = incoming.map((entry) =>
        `${entry.source}:[${entry.stack.join(",")}]`
      ).join("; ");
      throw new Error(`MIR stack height mismatch at block ${target} in scope ${scope.id}: ${detail}`);
    }
    return Array.from({ length: height }, (_, slot) => {
      const candidates = new Set(incoming.map((entry) => entry.stack[slot]));
      // Phi creation must be monotonic. A temporary subset of processed
      // predecessor edges may agree after a Phi has already been required;
      // replacing it with that transient value makes nested loops oscillate
      // between neighboring Phi identities.
      if (phiIds.has(`${target}:${slot}`)) return phiValue(target, slot);
      return candidates.size === 1 ? incoming[0].stack[slot] : phiValue(target, slot);
    });
  }

  const queued = new Set(cfg.entry === null ? [] : [cfg.entry]);
  const work = cfg.entry === null ? [] : [cfg.entry];
  let iterations = 0;
  while (work.length) {
    if (iterations++ > Math.max(100, cfg.blocks.length * cfg.blocks.length * 4)) {
      throw new Error(`MIR dataflow did not converge in scope ${scope.id}`);
    }
    const start = work.shift();
    queued.delete(start);
    const block = cfg.byStart.get(start);
    const result = simulate(block, entryStacks.get(start));
    const terminator = block.instructions.filter((instruction) =>
      !instruction.elided && !instruction.unreachable
    ).slice(-1)[0];
    // The frontend operation stream copies finally bodies onto abrupt paths. A
    // structured break/continue discards the pending exception/completion
    // values before transferring control, even though those compiler artifacts
    // are still visible in the ingestion CFG. Model that unwind explicitly at
    // the MIR boundary so loop/label joins see the semantic stack shape.
    if (terminator && terminator.op === "JUMP" && structuredExits.has(terminator.offset)) {
      const target = terminator.args[0];
      const structuredExit = structuredExits.get(terminator.offset);
      const baselineOffset = structuredExit.exit.kind === "continue"
        ? (structuredExit.region.kind === "ForIn"
          ? structuredExit.region.continueTarget
          : (structuredExit.region.kind === "DoWhile"
            ? structuredExit.region.start
            : (structuredExit.region.testStart || structuredExit.region.start)))
        : structuredExit.region.start;
      const regionBlock = cfg.blocks.find((candidate) =>
        candidate.start <= baselineOffset && baselineOffset < candidate.end
      );
      const expected = stacksAtOffsets.get(baselineOffset) ||
        (regionBlock && entryStacks.get(regionBlock.start)) || entryStacks.get(target);
      const outgoing = result.edges.get(target);
      if (!expected) {
        throw new Error(
          `Missing MIR region-entry stack for structured exit ${terminator.offset} in scope ${scope.id}`
        );
      }
      if (outgoing.length < expected.length) {
        throw new Error(
          `MIR structured exit underflow from ${terminator.offset} to ${target} in scope ${scope.id}`
        );
      }
      result.edges.set(target, outgoing.slice(0, expected.length));
    }
    blockOperations.set(start, result.operations);
    result.edges.forEach((stack, target) => {
      if (!cfg.byStart.has(target) || !cfg.reachable.has(target)) return;
      const key = `${start}->${target}`;
      const previousEdge = edgeStacks.get(key);
      if (!sameStack(previousEdge, stack)) edgeStacks.set(key, stack);
      const merged = mergeEntry(target);
      if (merged && !sameStack(entryStacks.get(target), merged)) {
        entryStacks.set(target, merged);
        if (!queued.has(target)) {
          work.push(target);
          queued.add(target);
        }
      }
    });
  }

  const blocks = cfg.blocks.filter((block) => cfg.reachable.has(block.start)).map((block) => {
    const phis = [];
    const entryStack = entryStacks.get(block.start) || [];
    entryStack.forEach((value, slot) => {
      if (value !== phiIds.get(`${block.start}:${slot}`)) return;
      const inputs = block.predecessors.filter((source) => cfg.reachable.has(source)).map((source) => ({
        block: source,
        value: edgeStacks.get(`${source}->${block.start}`)[slot],
      }));
      phis.push({ kind: "Phi", id: value, slot, inputs });
    });
    return {
      kind: "BasicBlock",
      id: block.id,
      start: block.start,
      end: block.end,
      predecessors: block.predecessors.filter((start) => cfg.reachable.has(start)),
      successors: block.successors.filter((start) => cfg.reachable.has(start)),
      entryStack,
      phis,
      operations: blockOperations.get(block.start) || [],
    };
  });

  blocks.forEach((block) => {
    block.phis.forEach((phi) => phi.inputs.forEach((input) => {
      values.get(input.value).uses.push({ kind: "Phi", block: block.start, value: phi.id });
    }));
    block.operations.forEach((operation) => operation.inputs.forEach((input, index) => {
      values.get(input).uses.push({ kind: "Operation", offset: operation.offset, input: index });
    }));
  });

  const retainedValues = new Set();
  blocks.forEach((block) => {
    block.entryStack.forEach((value) => retainedValues.add(value));
    block.phis.forEach((phi) => {
      retainedValues.add(phi.id);
      phi.inputs.forEach((input) => retainedValues.add(input.value));
    });
    block.operations.forEach((operation) => {
      operation.inputs.forEach((input) => retainedValues.add(input));
      operation.outputs.forEach((output) => retainedValues.add(output));
    });
  });

  return {
    kind: "FunctionMIR",
    id: scope.id,
    name: scope.name,
    strict: scope.strict,
    entry: cfg.entry,
    blocks,
    loops: cfg.loops.slice(),
    values: Array.from(values.values()).filter((value) => retainedValues.has(value.id)),
  };
}

function lowerToMIR(program) {
  return {
    kind: "ProgramMIR",
    version: 1,
    entry: program.entry,
    scopes: program.scopes.map(lowerScope),
  };
}

function verifyMIR(program) {
  if (!program || program.kind !== "ProgramMIR" || !Array.isArray(program.scopes)) {
    throw new TypeError("Invalid ProgramMIR");
  }
  const scopeIds = new Set();
  program.scopes.forEach((scope) => {
    if (scope.kind !== "FunctionMIR" || scopeIds.has(scope.id)) throw new Error("Invalid FunctionMIR");
    scopeIds.add(scope.id);
    const values = new Map(scope.values.map((value) => [value.id, value]));
    if (values.size !== scope.values.length) throw new Error(`Duplicate MIR value in scope ${scope.id}`);
    const blocks = new Map(scope.blocks.map((block) => [block.start, block]));
    if (scope.blocks.length && !blocks.has(scope.entry)) throw new Error(`Invalid MIR entry in scope ${scope.id}`);
    const expectedUses = new Map(scope.values.map((value) => [value.id, 0]));
    const definitions = new Map();
    const operationPositions = new Map();
    scope.blocks.forEach((block) => {
      block.predecessors.forEach((start) => {
        const predecessor = blocks.get(start);
        if (!predecessor || !predecessor.successors.includes(block.start)) {
          throw new Error(`Invalid MIR edge ${start} -> ${block.start}`);
        }
      });
      block.phis.forEach((phi) => {
        if (!values.has(phi.id) || phi.inputs.length !== block.predecessors.length) {
          throw new Error(`Invalid Phi ${phi.id}`);
        }
        if (definitions.has(phi.id)) throw new Error(`Multiple definitions for ${phi.id}`);
        definitions.set(phi.id, { block: block.start, position: -1, kind: "Phi" });
        phi.inputs.forEach((input) => {
          if (!values.has(input.value) || !block.predecessors.includes(input.block)) {
            throw new Error(`Invalid Phi input for ${phi.id}`);
          }
          expectedUses.set(input.value, expectedUses.get(input.value) + 1);
        });
      });
      block.operations.forEach((operation, position) => {
        operationPositions.set(`${block.start}:${operation.offset}`, position);
        operation.inputs.forEach((input) => {
          if (!values.has(input)) throw new Error(`Undefined MIR value ${input}`);
          expectedUses.set(input, expectedUses.get(input) + 1);
        });
        operation.outputs.forEach((output) => {
          if (!values.has(output)) throw new Error(`Missing MIR output ${output}`);
          if (definitions.has(output)) throw new Error(`Multiple definitions for ${output}`);
          definitions.set(output, { block: block.start, position, kind: "Operation" });
        });
      });
    });
    scope.values.forEach((value) => {
      if (value.definition.kind === "Exception") {
        const owner = scope.blocks.find((block) =>
          block.operations.some((operation) => operation.offset === value.definition.offset)
        );
        if (!owner) throw new Error(`Missing exception definition for ${value.id}`);
        definitions.set(value.id, {
          block: owner.start,
          position: operationPositions.get(`${owner.start}:${value.definition.offset}`),
          kind: "Exception",
        });
      }
    });
    if (definitions.size !== scope.values.length) {
      const missing = scope.values.find((value) => !definitions.has(value.id));
      throw new Error(`Missing SSA definition for ${missing && missing.id}`);
    }

    const dominators = new Map();
    const allBlocks = new Set(blocks.keys());
    scope.blocks.forEach((block) => dominators.set(
      block.start,
      block.start === scope.entry ? new Set([scope.entry]) : new Set(allBlocks)
    ));
    let dominatorsChanged = true;
    while (dominatorsChanged) {
      dominatorsChanged = false;
      scope.blocks.forEach((block) => {
        if (block.start === scope.entry) return;
        let next = block.predecessors.length
          ? new Set(dominators.get(block.predecessors[0]))
          : new Set();
        block.predecessors.slice(1).forEach((predecessor) => {
          const other = dominators.get(predecessor);
          next = new Set(Array.from(next).filter((value) => other.has(value)));
        });
        next.add(block.start);
        const current = dominators.get(block.start);
        if (next.size !== current.size || Array.from(next).some((value) => !current.has(value))) {
          dominators.set(block.start, next);
          dominatorsChanged = true;
        }
      });
    }

    function assertDominates(valueId, useBlock, usePosition, description) {
      const definition = definitions.get(valueId);
      if (!definition || !dominators.get(useBlock).has(definition.block) ||
          (definition.block === useBlock && definition.position >= usePosition && definition.position !== -1)) {
        throw new Error(`SSA definition ${valueId} does not dominate ${description}`);
      }
    }
    scope.blocks.forEach((block) => {
      block.phis.forEach((phi) => phi.inputs.forEach((input) => {
        assertDominates(input.value, input.block, Infinity, `Phi ${phi.id}`);
      }));
      block.operations.forEach((operation, position) => operation.inputs.forEach((input) => {
        assertDominates(input, block.start, position, `operation ${operation.offset}`);
      }));
    });
    scope.values.forEach((value) => {
      if (value.uses.length !== expectedUses.get(value.id)) {
        throw new Error(`Invalid use-def chain for ${value.id}`);
      }
    });
  });
  if (!scopeIds.has(program.entry)) throw new Error("Invalid ProgramMIR entry");
  return true;
}

module.exports = { lowerToMIR, lowerScope, verifyMIR, valueTypeForOperation };
