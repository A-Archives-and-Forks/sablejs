"use strict";

const runtime = require("./runtime");

module.exports = {
  ...require("./compiler"),
  capability: runtime.capability,
  runtime,
  worker: require("./worker"),
};
