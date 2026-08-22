"use strict";

const OpSpec = require("../ir/op-spec");
const { ABI_VERSION } = require("../runtime");

// These operations lower to JavaScript control flow rather than to a Runtime
// helper call. Every other OpSpec entry must name one concrete helper. This is
// deliberately exhaustive so adding an opcode without an AOT lowering fails at
// compiler startup instead of silently falling back to interpretation.
const STATIC_CONTROL_OPS = new Set([
  "JUMP", "JTRUE", "JFALSE", "JCASE", "RETURN", "THROW", "TRY", "ENDTRY",
]);

// Operations that cannot be guarded safely while operands stay in generated
// locals continue through RuntimeInstance. Hot property/call paths use the
// smaller sandbox helpers below instead of materializing the operand stack.
const SANDBOX_MEDIATED_OPS = new Set([
  "DELPROP", "DELPROP_S", "IN", "INSTANCEOF", "INITPROP", "INITGETTER", "INITSETTER",
  "ITERATOR", "NEXTITER",
]);
const SANDBOX_SENSITIVE_PROPERTY_NAMES = [
  "constructor", "prototype", "__proto__", "caller", "callee", "arguments",
];

function sandboxPropertyRead(object, key, staticName = null) {
  const mediated = `$getSandbox($r, ${object}, ${key})`;
  if (staticName !== null && SANDBOX_SENSITIVE_PROPERTY_NAMES.includes(staticName)) return mediated;
  if (staticName !== null) return `${object}[${key}]`;
  const sensitive = staticName === null
    ? SANDBOX_SENSITIVE_PROPERTY_NAMES.map((name) => `${key} === ${jsLiteral(name)}`).join(" || ")
    : "false";
  return `((${sensitive}) ? ${mediated} : ${object}[${key}])`;
}

function validateLoweringCoverage() {
  const missing = OpSpec.byCode.filter((spec) =>
    !STATIC_CONTROL_OPS.has(spec.name) && !spec.helper
  );
  if (missing.length) {
    throw new Error(`Missing AOT lowering for: ${missing.map((spec) => spec.name).join(", ")}`);
  }
  return Object.freeze({
    total: OpSpec.count,
    directHelpers: OpSpec.byCode.filter((spec) => !STATIC_CONTROL_OPS.has(spec.name)).length,
    staticControl: STATIC_CONTROL_OPS.size,
  });
}

const LOWERING_COVERAGE = validateLoweringCoverage();

function jsLiteral(value) {
  if (value === undefined) return "void 0";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    if (Object.is(value, -0)) return "-0";
  }
  return JSON.stringify(value);
}

function metadata(scope, fastFrame = false, aliases = null, leafFrame = false) {
  const alias = (name) => aliases && aliases.has(name) ? aliases.get(name) : name;
  return {
    id: scope.id,
    name: alias(scope.name),
    script: scope.script,
    strict: scope.strict,
    lightweight: scope.lightweight,
    usesArguments: scope.usesArguments,
    parameterCount: scope.parameterCount,
    parameters: scope.parameters.map(alias),
    variables: scope.variables.map(alias),
    dynamicFunctions: scope.dynamicFunctions.map((dynamicScope) => dynamicScope === -1 ? -1 : dynamicScope.id),
    fastFrame,
    leafFrame,
  };
}

function callForInstruction(instruction, context = null) {
  if (instruction.optimized && instruction.optimized.kind === "duplicate") {
    return "$r.dup($f);";
  }
  if (instruction.optimized && instruction.optimized.kind === "drop-inputs") {
    return Array.from({ length: instruction.optimized.count }, () => "$r.pop($f);").join(" ");
  }
  if (instruction.optimized && instruction.optimized.kind === "literal") {
    return `$r.pushLiteral($f, ${jsLiteral(instruction.optimized.value)});`;
  }
  const spec = OpSpec.byName[instruction.op];
  if (!spec.helper) throw new Error(`No runtime helper for ${instruction.op}`);
  if (["beginTry", "endTry"].includes(spec.helper)) {
    throw new Error(`${instruction.op} has not been lowered by the structured-control-flow backend yet`);
  }
  if (instruction.op === "CLOSURE") {
    const nested = instruction.args[0];
    return context && context.perScopeFactories === false
      ? `$r.closure($f, $exec${nested.id}, $meta${nested.id});`
      : `$r.closureFactory($f, $make${nested.id});`;
  }
  if (instruction.op === "EVAL") {
    const nested = instruction.args[0];
    return nested === -1
      ? "$r.rejectDynamicEval($f);"
      : `$r.evalStatic($f, $exec${nested.id}, $meta${nested.id});`;
  }
  const args = instruction.args.map((value, index) => {
    if (index === 0 && ["HASVAR", "GETVAR", "SETVAR", "DELVAR", "REFVAR", "PUTVAR"].includes(instruction.op) &&
        context && context.bindingName) {
      return jsLiteral(context.bindingName(value));
    }
    return jsLiteral(value);
  });
  return `$r.${spec.helper}($f${args.length ? `, ${args.join(", ")}` : ""});`;
}

const NATIVE_BINARY_OPERATORS = Object.freeze({
  inOperator: "in",
  multiply: "*",
  divide: "/",
  modulo: "%",
  add: "+",
  subtract: "-",
  shiftLeft: "<<",
  shiftRight: ">>",
  shiftRightUnsigned: ">>>",
  lessThan: "<",
  greaterThan: ">",
  lessThanOrEqual: "<=",
  greaterThanOrEqual: ">=",
  equal: "==",
  notEqual: "!=",
  strictEqual: "===",
  strictNotEqual: "!==",
  bitAnd: "&",
  bitXor: "^",
  bitOr: "|",
  instanceOf: "instanceof",
});

const NATIVE_UNARY_EXPRESSIONS = Object.freeze({
  typeOf: (value) => `(typeof ${value})`,
  positive: (value) => `(+${value})`,
  negative: (value) => `(-${value})`,
  bitNot: (value) => `(~${value})`,
  logicalNot: (value) => `(!${value})`,
  increment: (value) => `(+${value} + 1)`,
  decrement: (value) => `(+${value} - 1)`,
});

const DYNAMIC_LOCAL_OPERATIONS = new Set([
  "WITH", "ENDWITH", "EVAL", "CATCH", "ENDCATCH",
]);

const IDENTIFIER_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function identifierAlias(index) {
  let value = index;
  let suffix = "";
  do {
    suffix = IDENTIFIER_ALPHABET[value % IDENTIFIER_ALPHABET.length] + suffix;
    value = Math.floor(value / IDENTIFIER_ALPHABET.length) - 1;
  } while (value >= 0);
  return `$${suffix}`;
}

function normalizeIdentifierProtection(value) {
  if (value === undefined || value === true || value === "alias") return "alias";
  if (value === false || value === "preserve") return "preserve";
  throw new Error(`Unknown identifier protection mode ${value}`);
}

function createIdentifierAliases(program, scopesById, protection, codegenStats) {
  const aliases = new Map(program.scopes.map((scope) => [scope.id, new Map()]));
  codegenStats.identifierProtection = {
    mode: protection,
    aliasedScopes: 0,
    aliasedBindings: 0,
    uniqueAliases: 0,
    reusedAliases: 0,
  };
  if (protection === "preserve") return aliases;

  // A with/catch/eval environment performs name lookup at runtime. Its own
  // scope, its lexical ancestors, and its lexical descendants therefore keep
  // source spelling. Independent sibling subtrees remain safe to rename.
  const dynamicAncestors = new Set();
  program.scopes.forEach((scope) => {
    if (!scope.instructions.some((instruction) => DYNAMIC_LOCAL_OPERATIONS.has(instruction.op))) return;
    for (let current = scope; current; current = current.parentId == null
      ? null
      : scopesById.get(current.parentId)) {
      dynamicAncestors.add(current.id);
    }
  });
  const dynamicChain = new Map();
  const hasDynamicAncestor = (scope) => {
    if (dynamicChain.has(scope.id)) return dynamicChain.get(scope.id);
    const dynamic = scope.instructions.some((instruction) =>
      DYNAMIC_LOCAL_OPERATIONS.has(instruction.op)
    ) || (scope.parentId != null && hasDynamicAncestor(scopesById.get(scope.parentId)));
    dynamicChain.set(scope.id, dynamic);
    return dynamic;
  };

  const forbidden = new Set(["arguments"]);
  program.scopes.forEach((scope) => {
    if (scope.name) forbidden.add(scope.name);
    scope.parameters.forEach((name) => forbidden.add(name));
    scope.variables.forEach((name) => forbidden.add(name));
  });
  const children = new Map();
  program.scopes.forEach((scope) => {
    const parentId = scope.parentId == null ? null : scope.parentId;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(scope);
  });
  const activeAliases = new Set();
  const usedAliases = new Set();
  const visited = new Set();

  function protectScope(scope) {
    if (visited.has(scope.id)) return;
    visited.add(scope.id);
    const scopeAliases = aliases.get(scope.id);
    const eligible = !scope.script && !dynamicAncestors.has(scope.id) && !hasDynamicAncestor(scope);
    if (eligible) {
      let nextAlias = 0;
      const allocate = () => {
        let alias;
        do alias = identifierAlias(nextAlias++); while (
          forbidden.has(alias) || activeAliases.has(alias)
        );
        activeAliases.add(alias);
        usedAliases.add(alias);
        return alias;
      };
      scope.variables.forEach((name) => {
        if (name !== "arguments" && name && !scopeAliases.has(name)) {
          scopeAliases.set(name, allocate());
        }
      });
      // Defensive coverage for malformed HIR where a parameter or
      // named-function binding is absent from variables.
      scope.parameters.concat(scope.name || []).forEach((name) => {
        if (name !== "arguments" && name && !scopeAliases.has(name)) {
          scopeAliases.set(name, allocate());
        }
      });
    }
    if (scopeAliases.size) {
      codegenStats.identifierProtection.aliasedScopes += 1;
      codegenStats.identifierProtection.aliasedBindings += scopeAliases.size;
    }
    (children.get(scope.id) || []).forEach(protectScope);
    scopeAliases.forEach((alias) => activeAliases.delete(alias));
  }

  (children.get(null) || []).forEach(protectScope);
  program.scopes.forEach(protectScope);
  codegenStats.identifierProtection.uniqueAliases = usedAliases.size;
  codegenStats.identifierProtection.reusedAliases =
    codegenStats.identifierProtection.aliasedBindings - usedAliases.size;
  return aliases;
}

