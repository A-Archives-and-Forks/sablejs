"use strict";

const { buildCFG, verifyCFG } = require("../ir/cfg");
const { PassManager, liveInstructionCount } = require("./pass-manager");
const {
  runCopyPropagation,
  runDeadCodeElimination,
  runGlobalValueNumbering,
  runLocalCSE,
  runLoopInvariantCodeMotion,
} = require("./mir-optimizations");
const { runSCCP } = require("./sccp");
const { runGuestProvenance } = require("./guest-provenance");

const LEVELS = new Set(["O0", "O1", "O2", "Os"]);
const BINARY_FOLDERS = {
  MUL: (left, right) => left * right,
  DIV: (left, right) => left / right,
  MOD: (left, right) => left % right,
  ADD: (left, right) => left + right,
  SUB: (left, right) => left - right,
  SHL: (left, right) => left << right,
  SHR: (left, right) => left >> right,
  USHR: (left, right) => left >>> right,
  BITAND: (left, right) => left & right,
  BITXOR: (left, right) => left ^ right,
  BITOR: (left, right) => left | right,
  STRICTEQ: (left, right) => left === right,
  STRICTNE: (left, right) => left !== right,
};
const UNARY_FOLDERS = {
  POS: (value) => +value,
  NEG: (value) => -value,
  BITNOT: (value) => ~value,
  LOGNOT: (value) => !value,
  TYPEOF: (value) => typeof value,
};

function normalizeLevel(level) {
  const aliases = { "0": "O0", "1": "O1", "2": "O2", s: "Os", S: "Os" };
  const raw = String(level == null ? "O2" : level).replace(/^-/, "");
  const normalized = aliases[raw] || (raw[0] === "o" ? `O${raw.slice(1)}` : raw);
  if (!LEVELS.has(normalized)) throw new Error(`Unknown optimization level ${level}`);
  return normalized;
}

function literalValue(instruction) {
  if (instruction.elided) return { known: false };
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

function jumpTargets(scope) {
  const targets = new Set();
  scope.instructions.forEach((instruction) => {
    if (["JUMP", "JTRUE", "JFALSE", "JCASE", "TRY"].includes(instruction.op)) {
      targets.add(instruction.args[0]);
    }
  });
  return targets;
}

function foldConstants(scope, stats) {
  const targets = jumpTargets(scope);
  const instructions = scope.instructions;
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    const unary = UNARY_FOLDERS[instruction.op];
    if (unary && index >= 1) {
      const input = instructions[index - 1];
      const literal = literalValue(input);
      if (literal.known && !targets.has(input.offset) && !targets.has(instruction.offset)) {
        input.elided = true;
        instruction.optimized = { kind: "literal", value: unary(literal.value) };
        stats.constantsFolded += 1;
      }
      continue;
    }

    const binary = BINARY_FOLDERS[instruction.op] || BINARY_FOLDERS[instruction.op.split("_")[0]];
    if (binary && index >= 2) {
      const leftInstruction = instructions[index - 2];
      const rightInstruction = instructions[index - 1];
      const left = literalValue(leftInstruction);
      const right = literalValue(rightInstruction);
      if (left.known && right.known &&
          !targets.has(leftInstruction.offset) && !targets.has(rightInstruction.offset) &&
          !targets.has(instruction.offset)) {
        leftInstruction.elided = true;
        rightInstruction.elided = true;
        instruction.optimized = { kind: "literal", value: binary(left.value, right.value) };
        stats.constantsFolded += 1;
      }
    }
  }
}

function eliminateDeadConstants(scope, stats) {
  const targets = jumpTargets(scope);
  const instructions = scope.instructions;
  for (let index = 1; index < instructions.length; index += 1) {
    const pop = instructions[index];
    const producer = instructions[index - 1];
    if (pop.op === "POP" && literalValue(producer).known &&
        !targets.has(producer.offset) && !targets.has(pop.offset)) {
      producer.elided = true;
      pop.elided = true;
      stats.deadOperationsRemoved += 2;
    }
  }
}

function stripSourceLocations(scope, stats) {
  scope.instructions.forEach((instruction) => {
    if (instruction.op !== "LOC" || instruction.elided) return;
    instruction.elided = true;
    stats.sourceLocationsRemoved += 1;
    stats.deadOperationsRemoved += 1;
  });
}

