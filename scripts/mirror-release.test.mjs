import assert from "node:assert/strict";
import test from "node:test";

import { mirrorManifest, mirroredAssetNames, mirrorPath, stalePaths } from "./mirror-release-lib.mjs";

const gh = "https://github.com/hellotaotao/saytype/releases/download/v1.19.0";
const manifest = {
  version: "1.19.0",
  notes: "notes",
  platforms: {
    "darwin-aarch64": { signature: "sig-mac", url: `${gh}/SayType_universal.app.tar.gz` },
    "darwin-x86_64": { signature: "sig-mac", url: `${gh}/SayType_universal.app.tar.gz` },
    "windows-x86_64": { signature: "sig-exe", url: `${gh}/SayType_1.19.0_x64-setup.exe` },
    "windows-x86_64-msi": { signature: "sig-msi", url: `${gh}/SayType_1.19.0_x64_en-US.msi` },
    "linux-x86_64": { signature: "sig-linux", url: `${gh}/SayType_1.19.0_amd64.AppImage` },
  },
};

test("the mirrored manifest moves macOS and Windows packages and nothing else", () => {
  const mirrored = mirrorManifest(manifest, "v1.19.0");
  assert.equal(
    mirrored.platforms["darwin-aarch64"].url,
    "https://typealoud.app/download/releases/v1.19.0/SayType_universal.app.tar.gz",
  );
  assert.equal(
    mirrored.platforms["windows-x86_64"].url,
    "https://typealoud.app/download/releases/v1.19.0/SayType_1.19.0_x64-setup.exe",
  );
  assert.deepEqual(mirrored.platforms["linux-x86_64"], manifest.platforms["linux-x86_64"]);
  for (const [platform, entry] of Object.entries(mirrored.platforms)) {
    assert.equal(entry.signature, manifest.platforms[platform].signature, platform);
  }
  assert.equal(mirrored.version, "1.19.0");
  assert.equal(mirrored.notes, "notes");
  // The input is GitHub's manifest and must stay usable as such.
  assert.ok(manifest.platforms["darwin-aarch64"].url.startsWith(gh));
});

test("every mirrored package is copied once, along with the dmg", () => {
  const assets = ["latest.json", "SayType_1.19.0_universal.dmg", "SayType_1.19.0_amd64.deb", "SayType_universal.app.tar.gz.sig"];
  assert.deepEqual(mirroredAssetNames(manifest, assets), [
    "SayType_1.19.0_universal.dmg",
    "SayType_1.19.0_x64-setup.exe",
    "SayType_1.19.0_x64_en-US.msi",
    "SayType_universal.app.tar.gz",
  ]);
});

test("only the previous release's files are pruned", () => {
  const keep = [mirrorPath("v1.19.0", "SayType_universal.app.tar.gz")];
  const previous = {
    tag: "v1.18.1",
    paths: ["releases/v1.18.1/SayType_universal.app.tar.gz", "releases/v1.19.0/SayType_universal.app.tar.gz", "runtime/x", 7],
  };
  assert.deepEqual(stalePaths(previous, keep), ["releases/v1.18.1/SayType_universal.app.tar.gz"]);
  assert.deepEqual(stalePaths(null, keep), []);
  assert.deepEqual(stalePaths({ paths: "nope" }, keep), []);
});
