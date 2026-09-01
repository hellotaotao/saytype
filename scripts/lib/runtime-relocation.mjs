// Guards that keep a staged llama.cpp runtime self-contained.
//
// CMake links build-tree binaries against an absolute RPATH pointing back at
// the build directory. A runtime staged verbatim therefore works only while
// that directory survives: the first b9960-saytype-reset-v1 archive shipped
// that way, ran off /private/tmp/saytype-llama-maintained-build for weeks, and
// broke every local transcription once macOS cleaned that path.
//
// The second way a runtime stops being self-contained is a library the build
// machine happened to have. b9960 vendors cpp-httplib, which links OpenSSL
// wherever CMake finds it, so the archive picked up libssl/libcrypto from the
// runner. It launched fine on every machine that had them — the CI runner, and
// a Windows shell with Git's mingw64\bin on PATH — and died with a missing-DLL
// dialog for users. Hence launchEnvironment below: the probe runs with the
// ambient library search paths stripped, so "it runs here" stops being the
// thing being measured.

import { cpSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
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

// Strip everything that could let the probe borrow a library from the build
// machine. Windows resolves DLLs from the executable's own directory first and
// then PATH, so PATH drops to the system directories; the Unix loaders take
// their extra search paths from the environment, so those variables go.
function launchEnvironment(platform) {
  if (platform === "win32") {
    const root = process.env.SystemRoot || "C:\\Windows";
    return {
      SystemRoot: root,
      windir: root,
      TEMP: process.env.TEMP ?? process.env.RUNNER_TEMP ?? `${root}\\Temp`,
      TMP: process.env.TMP ?? process.env.RUNNER_TEMP ?? `${root}\\Temp`,
      PATH: `${root}\\system32;${root}`,
    };
  }
  const env = { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };
  if (platform === "darwin") env.DYLD_PRINT_LIBRARIES = "1";
  return env;
}

// Copy the staged runtime somewhere unrelated and launch it there with the
// ambient library search paths removed, asserting on where dyld actually
// loaded from: every llama/ggml/mtmd image must come out of the copy.
// Launching alone proves nothing at build time.
export function smokeTestRelocated({ stageDir, probeDir, platform }) {
  rmSync(probeDir, { recursive: true, force: true });
  cpSync(stageDir, probeDir, { recursive: true, verbatimSymlinks: true });
  const cli = path.join(probeDir, platform === "win32" ? "llama-mtmd-cli.exe" : "llama-mtmd-cli");
  const probe = spawnSync(cli, ["--version"], {
    encoding: "utf8",
    env: launchEnvironment(platform),
  });
  if (probe.status !== 0) {
    throw new Error(
      "relocated llama-mtmd-cli failed to launch with a stripped environment — " +
      `it depends on something outside the archive:\n${probe.stdout}${probe.stderr}`,
    );
  }
  if (platform === "darwin") {
    // dyld reports realpaths, so compare against one: probeDir usually sits
    // under /var/folders, which is a symlink to /private/var/folders, and every
    // library would otherwise look like it came from outside the copy.
    const probeRoot = realpathSync(probeDir);
    const loaded = [...probe.stderr.matchAll(/^dyld\[\d+\]: <[^>]*> (.+)$/gm)].map((match) => match[1]);
    const runtimeLibs = loaded.filter((lib) => RUNTIME_LIB.test(path.basename(lib)));
    if (runtimeLibs.length === 0) {
      throw new Error("dyld reported no runtime libraries; cannot verify relocation");
    }
    const strays = runtimeLibs.filter((lib) => !realpathSync(lib).startsWith(`${probeRoot}${path.sep}`));
    if (strays.length > 0) {
      throw new Error(`relocated runtime loaded libraries from outside itself:\n${strays.join("\n")}`);
    }
  }
  rmSync(probeDir, { recursive: true, force: true });
  return "ok";
}
