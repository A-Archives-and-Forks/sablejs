// Real-world shape: ordered condition-action workflow rules over a record.
function workload(input) {
  var record = input.record;
  var rules = input.rules;
  var actions = [];
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    var matched = true;
    for (var c = 0; c < rule.conditions.length; c++) {
      var condition = rule.conditions[c];
      var value = record[condition.field];
      switch (condition.op) {
        case "eq": matched = value === condition.value; break;
        case "gt": matched = value > condition.value; break;
        case "lt": matched = value < condition.value; break;
        case "contains": matched = String(value).indexOf(condition.value) >= 0; break;
        default: matched = false;
      }
      if (!matched) break;
    }
    if (matched) {
      for (var a = 0; a < rule.actions.length; a++) {
        var action = rule.actions[a];
        if (action.set) record[action.set] = action.to;
        else actions.push(action.tag);
      }
    }
  }
  return { record: record, actions: actions };
}
