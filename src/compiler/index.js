"use strict";

const fs = require("fs");
const path = require("path");
const FrontendCompiler = require("../frontend/compiler");
const decodeProgram = require("../ir/decode");
const { verifyProgram } = require("../ir/verify");
const { lowerToMIR: lowerProgramToMIR, verifyMIR } = require("../ir/mir");
const { optimizeProgram, normalizeLevel } = require("../backend/optimizer");
const { generate, normalizeIdentifierProtection } = require("../codegen");
const { printProgram, printMIR } = require("../ir/print");
const { ABI_VERSION } = require("../runtime");

function normalizeSecurity(value) {
  if (value === undefined || value === "sandbox") return "sandbox";
  if (value === "trusted") return "trusted";
  throw new Error(`Unknown sablejs security mode ${value}`);
}

class AOTCompiler {
  lowerToHIR(source, options = {}) {
    const frontendScope = new FrontendCompiler({
      structuredMetadata: true,
    }).compile(source, !!options.strict);
    const hir = decodeProgram(frontendScope);
    verifyProgram(hir);
    return hir;
  }

  compile(source, options = {}) {
    const optimization = normalizeLevel(options.optimization == null ? options.optimize : options.optimization);
    const security = normalizeSecurity(options.security);
    const identifierProtection = normalizeIdentifierProtection(options.identifierProtection);
    const hir = this.lowerToHIR(source, options);
    const stats = optimizeProgram(hir, optimization, options);
    verifyProgram(hir);
    let mir;
    if (options.includeMIR || options.dumpIR === "mir" || options.dumpIR === "all") {
      mir = lowerProgramToMIR(hir);
      verifyMIR(mir);
    }
    const createCodegenStats = () => ({
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
        enabled: optimization === "O2" || optimization === "Os",
        instructions: 0,
        helpersAvoided: 0,
        stackLoads: 0,
        stackStores: 0,
        sizeTemporaryAssignments: 0,
        sizeTemporaryReuses: 0,
      },
    });
    const requestedFactories = options.perScopeFactories;
    const factoryCandidates = optimization === "Os" && requestedFactories === undefined
      ? [false, true]
      : [requestedFactories === undefined ? optimization !== "Os" : requestedFactories];
    const candidates = factoryCandidates.map((perScopeFactories) => {
      const codegenStats = createCodegenStats();
      const code = generate(hir, {
        ...options,
        optimization,
        security,
        perScopeFactories,
        codegenStats,
      });
      return {
        code,
        codegenStats,
        perScopeFactories,
        bytes: Buffer.byteLength(code),
      };
    });
    candidates.sort((left, right) => left.bytes - right.bytes ||
      Number(left.perScopeFactories) - Number(right.perScopeFactories));
    const selected = candidates[0];
    const { code, codegenStats, perScopeFactories } = selected;
    codegenStats.sizeOptimization.costModel = {
      objective: "raw-bytes",
      selected: perScopeFactories ? "per-scope-factories" : "shared-factory",
      candidates: candidates.map((candidate) => ({
        strategy: candidate.perScopeFactories ? "per-scope-factories" : "shared-factory",
        bytes: candidate.bytes,
      })),
      zeroGrowthInlining: optimization === "Os",
      temporaryReuse: optimization === "Os",
      helperImportPruning: true,
    };
    stats.codegen = codegenStats;
    stats.codegen.sizeOptimization.outputBytes = Buffer.byteLength(code);
    if (options.dumpDir) {
      // Inspection mode: write the optimized HIR, the MIR the backend passes
      // reason about, and the generated code as text files. Independent of
      // dumpIR/includeHIR, which attach the graph objects to the result — the
      // returned object is unchanged by dumpDir.
      const dumpMIR = mir || lowerProgramToMIR(hir);
      verifyMIR(dumpMIR);
      fs.mkdirSync(options.dumpDir, { recursive: true });
      fs.writeFileSync(path.join(options.dumpDir, "hir.txt"), printProgram(hir));
      fs.writeFileSync(path.join(options.dumpDir, "mir.txt"), printMIR(dumpMIR));
      fs.writeFileSync(path.join(options.dumpDir, "code.js"), code);
    }
    return {
      code,
      format: options.format || "cjs",
      optimization,
      stats,
      hir: options.dumpIR === "hir" || options.dumpIR === "all" || options.includeHIR ? hir : undefined,
      mir,
      metadata: {
        abiVersion: ABI_VERSION,
        format: options.format || "cjs",
        inputLanguage: "es5.1",
        identifierProtection,
        optimize: optimization,
        perScopeFactories,
        security,
      },
    };
  }

  lowerToMIR(source, options = {}) {
    const hir = this.lowerToHIR(source, options);
    const mir = lowerProgramToMIR(hir);
    verifyMIR(mir);
    return mir;
  }
}

function compile(source, options) {
  return new AOTCompiler().compile(source, options);
}

function lowerToHIR(source, options) {
  return new AOTCompiler().lowerToHIR(source, options);
}

function lowerToMIR(source, options) {
  return new AOTCompiler().lowerToMIR(source, options);
}

module.exports = { AOTCompiler, compile, lowerToHIR, lowerToMIR, normalizeSecurity };
