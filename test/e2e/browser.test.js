"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const bundlePath = path.resolve(__dirname, "../../.cache/e2e/program.js");
const bundle = fs.readFileSync(bundlePath, "utf8");
const expected = { total: 76, finalValue: 13, label: "portable" };

test("runs the compiled program on the browser main thread", async ({ page }) => {
  await page.addScriptTag({ content: bundle });
  await expect.poll(() => page.evaluate(() => globalThis.__sablejs_e2e_result__)).toEqual(expected);
});

test("runs the compiled program inside a Web Worker", async ({ page }) => {
  const result = await page.evaluate((source) => new Promise((resolve, reject) => {
    const workerSource = `${source}\npostMessage(globalThis.__sablejs_e2e_result__);`;
    const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    const worker = new Worker(url);
    worker.onmessage = (event) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(new Error(event.message));
    };
  }), bundle);

  expect(result).toEqual(expected);
});
