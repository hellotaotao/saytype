#!/usr/bin/env node
// Copies a published release's macOS and Windows packages to the
// mainland-China mirror (the saytype-downloads Blob store behind
// saytype.taotao.au/download) and writes the mirror's own latest.json there.
// Run by release.yml after the GitHub release is published; safe to re-run.
//
//   BLOB_READ_WRITE_TOKEN=... node scripts/mirror-release.mjs v1.19.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MIRROR_BASE, mirrorManifest, mirroredAssetNames, mirrorPath, stalePaths } from "./mirror-release-lib.mjs";

const VERCEL_CLI = "vercel@58.9.1";
const YEAR_SECONDS = 365 * 24 * 60 * 60;
// Blob's shortest cache lifetime; the manifest and index change every release.
const MANIFEST_MAX_AGE = 60;
const INDEX_PATH = "releases/current.json";

const tag = process.argv[2];
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!/^v\d+\.\d+\.\d+/.test(tag ?? "") || !token) {
  console.error("usage: BLOB_READ_WRITE_TOKEN=... node scripts/mirror-release.mjs vX.Y.Z");
  process.exit(2);
}

function blob(...args) {
  execFileSync("npx", ["--yes", VERCEL_CLI, "blob", ...args, "--rw-token", token], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function put(file, path, maxAge) {
  blob("put", file, "--access", "public", "--pathname", path, "--allow-overwrite", "true", "--cache-control-max-age", String(maxAge));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchMirror(path) {
  // A unique query string gets past the cached copy of a file just replaced.
  const response = await fetch(`${MIRROR_BASE}/${path}?mirror-check=${Date.now()}`);
  return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
}

const dir = mkdtempSync(join(tmpdir(), "saytype-mirror-"));
try {
  const release = JSON.parse(execFileSync("gh", ["release", "view", tag, "--json", "assets,isDraft"], { encoding: "utf8" }));
  if (release.isDraft) throw new Error(`${tag} is still a draft; mirror only published releases`);
  execFileSync("gh", ["release", "download", tag, "--dir", dir, "--pattern", "latest.json"]);
  const manifest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  if (`v${manifest.version}` !== tag) throw new Error(`latest.json is ${manifest.version}, expected ${tag}`);

  const names = mirroredAssetNames(manifest, release.assets.map((asset) => asset.name));
  const paths = names.map((name) => mirrorPath(tag, name));
  const previousIndex = JSON.parse((await fetchMirror(INDEX_PATH))?.toString("utf8") ?? "null");

  for (const name of names) {
    execFileSync("gh", ["release", "download", tag, "--dir", dir, "--pattern", name]);
    put(join(dir, name), mirrorPath(tag, name), YEAR_SECONDS);
    const served = await fetchMirror(mirrorPath(tag, name));
    if (!served || sha256(served) !== sha256(readFileSync(join(dir, name)))) {
      throw new Error(`${name} does not read back intact from the mirror`);
    }
    console.log(`mirrored ${name}`);
  }

  // The manifest goes last, so clients never see one whose packages are missing.
  const mirrored = join(dir, "mirror-latest.json");
  writeFileSync(mirrored, `${JSON.stringify(mirrorManifest(manifest, tag), null, 2)}\n`);
  put(mirrored, "latest.json", MANIFEST_MAX_AGE);
  const index = join(dir, "current.json");
  writeFileSync(index, `${JSON.stringify({ tag, paths }, null, 2)}\n`);
  put(index, INDEX_PATH, MANIFEST_MAX_AGE);
  console.log(`mirror manifest now serves ${tag}`);

  for (const path of stalePaths(previousIndex, paths)) {
    blob("del", path);
    console.log(`removed ${path}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
