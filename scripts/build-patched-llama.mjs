#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertRelocatableRpaths, smokeTestRelocated } from "./lib/runtime-relocation.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "vendor/llama.cpp/runtime.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--") || i + 1 >= argv.length) {
      throw new Error(`Expected --key value, got: ${key}`);
    }
    values.set(key.slice(2), argv[i + 1]);
    i += 1;
  }
  return values;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout}${result.stderr}` : "";
    throw new Error(`${command} ${args.join(" ")} failed${detail}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function platformLabel(platform) {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  throw new Error(`Unsupported build platform: ${platform}`);
}

function architectureLabel(arch) {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  throw new Error(`Unsupported build architecture: ${arch}`);
}

function writeMacToolchain(sourceDir, targetArch, workDir) {
  if (targetArch === "arm64") {
    return path.join(sourceDir, "cmake/arm64-apple-clang.cmake");
  }
  const toolchain = path.join(workDir, "x64-apple-clang.cmake");
  writeFileSync(
    toolchain,
    [
      "set(CMAKE_SYSTEM_NAME Darwin)",
      "set(CMAKE_SYSTEM_PROCESSOR x86_64)",
      "set(CMAKE_C_COMPILER clang)",
      "set(CMAKE_CXX_COMPILER clang++)",
      "set(CMAKE_C_COMPILER_TARGET x86_64-apple-darwin)",
      "set(CMAKE_CXX_COMPILER_TARGET x86_64-apple-darwin)",
      "",
    ].join("\n"),
  );
  return toolchain;
}

function copyRuntimeFiles(buildBin, stageDir, platform) {
  const runtimePattern = platform === "win32"
    ? /^(llama-mtmd-cli\.exe|.+\.dll)$/i
    : /^(llama-mtmd-cli|lib.+\.(?:dylib|so(?:\..+)?))$/;
  let copiedCli = false;
  for (const name of readdirSync(buildBin)) {
    if (!runtimePattern.test(name)) continue;
    const source = path.join(buildBin, name);
    const target = path.join(stageDir, name);
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), target);
    } else if (stat.isFile()) {
      cpSync(source, target);
    }
    copiedCli ||= name === (platform === "win32" ? "llama-mtmd-cli.exe" : "llama-mtmd-cli");
  }
  if (!copiedCli) {
    throw new Error(`llama-mtmd-cli was not found in ${buildBin}`);
  }
}

// CMake links build-tree binaries against an absolute RPATH pointing back at
// the build directory. Staging those files verbatim yields a runtime that only
// works while that build directory still exists -- once the temp build tree is
// cleaned, every transcription dies in dyld with "Library not loaded". Build
// with a loader-relative RPATH instead, so the staged directory resolves its
// own dylibs wherever SayType extracts it.
function relocatableRpathArgs(platform) {
  if (platform === "win32") return []; // Windows resolves DLLs next to the .exe.
  const origin = platform === "darwin" ? "@loader_path" : "$ORIGIN";
  return ["-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON", `-DCMAKE_INSTALL_RPATH=${origin}`];
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

const args = parseArgs(process.argv.slice(2));
const targetPlatform = args.get("platform") || process.platform;
const targetArch = architectureLabel(args.get("arch") || process.arch);
const label = platformLabel(targetPlatform);
const workDir = path.resolve(
  args.get("work-dir") || path.join(os.tmpdir(), `saytype-${manifest.runtimeId}-${label}-${targetArch}`),
);
const outputDir = path.resolve(
  args.get("output-dir") || path.join(repoRoot, "artifacts/local-asr-runtime"),
);
const sourceDir = path.join(workDir, "source");
const buildDir = path.join(workDir, "build");
const stageRoot = path.join(workDir, "stage");
const stageDir = path.join(stageRoot, manifest.runtimeId);
const upstream = process.env.SAYTYPE_LLAMA_UPSTREAM || manifest.upstreamRepository;
const patchPath = path.join(repoRoot, "vendor/llama.cpp", manifest.patches[0]);

rmSync(workDir, { recursive: true, force: true });
mkdirSync(sourceDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });

