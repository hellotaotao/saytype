import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const relocationGuards = read("scripts/lib/runtime-relocation.mjs");
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

const BUNDLED_RUNTIMES = [
  "llama-b9960-saytype-reset-v1-bin-macos-arm64.tar.gz",
  "llama-b9960-saytype-reset-v1-bin-windows-x64.zip",
];
// Only `.` is a regex metacharacter in these archive names, and `[.]` keeps the
// escape free of backslashes so the template literals below stay readable.
const escapeRegExp = (value) => value.replaceAll(".", "[.]");

/// Collect the platform tuples in the `#[cfg(...)]` that guards a declaration.
const platformsGuarding = (declaration) => {
  const index = localAsr.indexOf(declaration);
  assert.ok(index > 0, `${declaration} not found in local_asr.rs`);
  const attribute = localAsr.slice(Math.max(0, index - 400), index);
  const start = attribute.lastIndexOf("#[cfg(");
  assert.ok(start >= 0, `no #[cfg] guards ${declaration}`);
  return [
    ...attribute.slice(start).matchAll(/all\(target_os = "(\w+)", target_arch = "(\w+)"\)/g),
  ]
    .map((match) => `${match[1]}-${match[2]}`)
    .sort();
};

test("SayType only keeps a resident worker when the patched runtime is selected", () => {
  assert.match(localAsr, /LLAMA_BUILD:\s*&str\s*=\s*"b9960-saytype-reset-v1"/);
  assert.match(localAsr, /const RESIDENT_RUNTIME_SAFE:\s*bool\s*=\s*true/);
  assert.match(localAsr, /if !RESIDENT_RUNTIME_SAFE/);
  for (const archive of BUNDLED_RUNTIMES) {
    assert.match(localAsr, new RegExp(`include_bytes![(][^)]*${escapeRegExp(archive)}`));
  }
});

test("the resident-safe set never drifts from the patched-runtime set", () => {
  // Marking a platform resident-safe while it still points at upstream b9960 is
  // exactly the bug the patch exists to prevent — on Windows the unpatched
  // worker died on the third alternating clip — so a platform must never appear
  // in one list without the other.
  const patched = platformsGuarding('pub const LLAMA_BUILD: &str = "b9960-saytype-reset-v1";');
  const residentSafe = platformsGuarding("const RESIDENT_RUNTIME_SAFE: bool = true;");
  assert.deepEqual(residentSafe, patched);
  assert.deepEqual(patched, ["macos-aarch64", "windows-x86_64"]);
});

test("build script stages a runtime that resolves its own libraries", () => {
  assert.match(buildScript, /CMAKE_BUILD_WITH_INSTALL_RPATH=ON/);
  assert.match(buildScript, /@loader_path/);
  assert.match(buildScript, /assertRelocatableRpaths\(stageDir, targetPlatform\)/);
  assert.match(buildScript, /smokeTestRelocated\(\{/);
  assert.match(relocationGuards, /keeps a machine-specific rpath/);
  // Launching the staged copy is not enough on its own: an absolute build-tree
  // rpath still resolves while the build directory exists, so the guard has to
  // check where dyld actually loaded from.
  assert.match(relocationGuards, /DYLD_PRINT_LIBRARIES/);
  assert.match(relocationGuards, /loaded libraries from outside itself/);
});

test("the bundled runtime manifests match the committed archives", () => {
  for (const name of BUNDLED_RUNTIMES) {
    const archive = readFileSync(path.join(repoRoot, "src-tauri/resources/local-asr", name));
    const declared = localAsr.match(
      new RegExp(
        `rel_path: "${escapeRegExp(name)}"[^]*?size: ([0-9_]+),[^]*?sha256: "([0-9a-f]{64})"`,
      ),
    );
    assert.ok(declared, `manifest entry for ${name} not found in local_asr.rs`);
    assert.equal(Number(declared[1].replaceAll("_", "")), archive.length);
    assert.equal(declared[2], createHash("sha256").update(archive).digest("hex"));
  }
});
