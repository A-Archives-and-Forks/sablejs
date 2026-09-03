"use strict";

// Compatibility import for existing IR/codegen consumers. The contract lives
// outside either frontend or IR so neither table can drift independently.
module.exports = require("../operation-spec");
