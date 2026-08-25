// ES5.1 guest source for the browser example. Runs entirely in-page after
// bundling; reads `input` and returns a plain-data summary.
function summarize(input) {
  var longest = "";
  for (var index = 0; index < input.titles.length; index += 1) {
    if (input.titles[index].length > longest.length) {
      longest = input.titles[index];
    }
  }
  return {
    total: input.titles.length,
    longest: longest,
    stamp: input.stamp,
  };
}
summarize(input);