function createInlineExpressionPlan(scope, budget) {
  if (!scope.lightweight || scope.script || scope.usesArguments ||
      scope.dynamicFunctions.length || scope.controlRegions.length) return null;
  let instructions = scope.instructions.filter((instruction) =>
    !instruction.elided && !instruction.unreachable && instruction.op !== "LOC"
  );

  if (instructions.length >= 3 && instructions[0].op === "CURRENT" &&
      ["SETLOCAL", "SETLOCAL2"].includes(instructions[1].op) &&
      instructions[2].op === "POP") {
    const selfIndex = instructions[1].args[0];
    const selfRead = instructions.slice(3).some((instruction) =>
      ["GETLOCAL", "GETLOCAL2"].includes(instruction.op) && instruction.args[0] === selfIndex
    );
    if (selfRead) return null;
    instructions = instructions.slice(3);
  }

  const firstReturn = instructions.findIndex((instruction) => instruction.op === "RETURN");
  if (firstReturn < 0 || firstReturn + 3 < instructions.length) return null;
  const tail = instructions.slice(firstReturn + 1);
  if (tail.length && !(tail.length === 2 && tail[0].op === "UNDEF" && tail[1].op === "RETURN")) {
    return null;
  }
  instructions = instructions.slice(0, firstReturn + 1);
  if (instructions.length - 1 > budget) return null;

  const stack = [];
  let requiresNumbers = false;
  for (const instruction of instructions) {
    if (instruction.optimized && instruction.optimized.kind === "literal") {
      stack.push(() => jsLiteral(instruction.optimized.value));
      continue;
    }
    switch (instruction.op) {
      case "INTEGER":
      case "NUMBER":
      case "STRING":
        stack.push(() => jsLiteral(instruction.args[0]));
        continue;
      case "UNDEF": stack.push(() => "void 0"); continue;
      case "NULL": stack.push(() => "null"); continue;
      case "TRUE": stack.push(() => "true"); continue;
      case "FALSE": stack.push(() => "false"); continue;
      case "GETLOCAL":
      case "GETLOCAL2": {
        const parameter = instruction.args[0] - 1;
        if (parameter < 0 || parameter >= scope.parameterCount) return null;
        stack.push((args) => args[parameter] || "void 0");
        continue;
      }
      case "RETURN":
        if (stack.length !== 1) return null;
        return {
          instructionCount: instructions.length - 1,
          parameterCount: scope.parameterCount,
          requiresNumbers,
          render(args) { return stack[0](args); },
          scopeId: scope.id,
        };
      default:
        break;
    }

    const spec = OpSpec.byName[instruction.op];
    const unary = spec && NATIVE_UNARY_EXPRESSIONS[spec.helper];
    if (unary) {
      if (stack.length < 1) return null;
      const input = stack.pop();
      requiresNumbers = true;
      stack.push((args) => unary(input(args)));
      continue;
    }
    const operator = spec && NATIVE_BINARY_OPERATORS[spec.helper];
    if (operator) {
      if (stack.length < 2) return null;
      const right = stack.pop();
      const left = stack.pop();
      if (!["===", "!=="].includes(operator)) requiresNumbers = true;
      stack.push((args) => `(${left(args)} ${operator} ${right(args)})`);
      continue;
    }
    return null;
  }
  return null;
}

function createInlinePlans(program, options, codegenStats) {
  const enabled = options.inlineSmallFunctions !== false && options.optimization === "O2" &&
    options.preserveSourceLocations !== true;
  const rawBudget = options.inlineBudget == null ? 12 : Number(options.inlineBudget);
  if (!Number.isInteger(rawBudget) || rawBudget < 0) {
    throw new Error(`Invalid inline budget ${options.inlineBudget}`);
  }
  const plans = new Map();
  if (enabled && rawBudget > 0) {
    program.scopes.forEach((scope) => {
      const plan = createInlineExpressionPlan(scope, rawBudget);
      if (plan) plans.set(scope.id, plan);
    });
  }
  codegenStats.inlining = {
    enabled,
    budget: rawBudget,
    candidates: plans.size,
    callSites: 0,
    guardedCallSites: 0,
    instructionsInlined: 0,
  };
  return plans;
}

function createCodegenContext(scope, options, codegenStats) {
  const enabled = options.stackToLocal !== false &&
    (options.optimization === "O2" || options.optimization === "Os");
  let localKind = null;
  if (enabled && !scope.script && options.directVariableScopeIds.has(scope.id)) {
    localKind = "frame";
  } else if (enabled && scope.script && !options.evalScopeIds.has(scope.id) && !scope.instructions.some((instruction) =>
    DYNAMIC_LOCAL_OPERATIONS.has(instruction.op)
  )) {
    localKind = "global";
  }
  const variableKind = (name) => {
    if (name === "arguments" && scope.usesArguments) {
      return { kind: "arguments", ownerId: scope.id };
    }
    let depth = 1;
    for (let parentId = scope.parentId; parentId != null;) {
      const parent = options.scopesById.get(parentId);
      if (!parent) break;
      if (name === "arguments" && parent.usesArguments) {
        return { kind: "captured-arguments", depth, ownerId: parent.id };
      }
      const index = parent.variables.lastIndexOf(name);
      if (!parent.script && index >= 0) {
        return { kind: "captured", depth, index: index + 1, ownerId: parent.id };
      }
      if (!parent.script) depth += 1;
      parentId = parent.parentId;
    }
    return { kind: options.globalNames.has(name) ? "declared-global" : "global" };
  };
  const globalValueProducerOffsets = new Set(scope.instructions.flatMap((instruction) =>
    instruction.optimized && instruction.optimized.kind === "reuse"
      ? [instruction.optimized.sourceOffset]
      : []
  ));
  return {
    enabled,
    directVariables: enabled && options.directVariableScopeIds.has(scope.id),
    bindingName(name) {
      let ownerId = null;
      if (!scope.script && scope.variables.lastIndexOf(name) >= 0) ownerId = scope.id;
      for (let parentId = scope.parentId; ownerId == null && parentId != null;) {
        const parent = options.scopesById.get(parentId);
        if (!parent) break;
        if (!parent.script && parent.variables.lastIndexOf(name) >= 0) ownerId = parent.id;
        parentId = parent.parentId;
      }
      const aliases = options.identifierAliases.get(ownerId);
      return aliases && aliases.has(name) ? aliases.get(name) : name;
    },
    perScopeFactories: options.perScopeFactories !== false,
    security: options.security || "sandbox",
    variableKind,
    writeProperty: scope.strict ? "$writeStrict" : "$writeSloppy",
    localKind,
    scope,
    stats: codegenStats.stackToLocal,
    instructionTemporaries: new Map(),
    globalValueProducerOffsets,
    temporaryOrigins: new Map(),
    knownFunctionBindings: new Map(),
    inlining: codegenStats.inlining,
    inlinePlans: options.inlinePlans,
    sizeOptimized: options.optimization === "Os",
    sizeTemporarySlots: new Set(),
    temporary: 0,
    // Structured regions nest generated code in blocks; a temporary is only
    // lexically visible where it was emitted. The active region stack plus
    // the current chunk id is recorded per temporary so cross-block "reuse"
    // and inline-guard references can be rejected instead of emitting a
    // reference to an out-of-scope const.
    regionStack: [],
    temporaryRegions: new Map(),
    chunkId: 0,
    temporaryScope() {
      return this.regionStack.join("/") + "/c" + this.chunkId;
    },
    // A recorded scope is visible at the use site when it is a prefix of the
    // current stack: outer regions' consts remain in scope inside nested
    // blocks, but siblings and inner regions are not.
    temporaryVisible(recorded) {
      const recordedParts = recorded.split("/");
      const currentParts = this.temporaryScope().split("/");
      if (recordedParts.length > currentParts.length) return false;
      for (let index = 0; index < recordedParts.length; index += 1) {
        if (recordedParts[index] !== currentParts[index]) return false;
      }
      return true;
    },
  };
}

function emitScopePrologue(lines, context) {
  if (!context.enabled) return;
  lines.push("  const $s = $f.stack;");
  if (context.localKind === "frame") lines.push("  const $l = $f.locals;");
  if (context.localKind === "global" || context.directVariables) lines.push("  const $g = $r.global;");
  if (!context.sizeOptimized && context.globalValueProducerOffsets.size) {
    lines.push(`  let ${Array.from(context.globalValueProducerOffsets, (offset) =>
      `$gv${context.scope.id}_${offset}`
    ).join(", ")};`);
  }
}

