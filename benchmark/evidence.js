"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repositoryRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(__dirname, "corpus-manifest.json");

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function command(args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function affinity() {
  if (process.platform !== "linux") return null;
  try {
    const status = fs.readFileSync("/proc/self/status", "utf8");
    const match = status.match(/^Cpus_allowed_list:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch (_) {
    return null;
  }
}

function loadManifest() {
  const bytes = fs.readFileSync(manifestPath);
  return {
    path: path.relative(repositoryRoot, manifestPath),
    sha256: sha256(bytes),
    value: JSON.parse(bytes.toString("utf8")),
  };
}

function environment() {
  const status = command(["status", "--porcelain"]);
  return {
    commit: command(["rev-parse", "HEAD"]),
    dirty: status === null ? null : status.length > 0,
    node: process.version,
    v8: process.versions.v8,
    quickjsEmscripten: require("quickjs-emscripten/package.json").version,
    platform: `${process.platform}/${process.arch}`,
    osRelease: os.release(),
    cpu: os.cpus()[0] ? os.cpus()[0].model : "unknown",
    logicalCpuCount: os.cpus().length,
    affinity: affinity(),
  };
}

function writeArtifact(filename, value) {
  const output = path.resolve(filename);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
  return output;
}

module.exports = { environment, loadManifest, manifestPath, repositoryRoot, sha256, writeArtifact };
