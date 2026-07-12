//! Local Qwen3-ASR backend (provider "local"): on-demand assets (2 GGUF files
//! + a pinned llama.cpp release binary), resumable downloads, and
//! per-transcription subprocess inference via llama-mtmd-cli. No resident
//! engine: the subprocess exits after each transcription, so SayType's idle
//! memory is unchanged. See docs/superpowers/specs/2026-07-12-local-asr-qwen3-design.md.
use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

pub const LOCAL_PROVIDER: &str = "local";
pub const LOCAL_MODEL_ID: &str = "qwen3-asr-0.6b-q8_0";
/// Pinned llama.cpp release. Must stay ≥ b9173 (Qwen3-ASR repetition fix,
/// ggml-org/llama.cpp#22357). Upgrading requires re-verifying CLI flags,
/// stdout format, all sha256s, and a real-dictation regression.
pub const LLAMA_BUILD: &str = "b9960";

pub struct Asset {
  /// Final location under local_asr_dir(); doubles as the download's .part
  /// sibling name. Forward slashes are fine in PathBuf::join on Windows.
  pub rel_path: &'static str,
  /// Try in order (mirror fallback); byte-identical across sources.
  pub urls: &'static [&'static str],
  pub size: u64,
  pub sha256: &'static str,
}

const HF_BASE: &str = "https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/main/";

pub const MODEL_ASSETS: &[Asset] = &[
  Asset {
    rel_path: "models/Qwen3-ASR-0.6B-Q8_0.gguf",
    // ModelScope mirrors this repo (probed 2026-07-13, HTTP 200, identical
    // X-Linked-Etag) so it's listed first as the faster mirror for CN users;
    // HF is the international fallback.
    urls: &[
      "https://modelscope.cn/models/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/master/Qwen3-ASR-0.6B-Q8_0.gguf",
      "https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/main/Qwen3-ASR-0.6B-Q8_0.gguf",
    ],
    size: 804_749_248,
    sha256: "bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971",
  },
  Asset {
    rel_path: "models/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
    urls: &[
      "https://modelscope.cn/models/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/master/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
      "https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/main/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
    ],
    size: 214_392_480,
    sha256: "41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d",
  },
];

// One llama.cpp archive per platform; only the current platform's entry is
// used. macOS/Linux releases are gzip-compressed tarballs, Windows is a real
// zip -- rel_path/urls reflect each asset's actual file extension.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
static MAC_ZIP: Asset = Asset {
  rel_path: "llama-macos-arm64.tar.gz",
  urls: &[
    "https://github.com/ggml-org/llama.cpp/releases/download/b9960/llama-b9960-bin-macos-arm64.tar.gz",
  ],
  size: 10_734_569,
  sha256: "7a8c6b6ae3395e15b5cc330ed2938cc0aa4510905db1189658fd022035734b48",
};
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn llama_zip_asset() -> &'static Asset {
  &MAC_ZIP
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
static WIN_ZIP: Asset = Asset {
  rel_path: "llama-win-x64.zip",
  urls: &[
    "https://github.com/ggml-org/llama.cpp/releases/download/b9960/llama-b9960-bin-win-cpu-x64.zip",
  ],
  size: 18_209_357,
  sha256: "795333e29cedf9f9ef9ae91324bfa423e338d39d75cc63a8dd76d1686c32ced6",
};
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub fn llama_zip_asset() -> &'static Asset {
  &WIN_ZIP
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
static LINUX_ZIP: Asset = Asset {
  rel_path: "llama-linux-x64.tar.gz",
  urls: &[
    "https://github.com/ggml-org/llama.cpp/releases/download/b9960/llama-b9960-bin-ubuntu-x64.tar.gz",
  ],
  size: 15_819_482,
  sha256: "542732e344420ff904c1d72acfeef6341f509232c5d131809421943235a818a2",
};
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub fn llama_zip_asset() -> &'static Asset {
  &LINUX_ZIP
}

pub fn total_download_bytes() -> u64 {
  MODEL_ASSETS.iter().map(|a| a.size).sum::<u64>() + llama_zip_asset().size
}

pub fn local_asr_dir() -> Result<PathBuf> {
  Ok(crate::settings::app_data_dir()?.join("local-asr"))
}

pub fn bin_dir(base: &Path) -> PathBuf {
  base.join("bin").join(LLAMA_BUILD)
}

pub fn cli_path(base: &Path) -> PathBuf {
  let name = if cfg!(target_os = "windows") { "llama-mtmd-cli.exe" } else { "llama-mtmd-cli" };
  bin_dir(base).join(name)
}

/// Cheap readiness: every GGUF at its exact size, plus the extracted CLI
/// present (executable on unix). sha256 is verified once at download time.
pub fn assets_ready_at(dir: &Path) -> bool {
  let models_ok = MODEL_ASSETS.iter().all(|a| {
    fs::metadata(dir.join(a.rel_path)).map(|m| m.len() == a.size).unwrap_or(false)
  });
  let cli = cli_path(dir);
  let cli_ok = fs::metadata(&cli).map(|m| m.is_file()).unwrap_or(false)
    && is_executable(&cli);
  models_ok && cli_ok
}

pub fn assets_ready() -> bool {
  local_asr_dir().map(|d| assets_ready_at(&d)).unwrap_or(false)
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
  use std::os::unix::fs::PermissionsExt;
  fs::metadata(path).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
  true
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn manifest_is_filled_and_totals_are_sane() {
    assert_eq!(MODEL_ASSETS.len(), 2);
    for a in MODEL_ASSETS.iter().chain(std::iter::once(llama_zip_asset())) {
      assert_eq!(a.sha256.len(), 64, "{} sha256 must be real", a.rel_path);
      assert!(a.size > 0, "{} size must be real", a.rel_path);
      assert!(!a.urls.is_empty());
    }
    let total = total_download_bytes();
    // ~1.02GB models + a 10-80MB zip
    assert!(total > 1_020_000_000 && total < 1_150_000_000, "total = {total}");
    assert_ne!(LLAMA_BUILD, "<FILL-STEP-1>");
  }

  #[test]
  fn assets_ready_requires_models_at_exact_size_and_an_executable_cli() {
    let temp = tempfile::TempDir::new().unwrap();
    let dir = temp.path();
    assert!(!assets_ready_at(dir));
    for a in MODEL_ASSETS {
      let p = dir.join(a.rel_path);
      fs::create_dir_all(p.parent().unwrap()).unwrap();
      fs::File::create(&p).unwrap().set_len(a.size).unwrap(); // sparse, fast
    }
    assert!(!assets_ready_at(dir), "still missing the cli binary");
    let cli = cli_path(dir);
    fs::create_dir_all(cli.parent().unwrap()).unwrap();
    fs::write(&cli, b"#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      // Not executable yet -> not ready on unix.
      assert!(!assets_ready_at(dir));
      fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert!(assets_ready_at(dir));
    // Truncate one model -> not ready.
    fs::File::create(dir.join(MODEL_ASSETS[0].rel_path)).unwrap().set_len(1).unwrap();
    assert!(!assets_ready_at(dir));
  }
}