function emitStackToLocalRange(lines, scope, instructions, indent, context) {
  const stack = [];
  let reusableTemporary = 0;
  // Giant straight-line ranges (huge array literals) emit hundreds of
  // thousands of function-scope consts, which overflows V8's single-function
  // scope handling. Group them into transparent blocks, cut at flush points
  // where every pending temporary reference has been emitted.
  const CHUNK_CONSTS = 200;
  let chunkConsts = 0;
  let chunkOpen = false;

  // Collapse NEWARRAY + (literal-index, literal-value, INITPROP) chains into
  // native array literals. Giant data literals otherwise emit one helper
  // round-trip per element: hundreds of KB of source become tens of MB of
  // generated code that overflows V8's default stack when first compiled.
  const arrayLiteralRanges = new Map();
  {
    const literalOps = new Set(["INTEGER", "NUMBER", "STRING"]);
    for (let start = 0; start < instructions.length; start += 1) {
      const instruction = instructions[start];
      if (instruction.op !== "NEWARRAY" || instruction.elided || instruction.unreachable) continue;
      const elements = [];
      let cursor = start + 1;
      let matched = 0;
      while (true) {
        const key = instructions[cursor];
        if (!key || !["INTEGER", "NUMBER"].includes(key.op) || Number(key.args[0]) !== matched) break;
        const value = instructions[cursor + 1];
        if (!value || !literalOps.has(value.op)) break;
        const init = instructions[cursor + 2];
        if (!init || init.op !== "INITPROP") break;
        elements.push(jsLiteral(value.args[0]));
        cursor += 3;
        matched += 1;
      }
      if (matched > 0) {
        arrayLiteralRanges.set(instruction.offset, { elements, endIndex: cursor });
        start = cursor - 1;
      }
    }
  }

  function capturedLocal(variable) {
    return `${capturedFrame(variable)}.locals[${variable.index}]`;
  }

  function capturedFrame(variable) {
    return `$f.environment${".outer".repeat(variable.depth)}.frame`;
  }

  function temporary(expression, instruction = null, origin = null) {
    const globalValueProducer = instruction && !context.sizeOptimized &&
      context.globalValueProducerOffsets.has(instruction.offset);
    const name = globalValueProducer
      ? `$gv${scope.id}_${instruction.offset}`
      : context.sizeOptimized
        ? `$t${reusableTemporary++}`
        : `$v${scope.id}_${context.temporary++}`;
    if (context.sizeOptimized) {
      const reused = context.sizeTemporarySlots.has(name);
      context.sizeTemporarySlots.add(name);
      context.stats.sizeTemporaryAssignments += 1;
      if (reused) context.stats.sizeTemporaryReuses += 1;
      lines.push(`${indent}${name} = ${expression};`);
    } else if (globalValueProducer) {
      lines.push(`${indent}${name} = ${expression};`);
    } else {
      lines.push(`${indent}const ${name} = ${expression};`);
      chunkConsts += 1;
    }
    if (instruction && !context.instructionTemporaries.has(instruction.offset)) {
      context.instructionTemporaries.set(instruction.offset, name);
    }
    if (instruction) {
      context.temporaryRegions.set(name, context.temporaryScope());
    }
    if (origin) context.temporaryOrigins.set(name, origin);
    return name;
  }

  function load() {
    if (stack.length) return stack.pop();
    context.stats.stackLoads += 1;
    return temporary("$s.pop()");
  }

  function flush() {
    if (!stack.length) return;
    lines.push(`${indent}$s.push(${stack.join(", ")});`);
    context.stats.stackStores += stack.length;
    stack.length = 0;
    if (context.sizeOptimized) reusableTemporary = 0;
    if (chunkConsts >= CHUNK_CONSTS) {
      chunkConsts = 0;
      context.chunkId += 1;
      if (chunkOpen) lines.push(`${indent}}`);
      lines.push(`${indent}{`);
      chunkOpen = true;
    }
  }

  function direct(instruction) {
    if (context.security === "sandbox" && SANDBOX_MEDIATED_OPS.has(instruction.op)) {
      return false;
    }
    context.stats.instructions += 1;
    context.stats.helpersAvoided += 1;

    if (instruction.optimized && instruction.optimized.kind === "reuse") {
      const source = context.instructionTemporaries.get(instruction.optimized.sourceOffset);
      if (!source) return false;
      // Reuse pairs are dominance-guaranteed by the optimizer, so the
      // producing temporary is always lexically visible; only the inline
      // guard below needs the cross-block visibility check.
      stack.push(source);
      return true;
    }
    if (instruction.optimized && instruction.optimized.kind === "licm") {
      stack.push(`$h${scope.id}_${instruction.optimized.sourceOffset}`);
      return true;
    }

    if (instruction.optimized && instruction.optimized.kind === "literal") {
      stack.push(temporary(jsLiteral(instruction.optimized.value), instruction));
      return true;
    }
    if (instruction.optimized && instruction.optimized.kind === "duplicate") {
      if (!stack.length) return false;
      stack.push(stack[stack.length - 1]);
      return true;
    }
    if (instruction.optimized && instruction.optimized.kind === "drop-inputs") {
      for (let index = 0; index < instruction.optimized.count; index += 1) load();
      return true;
    }

    switch (instruction.op) {
      case "INTEGER":
      case "NUMBER":
      case "STRING":
        stack.push(temporary(jsLiteral(instruction.args[0])));
        return true;
      case "UNDEF":
        stack.push(temporary("void 0"));
        return true;
      case "NULL":
        stack.push(temporary("null"));
        return true;
      case "TRUE":
        stack.push(temporary("true"));
        return true;
      case "FALSE":
        stack.push(temporary("false"));
        return true;
      case "THIS":
        stack.push(temporary("$f.thisValue"));
        return true;
      case "CURRENT":
        stack.push(temporary("$f.currentFunction"));
        return true;
      case "CLOSURE": {
        if (!context.perScopeFactories) return false;
        const nested = instruction.args[0];
        stack.push(temporary(
          `$make${nested.id}($r, $f.environment)`,
          instruction,
          { kind: "closure", identity: null, scopeId: nested.id }
        ));
        context.temporaryOrigins.get(stack[stack.length - 1]).identity = stack[stack.length - 1];
        return true;
      }
      case "NEWARRAY":
        stack.push(temporary("[]"));
        return true;
      case "NEWOBJECT":
        stack.push(temporary("{}"));
        return true;
      case "NEWREGEXP":
        stack.push(temporary(`new RegExp(${jsLiteral(instruction.args[0])}, ${jsLiteral(instruction.args[1])})`));
        return true;
      case "LOC":
        lines.push(`${indent}$f.line = ${jsLiteral(instruction.args[0])}; $f.column = ${jsLiteral(instruction.args[1])};`);
        return true;
      case "DEBUGGER":
        lines.push(`${indent}debugger;`);
        return true;
      case "POP":
        load();
        return true;
      case "DUP":
        if (!stack.length) return false;
        stack.push(stack[stack.length - 1]);
        return true;
      case "DUP2":
        if (stack.length < 2) return false;
        stack.push(stack[stack.length - 2], stack[stack.length - 1]);
        return true;
      case "ROT2":
      case "ROT3":
      case "ROT4": {
        const count = Number(instruction.op.slice(3));
        if (stack.length < count) return false;
        const values = stack.splice(stack.length - count, count);
        values.unshift(values.pop());
        stack.push(...values);
        return true;
      }
      case "GETLOCAL":
      case "GETLOCAL2": {
        if (!context.localKind) return false;
        const index = instruction.args[0];
        const expression = context.localKind === "frame"
          ? `$l[${index}]`
          : `$g[${jsLiteral(scope.variables[index - 1])}]`;
        const knownFunction = context.knownFunctionBindings.get(index);
        stack.push(temporary(expression, instruction, knownFunction && {
          kind: "known-function",
          identity: knownFunction.identity,
          scopeId: knownFunction.scopeId,
        }));
        return true;
      }
      case "SETLOCAL":
      case "SETLOCAL2": {
        if (!context.localKind || !stack.length) return false;
        const index = instruction.args[0];
        const value = stack[stack.length - 1];
        if (context.localKind === "frame") {
          lines.push(`${indent}$l[${index}] = ${value};`);
        } else {
          lines.push(`${indent}${context.writeProperty}($g, ${jsLiteral(scope.variables[index - 1])}, ${value});`);
        }
        const origin = context.temporaryOrigins.get(value);
        if (origin && origin.kind === "closure") {
          context.knownFunctionBindings.set(index, origin);
        } else {
          context.knownFunctionBindings.delete(index);
        }
        return true;
      }
      case "HASVAR":
        if (!context.directVariables) return false;
        {
          const variable = context.variableKind(instruction.args[0]);
          if (variable.kind === "arguments") {
            stack.push(temporary("$getArguments($r, $f)"));
          } else if (variable.kind === "captured-arguments") {
            stack.push(temporary(`$getArguments($r, ${capturedFrame(variable)})`));
          } else if (variable.kind === "captured") {
            stack.push(temporary(capturedLocal(variable)));
          } else if (variable.kind === "declared-global") {
            stack.push(temporary(`$g[${jsLiteral(instruction.args[0])}]`));
          } else {
            stack.push(temporary(`$readGlobal($g, ${jsLiteral(instruction.args[0])}, false)`));
          }
        }
        return true;
      case "GETVAR":
        if (!context.directVariables) return false;
        {
          const variable = context.variableKind(instruction.args[0]);
          if (variable.kind === "arguments") {
            stack.push(temporary("$getArguments($r, $f)"));
          } else if (variable.kind === "captured-arguments") {
            stack.push(temporary(`$getArguments($r, ${capturedFrame(variable)})`));
          } else if (variable.kind === "captured") {
            stack.push(temporary(capturedLocal(variable)));
          } else if (variable.kind === "declared-global") {
            stack.push(temporary(`$g[${jsLiteral(instruction.args[0])}]`));
          } else {
            stack.push(temporary(`$readGlobal($g, ${jsLiteral(instruction.args[0])}, true)`));
          }
        }
        return true;
      case "SETVAR":
        if (!context.directVariables || !stack.length) return false;
        {
          const variable = context.variableKind(instruction.args[0]);
          if (variable.kind === "arguments") {
            lines.push(`${indent}$setArguments($f, ${stack[stack.length - 1]});`);
          } else if (variable.kind === "captured-arguments") {
            lines.push(`${indent}$setArguments(${capturedFrame(variable)}, ${stack[stack.length - 1]});`);
          } else if (variable.kind === "captured") {
            lines.push(`${indent}${capturedLocal(variable)} = ${stack[stack.length - 1]};`);
          } else if (variable.kind === "declared-global") {
            lines.push(`${indent}${context.writeProperty}($g, ${jsLiteral(instruction.args[0])}, ${stack[stack.length - 1]});`);
          } else {
            lines.push(`${indent}$writeGlobal($f, $g, ${jsLiteral(instruction.args[0])}, ${stack[stack.length - 1]});`);
          }
        }
        return true;
      case "DELVAR":
        if (!context.directVariables) return false;
        {
          const variable = context.variableKind(instruction.args[0]);
          stack.push(temporary(["arguments", "captured-arguments", "captured"].includes(variable.kind)
            ? "false"
            : `$deleteGlobal($g, ${jsLiteral(instruction.args[0])})`));
        }
        return true;
      case "GETPROP": {
        const key = load();
        const object = load();
        // Mediated results carry wrappers whose surface differs from the raw
        // target; reads chained off them must stay mediated. Non-direct
        // scopes resolve bindings through boundary.get, so every read there
        // stays mediated too (O0-equivalent semantics).
        const mediated = context.security === "sandbox" && (
          !context.directVariables ||
          (context.temporaryOrigins.get(object) || {}).kind === "mediated"
        );
        const expression = context.security === "sandbox"
          ? (mediated ? `$getSandbox($r, ${object}, ${key})` : sandboxPropertyRead(object, key))
          : `${object}[${key}]`;
        stack.push(temporary(
          expression,
          instruction,
          context.security === "sandbox" ? { kind: "mediated" } : null
        ));
        return true;
      }
      case "GETPROP_S": {
        const object = load();
        const staticName = instruction.args[0];
        const baseMediated = context.security === "sandbox" && (
          !context.directVariables ||
          (context.temporaryOrigins.get(object) || {}).kind === "mediated"
        );
        const mediated = baseMediated ||
          (context.security === "sandbox" && SANDBOX_SENSITIVE_PROPERTY_NAMES.includes(staticName));
        const expression = context.security === "sandbox"
          ? (mediated ? `$getSandbox($r, ${object}, ${jsLiteral(staticName)})` : `${object}[${jsLiteral(staticName)}]`)
          : `${object}[${jsLiteral(staticName)}]`;
        stack.push(temporary(
          expression,
          instruction,
          context.security === "sandbox" && mediated ? { kind: "mediated" } : null
        ));
        return true;
      }
      case "SETPROP": {
        const value = load();
        const key = load();
        const object = load();
        lines.push(context.security === "sandbox"
          ? `${indent}$setSandbox($r, ${context.writeProperty}, ${object}, ${key}, ${value});`
          : `${indent}${context.writeProperty}(${object}, ${key}, ${value});`);
        stack.push(value);
        return true;
      }
      case "SETPROP_S": {
        const value = load();
        const object = load();
        lines.push(context.security === "sandbox"
          ? `${indent}$setSandbox($r, ${context.writeProperty}, ${object}, ${jsLiteral(instruction.args[0])}, ${value});`
          : `${indent}${context.writeProperty}(${object}, ${jsLiteral(instruction.args[0])}, ${value});`);
        stack.push(value);
        return true;
      }
      case "CALL": {
        const count = instruction.args[0];
        if (scope.dynamicFunctions.length || stack.length < count + 2) return false;
        const args = stack.splice(stack.length - count, count);
        const thisValue = stack.pop();
        const callable = stack.pop();
        if (context.security === "sandbox") {
          stack.push(temporary(`$applySandbox($r, ${callable}, ${thisValue}, [${args.join(", ")}])`));
          return true;
        }
        const origin = context.temporaryOrigins.get(callable);
        const inlinePlan = origin && context.inlinePlans.get(origin.scopeId);
        // The identity guard references the closure temporary by name; when
        // that temporary was emitted in an enclosing region's block it is
        // out of scope here, so fall back to the runtime call.
        const identityVisible = inlinePlan && origin &&
          context.temporaryVisible(context.temporaryRegions.get(origin.identity));
        if (inlinePlan && identityVisible) {
          const checks = [`${callable} === ${origin.identity}`];
          if (inlinePlan.requiresNumbers) {
            for (let index = 0; index < inlinePlan.parameterCount; index += 1) {
              const argument = args[index];
              checks.push(argument ? `typeof ${argument} === "number"` : "false");
            }
          }
          const fallback = `$apply($r, $f, ${callable}, ${thisValue}, [${args.join(", ")}])`;
          const expression = `(${checks.join(" && ")} ? ${inlinePlan.render(args)} : ${fallback})`;
          stack.push(temporary(expression));
          context.inlining.callSites += 1;
          context.inlining.guardedCallSites += 1;
          context.inlining.instructionsInlined += inlinePlan.instructionCount;
        } else {
          stack.push(temporary(`$apply($r, $f, ${callable}, ${thisValue}, [${args.join(", ")}])`));
        }
        return true;
      }
      case "NEW": {
        const count = instruction.args[0];
        if (scope.dynamicFunctions.length || stack.length < count + 1) return false;
        const args = stack.splice(stack.length - count, count);
        const constructor = stack.pop();
        stack.push(temporary(context.security === "sandbox"
          ? `$constructSandbox($r, ${constructor}, [${args.join(", ")}])`
          : `$construct(${constructor}, [${args.join(", ")}])`));
        return true;
      }
      case "POSTINC":
      case "POSTDEC": {
        const value = load();
        const numeric = temporary(`+${value}`);
        const updated = temporary(`${numeric} ${instruction.op === "POSTINC" ? "+" : "-"} 1`);
        stack.push(updated, numeric);
        return true;
      }
      default:
        break;
    }

    const spec = OpSpec.byName[instruction.op];
    // instanceof resolves wrappers through the boundary so the prototype walk
    // sees the raw target, matching O0's RuntimeInstance.instanceOf.
    if (context.security === "sandbox" && spec && spec.helper === "instanceOf") {
      const right = load();
      const left = load();
      stack.push(temporary(`(${left} instanceof $instanceOfTarget($r, ${right}))`));
      return true;
    }
    const unary = NATIVE_UNARY_EXPRESSIONS[spec.helper];
    if (unary) {
      stack.push(temporary(unary(load())));
      return true;
    }
    const operator = NATIVE_BINARY_OPERATORS[spec.helper];
    if (operator) {
      const right = load();
      const left = load();
      stack.push(temporary(`(${left} ${operator} ${right})`));
      return true;
    }
    return false;
  }

  for (let loopIndex = 0; loopIndex < instructions.length; loopIndex += 1) {
    const instruction = instructions[loopIndex];
    const arrayLiteral = arrayLiteralRanges.get(instruction.offset);
    if (arrayLiteral) {
      stack.push(temporary(`[${arrayLiteral.elements.join(", ")}]`, instruction));
      loopIndex = arrayLiteral.endIndex - 1;
      continue;
    }
    if (instruction.op === "RETURN") {
      const value = load();
      lines.push(`${indent}return ${value};`);
      continue;
    }
    if (instruction.op === "THROW") {
      const value = load();
      lines.push(`${indent}throw ${value};`);
      continue;
    }
    const instructionCount = context.stats.instructions;
    const helperCount = context.stats.helpersAvoided;
    if (direct(instruction)) {
      if (context.sizeOptimized && stack.length === 0) reusableTemporary = 0;
      continue;
    }
    context.stats.instructions = instructionCount;
    context.stats.helpersAvoided = helperCount;
    flush();
    lines.push(`${indent}${callForInstruction(instruction, context)}`);
  }
  flush();
  if (chunkOpen) lines.push(`${indent}}`);
}

