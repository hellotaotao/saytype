// Pure helpers for scripts/mirror-release.mjs: which release files go to the
// mainland-China mirror and how the mirrored update manifest differs from
// GitHub's.

export const MIRROR_BASE = "https://typealoud.app/download";

// Linux stays on GitHub: its packages are several times the size of the other
// two platforms together, and its manifest entries keep working unchanged.
const MIRRORED_PLATFORM = /^(darwin|windows)-/;

function fileName(url) {
  return decodeURIComponent(new URL(url).pathname.split("/").pop());
}

export function mirrorPath(tag, name) {
  return `releases/${tag}/${name}`;
}

// The manifest served from the mirror: macOS and Windows packages point at the
// mirror, everything else (signatures included) is left as GitHub wrote it.
export function mirrorManifest(manifest, tag) {
  const platforms = {};
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    platforms[platform] = MIRRORED_PLATFORM.test(platform)
      ? { ...entry, url: `${MIRROR_BASE}/${mirrorPath(tag, fileName(entry.url))}` }
      : entry;
  }
  return { ...manifest, platforms };
}

// Release asset names to copy: every package the mirrored manifest points at,
// plus the macOS installer for the website's download button.
export function mirroredAssetNames(manifest, assetNames) {
  const names = new Set();
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    if (MIRRORED_PLATFORM.test(platform)) names.add(fileName(entry.url));
  }
  for (const name of assetNames) {
    if (name.endsWith(".dmg")) names.add(name);
  }
  return [...names].sort();
}

// Store paths the previous run uploaded that this release no longer uses, so
// the store holds one release at a time. `previousIndex` is the mirror's own
// `releases/current.json`, absent on the first run.
export function stalePaths(previousIndex, keepPaths) {
  const keep = new Set(keepPaths);
  const previous = Array.isArray(previousIndex?.paths) ? previousIndex.paths : [];
  return previous.filter((path) => typeof path === "string" && path.startsWith("releases/") && !keep.has(path)).sort();
}
