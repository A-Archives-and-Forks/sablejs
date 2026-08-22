// Real-world shape: reshape a nested analytics payload into a flat report,
// the kind of transform AI-generated data code is asked to write.
function workload(input) {
  var rows = input.rows;
  var out = [];
  var totals = { revenue: 0, count: 0 };
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var amount = row.amount * (1 - row.discount);
    totals.revenue += amount;
    totals.count += 1;
    out.push({
      id: row.id,
      customer: row.customer.name,
      region: row.customer.region,
      amount: amount,
      tags: row.tags ? row.tags.join("|") : ""
    });
  }
  return { rows: out, totals: totals };
}