const BRANCH_OPS = new Set(["JUMP", "JTRUE", "JFALSE", "JCASE", "TRY", "ENDTRY"]);

function simpleStructuredRegion(scope) {
  if (!Array.isArray(scope.controlRegions) || scope.controlRegions.length !== 1) return null;
  const region = scope.controlRegions[0];
  if (!["If", "While", "DoWhile", "For", "ForIn"].includes(region.kind)) return null;
  const permittedControl = new Set([
    region.branch,
    region.backedge,
    region.alternateExit,
  ].filter(Number.isInteger));
  const unsupported = scope.instructions.some((instruction) =>
    !instruction.unreachable && BRANCH_OPS.has(instruction.op) && !permittedControl.has(instruction.offset)
  );
  if (unsupported) return null;
  const branch = Number.isInteger(region.branch)
    ? scope.instructions.find((instruction) => instruction.offset === region.branch)
    : null;
  const backedge = Number.isInteger(region.backedge)
    ? scope.instructions.find((instruction) => instruction.offset === region.backedge)
    : null;
  if (branch && !["JTRUE", "JFALSE"].includes(branch.op)) return null;
  if (region.kind === "If") {
    if (!branch) return null;
    if (Number.isInteger(region.alternateExit)) {
      const exit = scope.instructions.find((instruction) => instruction.offset === region.alternateExit);
      if (!exit || exit.op !== "JUMP" || exit.args[0] !== region.end) return null;
    }
    return region;
  }
  if (backedge && (backedge.op !== "JUMP" || backedge.args[0] !== region.testStart)) return null;
  return region;
}

function emitStraightRange(lines, scope, start, end, indent, context) {
  const instructions = scope.instructions.filter((instruction) =>
    instruction.offset >= start && instruction.offset < end &&
    !instruction.elided && !instruction.unreachable
  );
  if (context && context.enabled) {
    emitStackToLocalRange(lines, scope, instructions, indent, context);
    return;
  }
  instructions.forEach((instruction) => {
    switch (instruction.op) {
      case "RETURN":
        lines.push(`${indent}return $r.result($f);`);
        break;
      case "THROW":
        lines.push(`${indent}return $r.throwValue($f);`);
        break;
      default:
        if (STATIC_CONTROL_OPS.has(instruction.op)) {
          throw new Error(`Unexpected ${instruction.op} in structured straight-line range`);
        }
        lines.push(`${indent}${callForInstruction(instruction, context)}`);
    }
  });
}

function branchValue(context) {
  return context && context.enabled ? "$s.pop()" : "$r.branch($f)";
}

function emitLoopCondition(lines, scope, region, indent, context) {
  if (!Number.isInteger(region.branch)) return;
  emitStraightRange(lines, scope, region.testStart, region.branch, indent, context);
  const branch = scope.instructions.find((instruction) => instruction.offset === region.branch);
  const exitsWhenTrue = branch.op === "JTRUE";
  lines.push(`${indent}if (${exitsWhenTrue ? "" : "!"}${branchValue(context)}) break $loop${region.id};`);
}

