"use strict";

// Small platform adapters shared by compiler-only code. The browser build
// intentionally does not ship Node polyfills, so these helpers must stay on
// standard globals with guarded Node fast paths.

function monotonicNow() {
  if (typeof performance !== "undefined" && performance &&
      typeof performance.now === "function") {
    return performance.now();
  }
  if (typeof process !== "undefined" && process && process.hrtime &&
      typeof process.hrtime.bigint === "function") {
    return Number(process.hrtime.bigint()) / 1e6;
  }
  return Date.now();
}

function utf8ByteLength(value) {
  const text = String(value);
  if (typeof Buffer !== "undefined" && Buffer &&
      typeof Buffer.byteLength === "function") {
    return Buffer.byteLength(text);
  }
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }

  // ES2020 browser engines have TextEncoder, but keep a dependency-free
  // fallback for embedded hosts. Lone surrogates encode as U+FFFD, matching
  // TextEncoder and Buffer.byteLength.
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x7f) {
      bytes += 1;
    } else if (unit <= 0x7ff) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length &&
               text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

module.exports = { monotonicNow, utf8ByteLength };