run("git", ["init", "--quiet"], { cwd: sourceDir });
// GitHub's Windows runners set core.autocrlf=true globally, which would check
// the upstream tree out with CRLF and make the LF patch fail to apply. Pin the
// temp clone to LF instead of relying on the ambient git config.
run("git", ["config", "core.autocrlf", "false"], { cwd: sourceDir });
run("git", ["remote", "add", "origin", upstream], { cwd: sourceDir });
run("git", ["fetch", "--quiet", "--depth", "1", "origin", manifest.upstreamCommit], { cwd: sourceDir });
run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: sourceDir });
const upstreamCommit = run("git", ["rev-parse", "HEAD"], { cwd: sourceDir, capture: true });
if (upstreamCommit !== manifest.upstreamCommit) {
  throw new Error(`Expected ${manifest.upstreamCommit}, got ${upstreamCommit}`);
}
run("git", ["apply", "--check", patchPath], { cwd: sourceDir });
run("git", ["apply", patchPath], { cwd: sourceDir });

const configureArgs = [
  "-S", sourceDir,
  "-B", buildDir,
  "-DCMAKE_BUILD_TYPE=Release",
  "-DLLAMA_BUILD_TESTS=OFF",
  "-DLLAMA_BUILD_SERVER=OFF",
  "-DLLAMA_CURL=OFF",
  // b9960 vendors cpp-httplib and links OpenSSL wherever CMake finds it, which
  // LLAMA_CURL=OFF does not cover — it is a separate HTTP path. Whatever the
  // build machine has then becomes a hard dependency of the archive: the runner
  // supplied libssl-3-x64.dll and libcrypto-3-x64.dll on Windows and homebrew's
  // libssl.3.dylib on macOS, and neither exists on a user's machine. SayType
  // downloads models through its own Rust client, so no HTTPS is wanted here.
  "-DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON",
];
configureArgs.push(...relocatableRpathArgs(targetPlatform));
if (targetPlatform === "darwin") {
  configureArgs.push(`-DCMAKE_TOOLCHAIN_FILE=${writeMacToolchain(sourceDir, targetArch, workDir)}`);
  configureArgs.push("-DGGML_METAL=ON");
}
run("cmake", configureArgs);
run("cmake", ["--build", buildDir, "--config", "Release", "--target", "llama-mtmd-cli", "-j", String(os.cpus().length)]);

mkdirSync(stageDir, { recursive: true });
const buildBinCandidates = [path.join(buildDir, "bin", "Release"), path.join(buildDir, "bin")];
const buildBin = buildBinCandidates.find((candidate) => existsSync(candidate));
if (!buildBin) throw new Error(`Build output directory is missing under ${buildDir}`);
copyRuntimeFiles(buildBin, stageDir, targetPlatform);
cpSync(path.join(sourceDir, "LICENSE"), path.join(stageDir, "LICENSE"));
assertRelocatableRpaths(stageDir, targetPlatform);
const canRunTarget = targetPlatform === process.platform
  && targetArch === architectureLabel(process.arch);
const smokeTest = canRunTarget
  ? smokeTestRelocated({
      stageDir,
      probeDir: path.join(workDir, "relocated"),
      platform: targetPlatform,
    })
  : "skipped (cross-build)";

const extension = targetPlatform === "win32" ? "zip" : "tar.gz";
const archiveName = `llama-${manifest.runtimeId}-bin-${label}-${targetArch}.${extension}`;
const archivePath = path.join(outputDir, archiveName);
rmSync(archivePath, { force: true });
if (targetPlatform === "win32") {
  run("cmake", ["-E", "tar", "cf", archivePath, "--format=zip", manifest.runtimeId], { cwd: stageRoot });
} else {
  run("cmake", ["-E", "tar", "czf", archivePath, "--format=gnutar", manifest.runtimeId], { cwd: stageRoot });
}

const metadata = {
  runtimeId: manifest.runtimeId,
  resetContract: manifest.resetContract,
  upstreamCommit,
  platform: label,
  arch: targetArch,
  archive: archiveName,
  relocatedSmokeTest: smokeTest,
  size: lstatSync(archivePath).size,
  sha256: sha256(archivePath),
};
writeFileSync(`${archivePath}.json`, `${JSON.stringify(metadata, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
