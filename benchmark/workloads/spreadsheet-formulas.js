// Real-world shape: evaluating dependency-ordered spreadsheet formulas.
function workload(input) {
  var cells = {};
  var names = input.names;
  var formulas = input.formulas;
  for (var i = 0; i < names.length; i++) cells[names[i]] = input.values[i];
  for (var pass = 0; pass < 5; pass++) {
    var changed = 0;
    for (var f = 0; f < formulas.length; f++) {
      var formula = formulas[f];
      var left = cells[formula.a];
      var right = cells[formula.b];
      if (left === undefined || right === undefined) continue;
      var value;
      switch (formula.op) {
        case "add": value = left + right; break;
        case "mul": value = left * right; break;
        case "sub": value = left - right; break;
        default: value = left;
      }
      if (value !== cells[formula.target]) {
        cells[formula.target] = value;
        changed += 1;
      }
    }
    if (!changed) break;
  }
  return cells;
}