function generateSimpleStructuredScope(scope, region, context) {
  const lines = [`function $exec${scope.id}($r, $f) {`];
  emitScopePrologue(lines, context);
  emitStraightRange(lines, scope, 0, region.start, "  ", context);

  if (region.kind === "For") {
    emitStraightRange(lines, scope, region.initStart, region.initEnd, "  ", context);
  } else if (region.kind === "ForIn") {
    emitStraightRange(lines, scope, region.iteratorStart, region.iteratorEnd, "  ", context);
  }

  const loopHeaders = new Set([region.testStart, region.bodyStart, region.start]);
  (scope.loopInvariantLoads || []).filter((load) => loopHeaders.has(load.header)).forEach((load) => {
    lines.push(`  const $h${scope.id}_${load.sourceOffset} = $l[${load.localIndex}];`);
  });

  lines.push(`  $loop${region.id}: while (true) {`);
  if (region.kind === "DoWhile") {
    emitStraightRange(lines, scope, region.bodyStart, region.bodyEnd, "    ", context);
    emitStraightRange(lines, scope, region.testStart, region.branch, "    ", context);
    const branch = scope.instructions.find((instruction) => instruction.offset === region.branch);
    lines.push(`    if (${branch.op === "JTRUE" ? "!" : ""}${branchValue(context)}) break $loop${region.id};`);
  } else if (region.kind === "ForIn") {
    emitStraightRange(lines, scope, region.testStart, region.branch, "    ", context);
    const branch = scope.instructions.find((instruction) => instruction.offset === region.branch);
    lines.push(`    if (${branch.op === "JFALSE" ? "!" : ""}${branchValue(context)}) break $loop${region.id};`);
    emitStraightRange(lines, scope, region.bodyStart, region.bodyEnd, "    ", context);
  } else {
    emitLoopCondition(lines, scope, region, "    ", context);
    emitStraightRange(lines, scope, region.bodyStart, region.bodyEnd, "    ", context);
    if (region.kind === "For") {
      emitStraightRange(lines, scope, region.updateStart, region.updateEnd, "    ", context);
    }
  }
  lines.push("  }");
  emitStraightRange(lines, scope, region.end, scope.codeLength, "  ", context);
  lines.push("}");
  return lines.join("\n");
}

function generateSimpleStructuredIf(scope, region, context) {
  const lines = [`function $exec${scope.id}($r, $f) {`];
  emitScopePrologue(lines, context);
  emitStraightRange(lines, scope, 0, region.testStart, "  ", context);
  emitStraightRange(lines, scope, region.testStart, region.branch, "  ", context);
  const branch = scope.instructions.find((instruction) => instruction.offset === region.branch);
  const consequentWhenTrue = branch.op === "JTRUE" || region.alternateStart === null;
  lines.push(`  if (${consequentWhenTrue ? "" : "!"}${branchValue(context)}) {`);
  emitStraightRange(lines, scope, region.consequentStart, region.consequentEnd, "    ", context);
  if (region.alternateStart !== null) {
    lines.push("  } else {");
    emitStraightRange(lines, scope, region.alternateStart, region.alternateEnd, "    ", context);
  }
  lines.push("  }");
  emitStraightRange(lines, scope, region.end, scope.codeLength, "  ", context);
  lines.push("}");
  return lines.join("\n");
}

function structuredScopePlan(scope) {
  if (!Array.isArray(scope.controlRegions) || !scope.controlRegions.length) return null;
  if (scope.controlRegions.some((region) =>
    !["If", "Conditional", "Logical", "While", "DoWhile", "For", "ForIn", "Switch", "TryCatch", "TryFinally", "Label"].includes(region.kind)
  )) return null;

  const ownedControl = new Set();
  const ignoredOffsets = new Set();
  const exitsByOffset = new Map();
  const syntheticByStart = new Map((scope.syntheticRanges || []).map((range) => [range.start, range]));
  for (const range of scope.syntheticRanges || []) {
    scope.instructions.filter((instruction) =>
      instruction.offset >= range.start && instruction.offset < range.end && BRANCH_OPS.has(instruction.op)
    ).forEach((instruction) => ownedControl.add(instruction.offset));
  }
  for (const region of scope.controlRegions) {
    [region.branch, region.backedge, region.alternateExit].filter(Number.isInteger)
      .forEach((offset) => ownedControl.add(offset));
    if (region.kind === "Switch") {
      ownedControl.add(region.dispatchExit);
      (region.cases || []).filter((caseRegion) => !caseRegion.default)
        .forEach((caseRegion) => ownedControl.add(caseRegion.branch));
    }
    if (region.kind === "TryCatch") {
      [region.tryEnter, region.tryExit, region.catchExit].forEach((offset) => ownedControl.add(offset));
      scope.instructions.filter((instruction) =>
        instruction.offset >= region.start && instruction.offset < region.end && instruction.op === "ENDTRY"
      ).forEach((instruction) => ownedControl.add(instruction.offset));
      scope.instructions.filter((instruction) =>
        instruction.offset >= region.catchBodyStart && instruction.offset < region.catchBodyEnd &&
        instruction.op === "ENDCATCH"
      ).forEach((instruction) => ignoredOffsets.add(instruction.offset));
    }
    if (region.kind === "TryFinally") {
      [region.tryEnter, region.innerTryEnter, region.innerTryExit, region.catchExit, region.tryExit]
        .forEach((offset) => ownedControl.add(offset));
      scope.instructions.filter((instruction) =>
        instruction.offset >= region.start && instruction.offset < region.end && instruction.op === "ENDTRY"
      ).forEach((instruction) => ownedControl.add(instruction.offset));
      scope.instructions.filter((instruction) =>
        instruction.offset >= region.catchBodyStart && instruction.offset < region.catchBodyEnd &&
        instruction.op === "ENDCATCH"
      ).forEach((instruction) => ignoredOffsets.add(instruction.offset));
    }
    for (const exit of region.exits || []) {
      if (exitsByOffset.has(exit.offset) || !["break", "continue"].includes(exit.kind)) return null;
      ownedControl.add(exit.offset);
      exitsByOffset.set(exit.offset, { ...exit, region });
    }
    const branch = Number.isInteger(region.branch)
      ? scope.instructions.find((instruction) => instruction.offset === region.branch)
      : null;
    if (!["Switch", "TryCatch", "TryFinally", "Label"].includes(region.kind) &&
        (region.kind !== "For" || region.branch !== null)) {
      if (!branch || !["JTRUE", "JFALSE"].includes(branch.op)) return null;
    }
    if (Number.isInteger(region.backedge)) {
      const backedge = scope.instructions.find((instruction) => instruction.offset === region.backedge);
      if (!backedge || backedge.op !== "JUMP" || backedge.args[0] !== region.testStart) return null;
    }
    if (Number.isInteger(region.alternateExit)) {
      const exit = scope.instructions.find((instruction) => instruction.offset === region.alternateExit);
      if (!exit || exit.op !== "JUMP" || exit.args[0] !== region.end) return null;
    }
  }

  for (let leftIndex = 0; leftIndex < scope.controlRegions.length; leftIndex += 1) {
    const left = scope.controlRegions[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < scope.controlRegions.length; rightIndex += 1) {
      const right = scope.controlRegions[rightIndex];
      const disjoint = left.end <= right.start || right.end <= left.start;
      const nested = (left.start <= right.start && right.end <= left.end) ||
        (right.start <= left.start && left.end <= right.end);
      if (!disjoint && !nested) return null;
    }
  }

  const completionsByStart = new Map();
  const completionsByRegion = new Map();
  let nextCompletionId = 1;
  for (const range of scope.syntheticRanges || []) {
    const owner = scope.controlRegions.filter((region) =>
      region.kind === "TryFinally" && region.start <= range.start && range.end <= region.end
    ).sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
    if (!owner) return null;
    const abrupt = scope.instructions.find((instruction) =>
      instruction.offset >= range.end &&
      (instruction.op === "RETURN" ||
       (instruction.op === "JUMP" && exitsByOffset.has(instruction.offset)))
    );
    if (!abrupt || abrupt.offset >= owner.end) return null;
    const completion = {
      id: nextCompletionId++,
      owner,
      range,
      cleanupStart: range.end,
      abrupt,
      exit: abrupt.op === "JUMP" ? exitsByOffset.get(abrupt.offset) : null,
    };
    completionsByStart.set(range.start, completion);
    if (!completionsByRegion.has(owner.id)) completionsByRegion.set(owner.id, []);
    completionsByRegion.get(owner.id).push(completion);
  }

  if (scope.instructions.some((instruction) =>
    !instruction.unreachable && BRANCH_OPS.has(instruction.op) && !ownedControl.has(instruction.offset)
  )) return null;
  const regionsByStart = new Map();
  scope.controlRegions.forEach((region) => {
    if (!regionsByStart.has(region.start)) regionsByStart.set(region.start, []);
    regionsByStart.get(region.start).push(region);
  });
  regionsByStart.forEach((regions) => regions.sort((left, right) =>
    (right.end - right.start) - (left.end - left.start)
  ));
  return {
    regionsByStart,
    exitsByOffset,
    syntheticByStart,
    completionsByStart,
    completionsByRegion,
    ignoredOffsets,
  };
}