function foldConstantBranches(scope, stats) {
  const targets = jumpTargets(scope);
  const instructions = scope.instructions;
  for (let index = 1; index < instructions.length; index += 1) {
    const branch = instructions[index];
    if (branch.op !== "JTRUE" && branch.op !== "JFALSE") continue;
    const condition = instructions[index - 1];
    const literal = literalValue(condition);
    if (!literal.known || targets.has(condition.offset) || targets.has(branch.offset)) continue;

    const taken = branch.op === "JTRUE" ? Boolean(literal.value) : !Boolean(literal.value);
    branch.optimizedBranchTarget = taken ? branch.args[0] : branch.end;
    stats.constantBranchesFolded += 1;
  }
}

function eliminateUnreachableBlocks(scope, stats) {
  const cfg = buildCFG(scope);
  verifyCFG(cfg);
  const structuredFinalizerRanges = (scope.controlRegions || [])
    .filter((region) => region.kind === "TryFinally")
    .map((region) => ({ start: region.finalizerStart, end: region.finalizerEnd }));
  const isCanonicalFinalizerInstruction = (instruction) => structuredFinalizerRanges.some((range) =>
    range.start <= instruction.offset && instruction.offset < range.end
  );
  stats.cfg.blocks += cfg.blocks.length;
  stats.cfg.edges += cfg.blocks.reduce((count, block) => count + block.edges.length, 0);
  stats.cfg.loops += cfg.loops.length;
  cfg.blocks.forEach((block) => {
    if (cfg.reachable.has(block.start)) return;
    const newlyUnreachable = block.instructions.filter((instruction) =>
      !instruction.unreachable && !isCanonicalFinalizerInstruction(instruction)
    );
    if (!newlyUnreachable.length) return;
    stats.unreachableBlocksRemoved += 1;
    newlyUnreachable.forEach((instruction) => {
      instruction.unreachable = true;
      stats.deadOperationsRemoved += 1;
    });
  });
}

