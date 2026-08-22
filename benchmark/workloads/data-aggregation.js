// Real-world shape: sort/filter/group aggregation over event records.
function workload(input) {
  var events = input.events.slice();
  events.sort(function (left, right) {
    return left.at - right.at || (left.kind < right.kind ? -1 : 1);
  });
  var groups = {};
  var filtered = 0;
  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    if (event.at < input.from || event.at > input.to) continue;
    filtered += 1;
    var bucket = groups[event.kind];
    if (!bucket) {
      bucket = { count: 0, sum: 0, max: event.at, min: event.at };
      groups[event.kind] = bucket;
    }
    bucket.count += 1;
    bucket.sum += event.value;
    if (event.at > bucket.max) bucket.max = event.at;
    if (event.at < bucket.min) bucket.min = event.at;
  }
  var kinds = [];
  for (var kind in groups) {
    if (groups[kind]) kinds.push({ kind: kind, count: groups[kind].count, avg: groups[kind].sum / groups[kind].count });
  }
  kinds.sort(function (left, right) { return right.count - left.count; });
  return { filtered: filtered, top: kinds.slice(0, 10) };
}