function generateStructuredScope(scope, plan, context) {
  const lines = [`function $exec${scope.id}($r, $f) {`];
  emitScopePrologue(lines, context);
  const instructionsByOffset = new Map(scope.instructions.map((instruction) => [instruction.offset, instruction]));

  function emitRange(start, end, indent, activeRegion = null) {
    let offset = start;
    if (context.enabled) context.regionStack.push(activeRegion);
    try {
    while (offset < end) {
      const synthetic = plan.syntheticByStart.get(offset);
      if (synthetic && synthetic.end <= end) {
        const completion = plan.completionsByStart.get(offset);
        if (completion) {
          lines.push(`${indent}$completion${scope.id}_${completion.owner.id} = ${completion.id};`);
          lines.push(`${indent}break $completionRegion${scope.id}_${completion.owner.id};`);
          offset = completion.abrupt.end;
        } else {
          offset = synthetic.end;
        }
        continue;
      }
      const region = (plan.regionsByStart.get(offset) || []).find((candidate) =>
        candidate !== activeRegion && candidate.end <= end
      );
      if (region) {
        emitRegion(region, indent);
        offset = region.end;
        continue;
      }
      const instruction = instructionsByOffset.get(offset);
      if (!instruction) throw new Error(`Missing HIR instruction at structured offset ${offset}`);
      if (context.enabled) {
        let cursor = offset;
        let hasBatch = false;
        while (cursor < end) {
          if (cursor !== offset) {
            const nestedRegion = (plan.regionsByStart.get(cursor) || []).some((candidate) =>
              candidate !== activeRegion && candidate.end <= end
            );
            if (nestedRegion || plan.syntheticByStart.has(cursor)) break;
          }
          const candidate = instructionsByOffset.get(cursor);
          if (!candidate) break;
          if (!candidate.elided && !candidate.unreachable) {
            if (plan.ignoredOffsets.has(candidate.offset) || plan.exitsByOffset.has(candidate.offset)) break;
            if (STATIC_CONTROL_OPS.has(candidate.op) && !["RETURN", "THROW"].includes(candidate.op)) break;
          }
          hasBatch = true;
          cursor = candidate.end;
          if (["RETURN", "THROW"].includes(candidate.op)) break;
        }
        if (hasBatch) {
          emitStraightRange(lines, scope, offset, cursor, indent, context);
          offset = cursor;
          continue;
        }
      }
      offset = instruction.end;
      if (instruction.elided || instruction.unreachable) continue;
      if (plan.ignoredOffsets.has(instruction.offset)) continue;
      const controlExit = plan.exitsByOffset.get(instruction.offset);
      if (controlExit) {
        emitControlExit(controlExit, indent);
        continue;
      }
      switch (instruction.op) {
        case "RETURN":
          lines.push(`${indent}return $r.result($f);`);
          break;
        case "THROW":
          lines.push(`${indent}return $r.throwValue($f);`);
          break;
        case "ENDTRY":
          break;
        default:
          if (STATIC_CONTROL_OPS.has(instruction.op)) {
            throw new Error(`Unexpected ${instruction.op} in Structured Control LIR`);
          }
          lines.push(`${indent}${callForInstruction(instruction, context)}`);
      }
    }
    } finally {
      if (context.enabled) context.regionStack.pop();
    }
  }

  function branchCondition(region) {
    const branch = instructionsByOffset.get(region.branch);
    return branch.op === "JTRUE";
  }

  function emitControlExit(exit, indent) {
    const region = exit.region;
    if (exit.kind === "break") {
      const prefix = region.kind === "Switch" ? "switch" : region.kind === "Label" ? "label" : "loop";
      lines.push(`${indent}break $${prefix}${region.id};`);
      return;
    }
    if (region.kind === "For") {
      emitRange(region.updateStart, region.updateEnd, indent, region);
    } else if (region.kind === "DoWhile") {
      emitRange(region.testStart, region.branch, indent, region);
      lines.push(`${indent}if (${branchCondition(region) ? "!" : ""}${branchValue(context)}) break $loop${region.id};`);
    }
    lines.push(`${indent}continue $loop${region.id};`);
  }

  function emitLoopInvariantLoads(region, indent) {
    const headers = new Set([region.testStart, region.bodyStart, region.start]);
    (scope.loopInvariantLoads || []).filter((load) => headers.has(load.header)).forEach((load) => {
      lines.push(
        `${indent}const $h${scope.id}_${load.sourceOffset} = $l[${load.localIndex}];`
      );
    });
  }

  function emitRegion(region, indent) {
    if (region.kind === "If" || region.kind === "Conditional") {
      emitRange(region.testStart, region.branch, indent, region);
      const trueConsequent = branchCondition(region) || region.alternateStart === null;
      lines.push(`${indent}if (${trueConsequent ? "" : "!"}${branchValue(context)}) {`);
      emitRange(region.consequentStart, region.consequentEnd, `${indent}  `, region);
      if (region.alternateStart !== null) {
        lines.push(`${indent}} else {`);
        emitRange(region.alternateStart, region.alternateEnd, `${indent}  `, region);
      }
      lines.push(`${indent}}`);
      return;
    }

    if (region.kind === "Logical") {
      emitRange(region.leftStart, region.branch, indent, region);
      const branch = instructionsByOffset.get(region.branch);
      const evaluateRightWhenTrue = branch.op === "JFALSE";
      lines.push(`${indent}if (${evaluateRightWhenTrue ? "" : "!"}${branchValue(context)}) {`);
      emitRange(region.rightStart, region.rightEnd, `${indent}  `, region);
      lines.push(`${indent}}`);
      return;
    }

    if (region.kind === "Switch") {
      const selector = `$case${region.id}`;
      lines.push(`${indent}let ${selector} = -1;`);
      emitRange(region.discriminantStart, region.discriminantEnd, indent, region);
      region.cases.filter((caseRegion) => {
        if (caseRegion.default) return false;
        const branch = instructionsByOffset.get(caseRegion.branch);
        return branch && !branch.unreachable;
      }).forEach((caseRegion) => {
        lines.push(`${indent}if (${selector} === -1) {`);
        emitRange(caseRegion.testStart, caseRegion.branch, `${indent}  `, region);
        lines.push(`${indent}  if ($r.caseJump($f)) ${selector} = ${caseRegion.index};`);
        lines.push(`${indent}}`);
      });
      const defaultCase = region.cases.find((caseRegion) => caseRegion.default);
      lines.push(`${indent}if (${selector} === -1) {`);
      lines.push(`${indent}  $r.pop($f);`);
      if (defaultCase) lines.push(`${indent}  ${selector} = ${defaultCase.index};`);
      lines.push(`${indent}}`);
      lines.push(`${indent}$switch${region.id}: switch (${selector}) {`);
      region.cases.forEach((caseRegion) => {
        lines.push(`${indent}  case ${caseRegion.index}:`);
        emitRange(caseRegion.bodyStart, caseRegion.bodyEnd, `${indent}    `, region);
      });
      lines.push(`${indent}}`);
      return;
    }

    if (region.kind === "TryCatch") {
      const suffix = `${scope.id}_${region.id}`;
      const catchInstruction = instructionsByOffset.get(region.catchStart);
      lines.push(`${indent}const $checkpoint${suffix} = $r.tryCheckpoint($f);`);
      lines.push(`${indent}try {`);
      emitRange(region.tryBodyStart, region.tryBodyEnd, `${indent}  `, region);
      lines.push(`${indent}} catch ($error${suffix}) {`);
      lines.push(`${indent}  $r.catchException($f, $checkpoint${suffix}, $error${suffix});`);
      lines.push(`${indent}  $r.beginCatch($f, ${jsLiteral(catchInstruction.args[0])});`);
      lines.push(`${indent}  try {`);
      emitRange(region.catchBodyStart, region.catchBodyEnd, `${indent}    `, region);
      lines.push(`${indent}  } finally {`);
      lines.push(`${indent}    $r.endCatch($f);`);
      lines.push(`${indent}  }`);
      lines.push(`${indent}}`);
      return;
    }

    if (region.kind === "TryFinally") {
      const suffix = `${scope.id}_${region.id}`;
      const completions = plan.completionsByRegion.get(region.id) || [];
      const completionIndent = completions.length ? `${indent}  ` : indent;
      if (completions.length) {
        lines.push(`${indent}let $completion${suffix} = 0;`);
        lines.push(`${indent}$completionRegion${suffix}: {`);
      }
      if (region.hasCatch) {
        const catchInstruction = instructionsByOffset.get(region.catchStart);
        lines.push(`${completionIndent}const $checkpoint${suffix} = $r.tryCheckpoint($f);`);
        lines.push(`${completionIndent}try {`);
        emitRange(region.tryBodyStart, region.tryBodyEnd, `${completionIndent}  `, region);
        lines.push(`${completionIndent}} catch ($error${suffix}) {`);
        lines.push(`${completionIndent}  $r.catchException($f, $checkpoint${suffix}, $error${suffix});`);
        lines.push(`${completionIndent}  $r.beginCatch($f, ${jsLiteral(catchInstruction.args[0])});`);
        lines.push(`${completionIndent}  try {`);
        emitRange(region.catchBodyStart, region.catchBodyEnd, `${completionIndent}    `, region);
        lines.push(`${completionIndent}  } finally {`);
        lines.push(`${completionIndent}    $r.endCatch($f);`);
        lines.push(`${completionIndent}  }`);
        lines.push(`${completionIndent}} finally {`);
      } else {
        lines.push(`${completionIndent}try {`);
        emitRange(region.tryBodyStart, region.tryBodyEnd, `${completionIndent}  `, region);
        lines.push(`${completionIndent}} finally {`);
      }
      emitRange(region.finalizerStart, region.finalizerEnd, `${completionIndent}  `, region);
      lines.push(`${completionIndent}}`);
      if (completions.length) {
        lines.push(`${indent}}`);
        completions.forEach((completion) => {
          lines.push(`${indent}if ($completion${suffix} === ${completion.id}) {`);
          emitRange(completion.cleanupStart, completion.abrupt.offset, `${indent}  `, region);
          if (completion.abrupt.op === "RETURN") {
            lines.push(`${indent}  return $r.result($f);`);
          } else {
            emitControlExit(completion.exit, `${indent}  `);
          }
          lines.push(`${indent}}`);
        });
      }
      return;
    }

    if (region.kind === "Label") {
      lines.push(`${indent}$label${region.id}: {`);
      emitRange(region.bodyStart, region.bodyEnd, `${indent}  `, region);
      lines.push(`${indent}}`);
      return;
    }

    if (region.kind === "For") {
      emitRange(region.initStart, region.initEnd, indent, region);
    } else if (region.kind === "ForIn") {
      emitRange(region.iteratorStart, region.iteratorEnd, indent, region);
    }
    emitLoopInvariantLoads(region, indent);
    lines.push(`${indent}$loop${region.id}: while (true) {`);
    const bodyIndent = `${indent}  `;
    if (region.kind === "DoWhile") {
      emitRange(region.bodyStart, region.bodyEnd, bodyIndent, region);
      emitRange(region.testStart, region.branch, bodyIndent, region);
      lines.push(`${bodyIndent}if (${branchCondition(region) ? "!" : ""}${branchValue(context)}) break $loop${region.id};`);
    } else if (region.kind === "ForIn") {
      emitRange(region.testStart, region.branch, bodyIndent, region);
      lines.push(`${bodyIndent}if (${branchCondition(region) ? "" : "!"}${branchValue(context)}) break $loop${region.id};`);
      emitRange(region.bodyStart, region.bodyEnd, bodyIndent, region);
    } else {
      if (Number.isInteger(region.branch)) {
        emitRange(region.testStart, region.branch, bodyIndent, region);
        lines.push(`${bodyIndent}if (${branchCondition(region) ? "" : "!"}${branchValue(context)}) break $loop${region.id};`);
      }
      emitRange(region.bodyStart, region.bodyEnd, bodyIndent, region);
      if (region.kind === "For") {
        emitRange(region.updateStart, region.updateEnd, bodyIndent, region);
      }
    }
    lines.push(`${indent}}`);
  }

  emitRange(0, scope.codeLength, "  ");
  lines.push("}");
  return lines.join("\n");
}

