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
// ambient library search paths stripped.
//
// That probe still cannot see everything on Windows, because the loader always
// searches the system directory no matter what PATH says. A redistributable
// sitting in System32 — VCOMP140.DLL, say — resolves on the build machine and
// is missing on a user's. assertSelfContainedImports reads the import table
// instead, which is the only place that dependency is stated outright.

import { cpSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const RUNTIME_LIB = /^lib(llama|ggml|mtmd)/;

// Shipped with Windows itself. Anything outside this and the archive is a
// redistributable the user may not have.
const WINDOWS_SYSTEM_DLL = /^(api-ms-win-|ext-ms-win-)/i;
const WINDOWS_SYSTEM_EXACT = new Set([
  "kernel32.dll", "kernelbase.dll", "ntdll.dll", "user32.dll", "gdi32.dll",
  "advapi32.dll", "shell32.dll", "shlwapi.dll", "ole32.dll", "oleaut32.dll",
  "combase.dll", "rpcrt4.dll", "sechost.dll", "ws2_32.dll", "mswsock.dll",
  "crypt32.dll", "bcrypt.dll", "bcryptprimitives.dll", "secur32.dll",
  "psapi.dll", "version.dll", "winmm.dll", "powrprof.dll", "userenv.dll",
  "iphlpapi.dll", "dbghelp.dll", "setupapi.dll", "cfgmgr32.dll", "imm32.dll",
  "comdlg32.dll", "dnsapi.dll", "normaliz.dll", "wldap32.dll", "msvcrt.dll",
]);

// Deliberate, documented exposure rather than an oversight: these are the VC++
// redistributable, which the upstream b9960 pack SayType shipped for months
// also imports, so requiring them is not a regression. Adding to this set means
// accepting that users without that redistributable cannot run local ASR —
// prefer building the dependency away, as GGML_OPENMP=OFF does for VCOMP140.
const ACCEPTED_REDISTRIBUTABLE = new Set([
  "msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll",
]);

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

// Walk a PE image's import directory. A string search over the file cannot
// distinguish an import from an incidental literal, and this is the list the
// loader must satisfy before the image starts.
function peImports(file) {
  const b = readFileSync(file);
  const pe = b.readUInt32LE(0x3c);
  if (!(b[pe] === 0x50 && b[pe + 1] === 0x45 && b[pe + 2] === 0 && b[pe + 3] === 0)) {
    throw new Error(`${path.basename(file)} is not a PE image`);
  }
  const coff = pe + 4;
  const sectionCount = b.readUInt16LE(coff + 2);
  const optionalSize = b.readUInt16LE(coff + 16);
  const optional = coff + 20;
  const isPe32Plus = b.readUInt16LE(optional) === 0x20b;
  const importRva = b.readUInt32LE((isPe32Plus ? optional + 112 : optional + 96) + 8);
  if (importRva === 0) return [];

  const sections = [];
  for (let i = 0; i < sectionCount; i += 1) {
    const s = optional + optionalSize + i * 40;
    sections.push({
      virtualAddress: b.readUInt32LE(s + 12),
      virtualSize: b.readUInt32LE(s + 8),
      rawPointer: b.readUInt32LE(s + 20),
    });
  }
  const toOffset = (rva) => {
    for (const s of sections) {
      const span = Math.max(s.virtualSize, 1);
      if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
        return s.rawPointer + (rva - s.virtualAddress);
      }
    }
    return 0;
  };

  const names = [];
  let descriptor = toOffset(importRva);
  while (descriptor > 0 && descriptor + 20 <= b.length) {
    const nameRva = b.readUInt32LE(descriptor + 12);
    if (nameRva === 0) break;
    const start = toOffset(nameRva);
    if (start <= 0) break;
    let end = start;
    while (end < b.length && b[end] !== 0) end += 1;
    names.push(b.toString("ascii", start, end));
    descriptor += 20;
  }
  return names;
}

// Every DLL the staged binaries import must be either part of Windows, part of
// the archive, or an explicitly accepted redistributable.
export function assertSelfContainedImports(stageDir, platform) {
  if (platform !== "win32") return;
  const shipped = new Set(readdirSync(stageDir).map((name) => name.toLowerCase()));
  const offenders = [];
  for (const file of machOFiles(stageDir, platform)) {
    for (const imported of peImports(file)) {
      const name = imported.toLowerCase();
      if (shipped.has(name)) continue;
      if (WINDOWS_SYSTEM_EXACT.has(name) || WINDOWS_SYSTEM_DLL.test(name)) continue;
      if (ACCEPTED_REDISTRIBUTABLE.has(name)) continue;
      offenders.push(`${path.basename(file)} -> ${imported}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      "staged runtime imports DLLs it does not ship and Windows does not " +
      `provide:\n${[...new Set(offenders)].join("\n")}`,
    );
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
