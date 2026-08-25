// Deno consumer of a precompiled sablejs artifact.
//
//   node examples/deno/build.mjs    (once, build time)
//   deno run examples/deno/main.ts  (runtime — no compiler involved)

// The bundle converts the CJS entry into a default export whose shape is the
// entry's `module.exports` ({ run }).
import programModule from "./dist/program.mjs";

const receipt = programModule.run({
  vip: true,
  items: [
    { price: 10, count: 2 },
    { price: 5, count: 4 },
  ],
});

console.log("deno guest returned:", JSON.stringify(receipt));
