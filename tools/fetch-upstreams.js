"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const upstreams = require("./upstreams");

const repositoryRoot = path.resolve(__dirname, "..");
const cacheRoot = path.join(repositoryRoot, ".cache");
const requested = process.argv.slice(2);
const names = requested.length ? requested : Object.keys(upstreams);

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

fs.mkdirSync(cacheRoot, { recursive: true });

for (const name of names) {
  const upstream = upstreams[name];
  if (!upstream) throw new Error(`Unknown upstream ${name}`);
  const target = path.join(cacheRoot, upstream.directory);
  if (!fs.existsSync(path.join(target, ".git"))) {
    fs.mkdirSync(target, { recursive: true });
    git(["init"], target);
    git(["remote", "add", "origin", upstream.url], target);
  }
  git(["fetch", "--depth=1", "origin", upstream.commit], target);
  git(["checkout", "--detach", "--force", "FETCH_HEAD"], target);
  const actual = git(["rev-parse", "HEAD"], target);
  if (actual !== upstream.commit) {
    throw new Error(`${name} revision mismatch: expected=${upstream.commit}, actual=${actual}`);
  }
  console.log(`${name}: ${actual} (${path.relative(repositoryRoot, target)})`);
}
