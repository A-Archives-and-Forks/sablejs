// Deliberately no "use strict": ES5 sloppy property assignment must ignore a
// failed write, while still using the host object's native [[Set]] behavior.
function writePropertyValue(object, key, value) {
  object[key] = value;
  return value;
}

function captureArgumentsObject() {
  return arguments;
}

module.exports = { captureArgumentsObject, writePropertyValue };
