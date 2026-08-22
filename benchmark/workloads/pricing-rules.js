// Real-world shape: a pricing rule table evaluated over thousands of SKUs.
function workload(input) {
  var rules = input.rules;
  var items = input.items;
  var result = 0;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var price = item.base;
    for (var r = 0; r < rules.length; r++) {
      var rule = rules[r];
      if (rule.category && rule.category !== item.category) continue;
      if (rule.minBase && price < rule.minBase) continue;
      if (rule.maxBase && price > rule.maxBase) continue;
      price = rule.percent ? price * (1 - rule.percent / 100) : price - rule.flat;
    }
    result += price * item.qty;
  }
  return result;
}
