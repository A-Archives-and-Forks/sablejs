// Real-world shape: template rendering with conditionals and loops.
function workload(input) {
  var template = input.template;
  var data = input.data;
  var output = "";
  var i = 0;
  while (i < template.length) {
    var ch = template.charAt(i);
    if (ch === "{") {
      var end = template.indexOf("}", i);
      var token = template.slice(i + 1, end < 0 ? template.length : end);
      if (token.indexOf("if ") === 0) {
        var name = token.slice(3);
        if (!data[name]) {
          var depth = 1;
          i = end + 1;
          while (i < template.length && depth > 0) {
            if (template.charAt(i) === "{" && template.slice(i, i + 4) === "{/if") depth += 1;
            if (template.charAt(i) === "{" && template.slice(i, i + 5) === "{end}") depth -= 1;
            i += 1;
          }
          continue;
        }
      } else if (token.indexOf("each ") === 0) {
        var list = data[token.slice(5)] || [];
        var bodyEnd = template.indexOf("{end}", end);
        var body = bodyEnd < 0 ? "" : template.slice(end + 1, bodyEnd);
        for (var e = 0; e < list.length; e++) {
          output += body.replace(/{item}/g, String(list[e]));
        }
        i = bodyEnd + 5;
        continue;
      } else {
        output += data[token] === undefined ? "" : String(data[token]);
      }
    } else {
      output += ch;
    }
    i += 1;
  }
  return output;
}
