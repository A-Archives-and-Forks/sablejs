// Real-world shape: a small recursive-descent parser evaluating arithmetic
// expressions with parentheses.
function workload(input) {
  var source = input.expression;
  var position = 0;

  function peek() { return source.charAt(position); }
  function consume() { return source.charAt(position++); }
  function skipSpaces() {
    while (peek() === " " || peek() === "\t") position += 1;
  }
  function number() {
    var start = position;
    while (peek() >= "0" && peek() <= "9") position += 1;
    return parseFloat(source.slice(start, position));
  }
  function factor() {
    skipSpaces();
    if (peek() === "(") {
      consume();
      var value = expression();
      skipSpaces();
      consume();
      return value;
    }
    return number();
  }
  function term() {
    var value = factor();
    while (true) {
      skipSpaces();
      var op = peek();
      if (op !== "*" && op !== "/") return value;
      consume();
      var right = factor();
      value = op === "*" ? value * right : value / right;
    }
  }
  function expression() {
    var value = term();
    while (true) {
      skipSpaces();
      var op = peek();
      if (op !== "+" && op !== "-") return value;
      consume();
      var right = term();
      value = op === "+" ? value + right : value - right;
    }
  }
  return expression();
}