function isStraightScope(scope) {
  return scope.instructions.every((instruction) =>
    instruction.unreachable || instruction.elided ||
    !STATIC_CONTROL_OPS.has(instruction.op) || ["RETURN", "THROW"].includes(instruction.op)
  );
}

function generateStraightScope(scope, context) {
  const lines = [`function $exec${scope.id}($r, $f) {`];
  emitScopePrologue(lines, context);
  emitStraightRange(lines, scope, 0, scope.codeLength, "  ", context);
  lines.push("}");
  return lines.join("\n");
}

function generateScope(scope, options, codegenStats) {
  const context = createCodegenContext(scope, options, codegenStats);
  const plan = structuredScopePlan(scope);
  let code;
  if (plan) {
    codegenStats.structuredScopes += 1;
    code = generateStructuredScope(scope, plan, context);
  } else if (isStraightScope(scope)) {
    codegenStats.straightScopes += 1;
    code = generateStraightScope(scope, context);
  } else {
    const structuredRegion = simpleStructuredRegion(scope);
    if (!structuredRegion) {
      throw new Error(
        `Unable to lower control flow in scope ${scope.id} (${scope.name || "<anonymous>"}) ` +
        "to Structured Control LIR; interpreter/trampoline fallback is forbidden"
      );
    }
    codegenStats.structuredScopes += 1;
    code = structuredRegion.kind === "If"
      ? generateSimpleStructuredIf(scope, structuredRegion, context)
      : generateSimpleStructuredScope(scope, structuredRegion, context);
  }
  if (context.sizeOptimized && context.sizeTemporarySlots.size) {
    const declaration = `  let ${Array.from(context.sizeTemporarySlots).join(", ")};`;
    code = code.replace("\n", `\n${declaration}\n`);
    codegenStats.sizeOptimization.temporarySlots += context.sizeTemporarySlots.size;
  }
  return code;
}

function generateLeafFactory(scope, security) {
  const localCount = scope.variables.length + 1;
  const locals = localsLiteral(scope, localCount);
  const lines = [
    `function $make${scope.id}($r, $environment) {`,
    `  const $execute = $exec${scope.id};`,
    `  const $metadata = $meta${scope.id};`,
    "  let $compiled;",
    "  $compiled = function(...$args) {",
    "    let $this = this;",
  ];
  if (security === "sandbox") {
    lines.push(
      "    if (!$r.boundary.consumeInternalGuestEntry()) {",
      "      $this = $r.boundary.secureValue($this);",
      "      $args = $r.boundary.secureArguments($args);",
      // Host-initiated entries (no program execution active) copy plain-data
      // values like globals do, so guest mutations cannot reach host objects
      // through a returned function's arguments or receiver.
      "      if (!$r.boundary.guestExecutionActive) {",
      "        $this = $r.boundary.secureHostEntryValue($this);",
      "        $args = $r.boundary.secureHostEntryArguments($args);",
      "      }",
      "    }"
    );
  }
  lines.push(
    "    if (!$metadata.strict) {",
    "      if ($this === void 0 || $this === null) $this = $r.global;",
    "      else if (typeof $this !== \"object\" && typeof $this !== \"function\") $this = Object($this);",
    "    }",
    `    const $f = { metadata: $metadata, locals: [${locals}], thisValue: $this, currentFunction: $compiled, callerFrame: $r.currentFrame, callArgs: $args };`
  );
  lines.push(
    "    $r.currentFrame = $f;",
    "    try {",
    "      return $execute($r, $f);",
    "    } finally {",
    "      $r.currentFrame = $f.callerFrame;",
    "    }",
    "  };",
    "  return $initializeCompiled($r, $compiled, $metadata);",
    "}"
  );
  return lines.join("\n");
}

function generateFactory(scope, leafFrame = false, security = "sandbox", fastFrame = false, shape = {}) {
  if (scope.script) return null;
  if (leafFrame) return generateLeafFactory(scope, security);
  if (fastFrame) return generateFastFrameFactory(scope, security, shape);
  return [
    `function $make${scope.id}($r, $environment, $execute = $exec${scope.id}, $metadata = $meta${scope.id}) {`,
    "  let $compiled;",
    "  $compiled = function(...$args) {",
    "    return $invokeCompiled($r, $execute, $metadata, $environment, $compiled, this, new.target !== void 0, $args);",
    "  };",
    "  return $initializeCompiled($r, $compiled, $metadata);",
    "}",
  ].join("\n");
}

// Parameter slots are filled directly from $args inside the literal, so frame
// construction needs no parameter copy loop. A literal also stays on V8's
// packed-elements fast path for any size; the Array.from fallback in
// createFastLocals is only used by non-fast frames.
function localsLiteral(scope, localCount) {
  return Array.from({ length: localCount }, (_, index) =>
    index > 0 && index <= scope.parameterCount ? `$args[${index - 1}]` : "void 0"
  ).join(", ");
}

// Fast frames skip the dynamic-environment machinery, so their factory can
// build the frame inline instead of dispatching through
// invokeCompiledFunction + createFrame. The construction mirrors
// RuntimeInstance.createFrame's fastFrame branch exactly; fields the scope
// never reads are omitted from the literal.
function generateFastFrameFactory(scope, security, shape = {}) {
  const localCount = scope.variables.length + 1;
  const locals = localsLiteral(scope, localCount);
  const lines = [
    `function $make${scope.id}($r, $environment) {`,
    `  const $execute = $exec${scope.id};`,
    `  const $metadata = $meta${scope.id};`,
    "  let $compiled;",
    "  $compiled = function(...$args) {",
    "    const $constructing = new.target !== void 0;",
    "    let $this = this;",
  ];
  if (security === "sandbox") {
    lines.push(
      "    if (!$r.boundary.consumeInternalGuestEntry()) {",
      "      $this = $r.boundary.secureValue($this);",
      "      $args = $r.boundary.secureArguments($args);",
      // Host-initiated entries (no program execution active) copy plain-data
      // values like globals do, so guest mutations cannot reach host objects
      // through a returned function's arguments or receiver.
      "      if (!$r.boundary.guestExecutionActive) {",
      "        $this = $r.boundary.secureHostEntryValue($this);",
      "        $args = $r.boundary.secureHostEntryArguments($args);",
      "      }",
      "    }"
    );
  }
  lines.push(
    "    if (!$metadata.strict) {",
    "      if ($this === void 0 || $this === null) $this = $r.global;",
    "      else if (typeof $this !== \"object\" && typeof $this !== \"function\") $this = Object($this);",
    "    }"
  );
  // Sandbox mode can never pollute Array.prototype (attempts are observed and
  // blocked), and hardenFastFrameChain still swaps active stacks on observed
  // attempts, so literal arrays are safe there. Trusted mode keeps the
  // flag-aware allocation.
  const stackAlloc = security === "sandbox" ? "[]" : "$r.createFastArray()";
  const frameFields = [
    "metadata: $metadata",
    `stack: ${stackAlloc}`,
    `references: ${stackAlloc}`,
    `locals: [${locals}]`,
    "thisValue: $this",
    "currentFunction: $compiled",
    "callerFrame: $r.currentFrame",
    "callArgs: $args",
  ];
  if (shape.needsEnvironment) frameFields.push("environment: null");
  if (shape.needsDynamicBindings) frameFields.push("dynamicBindings: Object.create(null)");
  if (shape.hasLineRefs) frameFields.push("line: 0", "column: 0");
  lines.push(`    const $f = { ${frameFields.join(", ")} };`);
  if (shape.needsEnvironment) {
    lines.push(`    $f.environment = { kind: "frame", frame: $f, outer: $environment };`);
  }
  lines.push(
    "    $r.currentFrame = $f;",
    "    try {",
    "      const $result = $execute($r, $f);",
    "      if ($constructing && ($result === null || (typeof $result !== \"object\" && typeof $result !== \"function\"))) return $this;",
    "      return $result;",
    "    } finally {",
    "      $r.currentFrame = $f.callerFrame;",
    "    }",
    "  };",
    "  return $initializeCompiled($r, $compiled, $metadata);",
    "}"
  );
  return lines.join("\n");
}

const RUNTIME_IMPORTS = Object.freeze([
  ["applySandboxValue", "$applySandbox"],
  ["applyValue", "$apply"],
  ["constructSandboxValue", "$constructSandbox"],
  ["constructValue", "$construct"],
  ["createProgram", "$createProgram"],
  ["deleteGlobalVariableValue", "$deleteGlobal"],
  ["deleteVariableValue", "$deleteVar"],
  ["getArgumentsValue", "$getArguments"],
  ["getSandboxPropertyValue", "$getSandbox"],
  ["initializeCompiledFunction", "$initializeCompiled"],
  ["instanceOfTarget", "$instanceOfTarget"],
  ["invokeCompiledFunction", "$invokeCompiled"],
  ["readGlobalVariableValue", "$readGlobal"],
  ["readVariableValue", "$readVar"],
  ["setArgumentsValue", "$setArguments"],
  ["setSandboxPropertyValue", "$setSandbox"],
  ["writeGlobalVariableValue", "$writeGlobal"],
  ["writeSloppyPropertyValue", "$writeSloppy"],
  ["writeStrictPropertyValue", "$writeStrict"],
  ["writeVariableValue", "$writeVar"],
]);

