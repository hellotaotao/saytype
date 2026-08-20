// Guards that keep a staged llama.cpp runtime self-contained.
//
// CMake links build-tree binaries against an absolute RPATH pointing back at
// the build directory. A runtime staged verbatim therefore works only while
// that directory survives: the first b9960-saytype-reset-v1 archive shipped
// that way, ran off /private/tmp/saytype-llama-maintained-build for weeks, and
// broke every local transcription once macOS cleaned that path.

import { cpSync, lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const RUNTIME_LIB = /^lib(llama|ggml|mtmd)/;

function machOFiles(stageDir, platform) {
  const pattern = platform === "win32"
    ? /^(llama-mtmd-cli\.exe|.+\.dll)$/i
    : /^(llama-mtmd-cli|lib.+\.(?:dylib|so(?:\..+)?))$/;
  return readdirSync(stageDir)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(stageDir, name))
    .filter((file) => lstatSync(file).isFile());
}

// Reject any Mach-O that still carries a machine-specific rpath. This is the
// check that catches the build-tree rpath, because the launch check below
// cannot: while the build directory exists, an absolute rpath resolves from
// anywhere.
export function assertRelocatableRpaths(stageDir, platform) {
  if (platform !== "darwin") return;
  for (const file of machOFiles(stageDir, platform)) {
    const load = spawnSync("otool", ["-l", file], { encoding: "utf8" });
    if (load.status !== 0) {
      throw new Error(`otool -l ${file} failed: ${load.stderr}`);
    }
    const absolute = [...load.stdout.matchAll(/^\s*path (.+) \(offset \d+\)$/gm)]
      .map((match) => match[1])
      .filter((rpath) => !rpath.startsWith("@"));
    if (absolute.length > 0) {
      throw new Error(`${path.basename(file)} keeps a machine-specific rpath: ${absolute.join(", ")}`);
    }
  }
}

// Copy the staged runtime somewhere unrelated and launch it there, asserting
// on where dyld actually loaded from: every llama/ggml/mtmd image must come
// out of the copy. Launching alone proves nothing at build time.
export function smokeTestRelocated({ stageDir, probeDir, platform }) {
  rmSync(probeDir, { recursive: true, force: true });
  cpSync(stageDir, probeDir, { recursive: true, verbatimSymlinks: true });
  const cli = path.join(probeDir, platform === "win32" ? "llama-mtmd-cli.exe" : "llama-mtmd-cli");
  const probe = spawnSync(cli, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, DYLD_PRINT_LIBRARIES: "1" },
  });
  if (probe.status !== 0) {
    throw new Error(`relocated llama-mtmd-cli failed to launch:\n${probe.stdout}${probe.stderr}`);
  }
  if (platform === "darwin") {
    const loaded = [...probe.stderr.matchAll(/^dyld\[\d+\]: <[^>]*> (.+)$/gm)].map((match) => match[1]);
    const runtimeLibs = loaded.filter((lib) => RUNTIME_LIB.test(path.basename(lib)));
    if (runtimeLibs.length === 0) {
      throw new Error("dyld reported no runtime libraries; cannot verify relocation");
    }
    const strays = runtimeLibs.filter((lib) => !lib.startsWith(`${probeDir}${path.sep}`));
    if (strays.length > 0) {
      throw new Error(`relocated runtime loaded libraries from outside itself:\n${strays.join("\n")}`);
    }
  }
  rmSync(probeDir, { recursive: true, force: true });
  return "ok";
}
