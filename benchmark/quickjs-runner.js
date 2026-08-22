"use strict";

const { getQuickJS } = require("quickjs-emscripten");

// Shared QuickJS-WASM evaluation context for the comparison backends. The
// print callback mirrors the sablejs capability surface so both backends
// observe the same harness output.
async function createQuickJSRunner(emit) {
  const QuickJS = await getQuickJS();
  const context = QuickJS.newContext();
  const print = context.newFunction("print", (value) => {
    emit(String(context.dump(value)));
  });
  const gc = context.newFunction("gc", () => {});
  context.setProp(context.global, "print", print);
  context.setProp(context.global, "gc", gc);
  print.dispose();
  gc.dispose();
  return {
    evaluate(source, filename = "benchmark.js") {
      const result = context.evalCode(source, filename);
      if (result.error) {
        const error = context.dump(result.error);
        result.error.dispose();
        throw new Error(`QuickJS evaluation failed: ${JSON.stringify(error)}`);
      }
      // Dump (copy out of the WASM heap) before disposing the handle; the
      // caller gets the completion value, not a discarded handle.
      const value = context.dump(result.value);
      result.value.dispose();
      return value;
    },
    dispose() {
      context.dispose();
    },
  };
}

module.exports = { createQuickJSRunner };