function generate(program, options = {}) {
  if (options.format && options.format !== "cjs") {
    throw new Error("The initial AOT backend currently emits CommonJS; ESM is scheduled for M5");
  }
  const runtimeModule = options.runtimeModule || "sablejs/runtime";
  const codegenStats = options.codegenStats || {
    straightScopes: 0,
    structuredScopes: 0,
    fallbackScopes: 0,
    fastFrameScopes: 0,
    leafFrameScopes: 0,
    inlineLeafFrameScopes: 0,
    inlineFastFrameScopes: 0,
    inlining: null,
    sizeOptimization: null,
    identifierProtection: null,
    stackToLocal: {
      enabled: options.optimization === "O2" || options.optimization === "Os",
      instructions: 0,
      helpersAvoided: 0,
      stackLoads: 0,
      stackStores: 0,
      sizeTemporaryAssignments: 0,
      sizeTemporaryReuses: 0,
    },
  };
  codegenStats.sizeOptimization = {
    enabled: options.optimization === "Os",
    temporarySlots: 0,
    helperImports: 0,
    outputBytes: 0,
    decisions: {
      perScopeFactories: options.perScopeFactories !== false,
      smallFunctionInlining: options.optimization === "O2" && options.inlineSmallFunctions !== false,
      globalValueNumbering: options.optimization === "O2",
      loopInvariantCodeMotion: options.optimization === "O2",
    },
  };
  const evalScopeIds = new Set();
  program.scopes.forEach((scope) => scope.instructions.forEach((instruction) => {
    if (instruction.op === "EVAL" && instruction.args[0] && instruction.args[0] !== -1) {
      evalScopeIds.add(instruction.args[0].id);
    }
  }));
  const scopesById = new Map(program.scopes.map((scope) => [scope.id, scope]));
  const inlinePlans = createInlinePlans(program, options, codegenStats);
  const identifierProtection = normalizeIdentifierProtection(options.identifierProtection);
  const identifierAliases = createIdentifierAliases(
    program,
    scopesById,
    identifierProtection,
    codegenStats
  );
  const dynamicChain = new Map();
  const hasDynamicChain = (scope) => {
    if (dynamicChain.has(scope.id)) return dynamicChain.get(scope.id);
    const dynamic = scope.instructions.some((instruction) =>
      DYNAMIC_LOCAL_OPERATIONS.has(instruction.op)
    ) || (scope.parentId != null && hasDynamicChain(scopesById.get(scope.parentId)));
    dynamicChain.set(scope.id, dynamic);
    return dynamic;
  };
  // With/eval environments are pushed at runtime and shadow name resolution
  // for every function nested under them, not just siblings in the with block.
  // Fast frames omit the environment chain, so any scope that could resolve a
  // name through one must stay out of the fast path.
  const withEvalChain = new Map();
  const hasWithEvalAncestor = (scope) => {
    if (withEvalChain.has(scope.id)) return withEvalChain.get(scope.id);
    const dynamic = scope.instructions.some((instruction) =>
      instruction.op === "WITH" || instruction.op === "ENDWITH" || instruction.op === "EVAL"
    ) || (scope.parentId != null && hasWithEvalAncestor(scopesById.get(scope.parentId)));
    withEvalChain.set(scope.id, dynamic);
    return dynamic;
  };
  // A catch environment shadows exactly one name: its parameter. A nested
  // scope that resolves that name at runtime needs the environment chain;
  // scopes that resolve other names (or none) are unaffected by the catch
  // env and keep the fast path.
  const resolveNameOperations = new Set([
    "GETVAR", "SETVAR", "HASVAR", "DELVAR", "REFVAR", "PUTVAR",
  ]);
  const ancestorCatchNames = new Map();
  const collectAncestorCatchNames = (scope) => {
    if (ancestorCatchNames.has(scope.id)) return ancestorCatchNames.get(scope.id);
    const names = new Set();
    if (scope.parentId != null) {
      const parent = scopesById.get(scope.parentId);
      parent.instructions.forEach((instruction) => {
        if (instruction.op === "CATCH" && instruction.args[0] != null) {
          names.add(instruction.args[0]);
        }
      });
      collectAncestorCatchNames(parent).forEach((name) => names.add(name));
    }
    ancestorCatchNames.set(scope.id, names);
    return names;
  };
  const resolvesAncestorCatchName = (scope) => {
    const names = collectAncestorCatchNames(scope);
    if (names.size === 0) return false;
    return scope.instructions.some((instruction) =>
      resolveNameOperations.has(instruction.op) &&
      instruction.args[0] != null &&
      names.has(instruction.args[0])
    );
  };
  const directVariableScopeIds = new Set(program.scopes
    .filter((scope) => !hasDynamicChain(scope))
    .map((scope) => scope.id));
  const entryScope = scopesById.get(program.entry);
  const globalNames = new Set(entryScope && entryScope.script ? entryScope.variables : []);
  const codegenOptions = {
    ...options,
    evalScopeIds,
    directVariableScopeIds,
    globalNames,
    identifierAliases,
    identifierProtection,
    inlinePlans,
    scopesById,
  };
  const generatedScopes = program.scopes.map((scope) => {
    let code = generateScope(scope, codegenOptions, codegenStats);
    // Non-lightweight scopes resolve bindings through findBinding at runtime,
    // which walks environment frames and reads dynamicBindings; their factory
    // frames must carry the full createFrame field set. Script frames always
    // come from createFrame, so scripts stay eligible regardless.
    const fastFrame = ["O2", "Os"].includes(codegenOptions.optimization) &&
      (scope.lightweight || scope.script) &&
      !scope.instructions.some((instruction) => DYNAMIC_LOCAL_OPERATIONS.has(instruction.op)) &&
      !hasWithEvalAncestor(scope) &&
      !resolvesAncestorCatchName(scope) &&
      !/\$r\.(?:call|construct|getLocal|getVar|hasVar|beginWith)|\$r\.evalStatic/.test(code);
    if (fastFrame) codegenStats.fastFrameScopes += 1;
    const stackReferences = code.match(/\$s\b/g) || [];
    const stackless = fastFrame && stackReferences.length === 1 &&
      code.includes("  const $s = $f.stack;\n");
    if (stackless) code = code.replace("  const $s = $f.stack;\n", "");
    const leafFrame = options.leafFrames !== false && stackless && scope.lightweight &&
      !code.includes("$f.environment") &&
      !/\$r\.[A-Za-z_$][\w$]*\(\$f/.test(code);
    if (leafFrame) codegenStats.leafFrameScopes += 1;
    return { scope, code, fastFrame, leafFrame };
  });
  // Frames along the ancestor chain of a dynamic (with/eval/catch) scope are
  // walked by runtime binding lookups, so their environment nodes and
  // dynamicBindings objects must exist. Every other fast frame omits them.
  const dynamicChainAncestorIds = new Set();
  program.scopes.forEach((scope) => {
    if (!scope.instructions.some((instruction) => DYNAMIC_LOCAL_OPERATIONS.has(instruction.op))) return;
    for (let current = scope; current; current = current.parentId == null
      ? null
      : scopesById.get(current.parentId)) {
      dynamicChainAncestorIds.add(current.id);
    }
  });
  const generatedFactories = [];
  if (options.perScopeFactories !== false) {
    generatedScopes.forEach(({ scope, leafFrame, fastFrame, code }) => {
      const inlineLeafFrame = leafFrame && options.inlineLeafFrames !== false;
      const inlineFastFrame = fastFrame && !inlineLeafFrame && options.inlineFastFrames !== false;
      const needsEnvironment = inlineFastFrame && (
        code.includes("$f.environment") ||
        code.includes("$r.tryCheckpoint") ||
        dynamicChainAncestorIds.has(scope.id)
      );
      const factory = generateFactory(scope, inlineLeafFrame, codegenOptions.security, inlineFastFrame, {
        needsEnvironment,
        needsDynamicBindings: dynamicChainAncestorIds.has(scope.id),
        hasLineRefs: code.includes("$f.line"),
      });
      if (factory && inlineLeafFrame) codegenStats.inlineLeafFrameScopes += 1;
      if (factory && inlineFastFrame) codegenStats.inlineFastFrameScopes += 1;
      if (factory) generatedFactories.push(factory);
    });
  }
  const helperBody = generatedScopes.map(({ code }) => code).concat(generatedFactories).join("\n");
  const imports = RUNTIME_IMPORTS.filter(([, local]) =>
    local === "$createProgram" || helperBody.includes(local)
  );
  codegenStats.sizeOptimization.helperImports = imports.length;
  const lines = [
    '"use strict";',
    `const { ${imports.map(([exported, local]) => `${exported}: ${local}`).join(", ")} } = require(${JSON.stringify(runtimeModule)});`,
  ];
  generatedScopes.forEach(({ scope, fastFrame, leafFrame }) =>
    lines.push(`const $meta${scope.id} = ${JSON.stringify(metadata(
      scope,
      fastFrame,
      identifierAliases.get(scope.id),
      leafFrame
    ))};`)
  );
  generatedScopes.forEach(({ code }) => lines.push(code));
  generatedFactories.forEach((code) => lines.push(code));
  lines.push(
    `const $scopeTable = { ${program.scopes.map((scope) => `${scope.id}: { execute: $exec${scope.id}, metadata: $meta${scope.id}${scope.script || options.perScopeFactories === false ? "" : `, factory: $make${scope.id}`} }`).join(", ")} };`
  );
  lines.push(
    `module.exports = $createProgram($exec${program.entry}, $meta${program.entry}, ${JSON.stringify(ABI_VERSION)}, $scopeTable, ${JSON.stringify({ security: options.security || "sandbox" })});`,
    ""
  );
  return lines.join("\n");
}

module.exports = {
  LOWERING_COVERAGE,
  STATIC_CONTROL_OPS,
  generate,
  jsLiteral,
  normalizeIdentifierProtection,
  validateLoweringCoverage,
};
