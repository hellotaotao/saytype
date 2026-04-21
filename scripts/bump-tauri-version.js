const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJsonPath = path.join(root, "package.json");
const cargoTomlPath = path.join(root, "src-tauri", "Cargo.toml");
const tauriConfigPath = path.join(root, "src-tauri", "tauri.conf.json");

function bumpPatch(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Unsupported version format: ${version}`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]) + 1;
  return `${major}.${minor}.${patch}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function updateCargoTomlVersion(filePath, version) {
  const content = fs.readFileSync(filePath, "utf8");
  const updated = content.replace(
    /^(version\s*=\s*")[^"]+("\s*)$/m,
    `$1${version}$2`
  );

  if (updated === content) {
    throw new Error("Failed to update version in src-tauri/Cargo.toml");
  }

  fs.writeFileSync(filePath, updated, "utf8");
}

function main() {
  const packageJson = readJson(packageJsonPath);
  const currentVersion = packageJson.version;
  const nextVersion = bumpPatch(currentVersion);

  packageJson.version = nextVersion;
  writeJson(packageJsonPath, packageJson);

  const tauriConfig = readJson(tauriConfigPath);
  tauriConfig.version = nextVersion;
  writeJson(tauriConfigPath, tauriConfig);

  updateCargoTomlVersion(cargoTomlPath, nextVersion);

  console.log(`Bumped Tauri version: ${currentVersion} -> ${nextVersion}`);
}

main();