function optimizeProgram(program, requestedLevel, options = {}) {
  const level = normalizeLevel(requestedLevel);
  const stats = {
    level,
    passes: [],
    constantsFolded: 0,
    constantBranchesFolded: 0,
    deadOperationsRemoved: 0,
    unreachableBlocksRemoved: 0,
    cfg: { blocks: 0, edges: 0, loops: 0 },
    mir: { builds: 0 },
    sourceLocationsRemoved: 0,
  };
  stats.nodesBefore = liveInstructionCount(program);
  if (level === "O0") {
    stats.nodesAfter = stats.nodesBefore;
    return stats;
  }
  // Pass pipeline contract.
  // - Every pass preserves program semantics exactly; PassManager re-verifies
  //   the HIR after each pass and records live-instruction deltas.
  // - Passes communicate only through the fields they are licensed to write:
  //   `elided` / `unreachable` marks, `instruction.optimized` literal folds,
  //   `instruction.optimizedBranchTarget` branch rewrites, and the
  //   `guestObjectOutput` provenance mark. Everything else is input to every
  //   later pass.
  // - Security-sensitive passes (guest-object-provenance) may only move data
  //   toward the sandbox fast path when the proof travels with the mark
  //   itself; see the per-pass notes below and guest-provenance.js.
  const passes = new PassManager(program, stats, options);

  passes.run("constant-folding", (currentProgram) => {
    // Folds constant unary/binary chains into `optimized` literals and elides
    // their inputs. Never folds across or into jump targets (offset-based
    // peephole guards), never folds allocate ops (NEW*/CLOSURE are not
    // literals), and preserves the instruction stream's offset layout.
    currentProgram.scopes.forEach((scope) => foldConstants(scope, stats));
  });

  passes.run("constant-branches", (currentProgram) => {
    // Rewrites JTRUE/JFALSE on known literal conditions to a direct
    // `optimizedBranchTarget` (taken target or fall-through `end`). The
    // condition instruction stays live; CFG reachability is resolved by the
    // next pass from the rewritten target.
    currentProgram.scopes.forEach((scope) => foldConstantBranches(scope, stats));
  });

  passes.run("cfg-unreachable-code", (currentProgram) => {
    // Marks blocks unreachable from entry as `unreachable` (CFG reachability);
    // canonical TryFinally finalizer bodies are always kept reachable so
    // structured unwinds cannot lose their cleanup path.
    currentProgram.scopes.forEach((scope) => eliminateUnreachableBlocks(scope, stats));
  });

  if ((level === "O2" || level === "Os") && options.preserveSourceLocations !== true) {
    passes.run("strip-source-locations", (currentProgram) => {
      // Elides LOC instructions (debug markers only, no runtime effect).
      currentProgram.scopes.forEach((scope) => stripSourceLocations(scope, stats));
    });
  }

  let analysisMIR;
  passes.run("ssa-sccp", (currentProgram) => {
    // Sparse conditional constant propagation over the MIR value graph.
    // Constants flow only through SSA values, never across the sandbox
    // boundary; produces the shared `analysisMIR` consumed by the later SSA
    // passes (rebuilt once, verified, reused).
    analysisMIR = runSCCP(currentProgram, stats);
  });

  passes.run("ssa-copy-propagation", (currentProgram) => {
    // Propagates known literals into private lightweight locals (intra-block;
    // parameters excluded — sloppy arguments can alias them). Kills on any
    // unknown store. Literals only, so guest-allocated values never get
    // aliased into slots the provenance pass would misjudge.
    runCopyPropagation(currentProgram, stats, analysisMIR);
  });

  if (level === "O2") {
    passes.run("loop-invariant-code-motion", (currentProgram) => {
      // Hoists private non-parameter local reads out of loops (O2 only). Such
      // reads cannot invoke guest code, and lightweight scopes prove no
      // with/eval/closures can mutate the slot; a loop-local write is a hard
      // kill.
      runLoopInvariantCodeMotion(currentProgram, stats, analysisMIR);
    });

    passes.run("global-value-numbering", (currentProgram) => {
      // Memory-aware cross-block CSE for private locals (O2 only): a load is
      // available across a block only when every predecessor carries the
      // same dominating load and no path writes that local.
      runGlobalValueNumbering(currentProgram, stats, analysisMIR);
    });
  }

  if (level === "O2" || level === "Os") {
    passes.run("local-cse", (currentProgram) => {
      // Same-block CSE (O2/Os).
      runLocalCSE(currentProgram, stats, analysisMIR);
    });
  }

  passes.run("ssa-dead-code-elimination", (currentProgram) => {
    // Removes Pure-effect operations whose single output is consumed by POP.
    // Pure-only: nothing with observable effects or multiple uses is touched.
    // The last SSA pass — later passes see the final MIR shape.
    runDeadCodeElimination(currentProgram, stats, analysisMIR);
  });

  if (level === "O2" || level === "Os") {
    passes.run("guest-object-provenance", (currentProgram) => {
      // SECURITY-SENSITIVE. Proves GETLOCAL outputs are guest-created and
      // marks them `guestObjectOutput` — the fast-path ticket for sandbox
      // property writes. The mark seeds exclusively at allocate ops
      // (NEWARRAY/NEWOBJECT/NEWREGEXP/CLOSURE), flows only through slots and
      // phi joins (AND meet), and is written after the last pass that can
      // move or eliminate values, so the mark cannot go stale. Nothing
      // unmarked ever takes the fast path; see guest-provenance.js.
      runGuestProvenance(currentProgram, stats, analysisMIR);
    });
  }

  passes.run("copy-folding", (currentProgram) => {
    // Peephole re-runs after the SSA passes: SSA passes rewrite the
    // instruction stream (elisions, replaced operands), so the offset-based
    // peepholes are re-applied to the final HIR to keep their decisions
    // consistent with what codegen will emit.
    currentProgram.scopes.forEach((scope) => foldConstants(scope, stats));
  });

  passes.run("copy-constant-branches", (currentProgram) => {
    currentProgram.scopes.forEach((scope) => foldConstantBranches(scope, stats));
  });

  passes.run("copy-unreachable-code", (currentProgram) => {
    currentProgram.scopes.forEach((scope) => eliminateUnreachableBlocks(scope, stats));
  });
  stats.nodesAfter = liveInstructionCount(program);
  return stats;
}

module.exports = { LEVELS, normalizeLevel, optimizeProgram };
