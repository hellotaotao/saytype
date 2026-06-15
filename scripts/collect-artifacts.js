#!/usr/bin/env node
"use strict";

// Copies the freshly built macOS .dmg out of Tauri's deep bundle directory
// (src-tauri/target/<triple>/release/bundle/dmg/) into a top-level dist/ folder
// and reveals it in Finder, so you don't have to dig for the installer.
//
// Usage: node scripts/collect-artifacts.js [target-triple]
//   - With a triple (e.g. aarch64-apple-darwin) it looks under that target dir.
//   - Without one it uses the host build dir (src-tauri/target/release/bundle).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const triple = process.argv[2] || "";
const repoRoot = path.resolve(__dirname, "..");
const bundleDir = path.join(repoRoot, "src-tauri", "target", triple, "release", "bundle");
const dmgDir = path.join(bundleDir, "dmg");
const distDir = path.join(repoRoot, "dist");

if (!fs.existsSync(dmgDir)) {
  console.warn(`[collect-artifacts] no dmg directory at ${dmgDir} — nothing to copy`);
  process.exit(0);
}

const dmgs = fs
  .readdirSync(dmgDir)
  .filter((name) => name.toLowerCase().endsWith(".dmg"))
  .map((name) => path.join(dmgDir, name));

if (!dmgs.length) {
  console.warn(`[collect-artifacts] no .dmg found in ${dmgDir}`);
  process.exit(0);
}

fs.mkdirSync(distDir, { recursive: true });

const copied = [];
for (const src of dmgs) {
  const dest = path.join(distDir, path.basename(src));
  fs.copyFileSync(src, dest);
  copied.push(dest);
}

console.log("\n[collect-artifacts] installer copied to dist/:");
for (const dest of copied) {
  console.log("  " + path.relative(repoRoot, dest));
}

// Reveal the newest installer in Finder (macOS only, best-effort).
if (process.platform === "darwin") {
  const newest = copied
    .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].p;
  try {
    execFileSync("open", ["-R", newest]);
  } catch {
    // Revealing in Finder is a convenience only; ignore failures.
  }
}
