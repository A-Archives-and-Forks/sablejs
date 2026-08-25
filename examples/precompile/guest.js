// ES5.1 guest source shared by the precompile and caching examples.
// A script with no imports that returns its result as the final expression.
function total(input) {
  var discount = input.vip ? 0.8 : 1;
  var line = 0;
  for (var index = 0; index < input.items.length; index += 1) {
    line += input.items[index].price * input.items[index].count * discount;
  }
  return { line: line, ship: input.items.length > 2 ? 0 : 10 };
}
total(input);
