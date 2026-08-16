import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => {
  try {
    return readFileSync(path.join(repoRoot, relativePath), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
};

const manifestText = read("vendor/llama.cpp/runtime.json");
const manifest = manifestText ? JSON.parse(manifestText) : {};
const sourcePatch = read("vendor/llama.cpp/patches/0001-reset-per-audio-state.patch");
const buildScript = read("scripts/build-patched-llama.mjs");
const localAsr = read("src-tauri/src/local_asr.rs");

test("patched llama runtime is pinned to the reproduced upstream source", () => {
  assert.equal(manifest.upstreamRef, "b9960");
  assert.equal(manifest.upstreamCommit, "a935fbffe1a3d31509c325c116454ab5d56b2eb8");
  assert.equal(manifest.runtimeId, "b9960-saytype-reset-v1");
  assert.equal(manifest.resetContract, "saytype-session-reset-v1");
});

test("source patch makes media batches request-local and fully clears a session", () => {
  assert.match(sourcePatch, /^-\s+mtmd::batch_ptr mbatch;$/m);
  assert.match(sourcePatch, /^\+\s+mtmd::batch_ptr mbatch;$/m);
  assert.match(sourcePatch, /ctx\.bitmaps\.entries\.clear\(\)/);
  assert.match(sourcePatch, /ctx\.videos\.clear\(\)/);
  assert.match(sourcePatch, /common_sampler_reset\(ctx\.smpl\)/);
  assert.match(sourcePatch, /content\.clear\(\)/);
  assert.match(sourcePatch, /saytype-session-reset-v1/);
});

test("build script verifies the exact source before applying the maintained patch", () => {
  assert.match(buildScript, /upstreamCommit/);
  assert.match(buildScript, /rev-parse/);
  assert.match(buildScript, /git[\s\S]*apply[\s\S]*--check/);
  assert.match(buildScript, /manifest\.patches\[0\]/);
});

test("SayType only keeps a resident worker when the patched runtime is selected", () => {
  assert.match(localAsr, /LLAMA_BUILD:\s*&str\s*=\s*"b9960-saytype-reset-v1"/);
  assert.match(localAsr, /const RESIDENT_RUNTIME_SAFE:\s*bool\s*=\s*true/);
  assert.match(localAsr, /if !RESIDENT_RUNTIME_SAFE/);
  assert.match(localAsr, /include_bytes!\([^)]*llama-b9960-saytype-reset-v1-bin-macos-arm64\.tar\.gz/);
});
