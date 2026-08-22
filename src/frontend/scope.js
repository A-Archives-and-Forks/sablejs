"use strict";

class Scope {
  constructor() {
    return {
      name: "",
      script: false,
      strict: false,
      lightweight: true,
      arguments: false,
      numparams: 0,
      ps: [], // params
      vt: [], // vartab
      ft: [], // funtab
      st: [], // strtab
      nt: [], // numtab
      et: [], // evaltab
      dft: [], // dfuntab
      opcode: [],
    };
  }
}

module.exports = Scope;
