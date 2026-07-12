//! Local Qwen3-ASR backend (provider "local"): on-demand assets (2 GGUF files
//! + a pinned llama.cpp release binary), resumable downloads, and
//! per-transcription subprocess inference via llama-mtmd-cli. No resident
//! engine: the subprocess exits after each transcription, so SayType's idle
//! memory is unchanged. See docs/superpowers/specs/2026-07-12-local-asr-qwen3-design.md.
use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

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

/// Hard ceiling on one decode. Metal does ~60s audio in ~3s; even a 13-min
/// clip (the 25MB WAV cap) at CPU speeds fits comfortably under this.
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(180);
/// MUST be passed explicitly: the model metadata declares ctx 65536 and the
/// CLI default ("0" = from model) preallocates a 7 GiB KV cache (measured).
const CTX_SIZE: &str = "2048";

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Removes the temp WAV on drop -- including when the whole transcribe future
/// is dropped by the caller's tokio::select! on cancellation.
struct TempFile(PathBuf);
impl Drop for TempFile {
  fn drop(&mut self) {
    let _ = fs::remove_file(&self.0);
  }
}

/// Extract the transcription from llama-mtmd-cli stdout. The ASR chat
/// template emits `language <lang><asr_text>TEXT`; silence comes back as
/// `language None<asr_text>` with empty text. If the marker is ever absent
/// (format drift on a llama upgrade), fall back to the trimmed whole output
/// so dictations degrade instead of vanishing.
pub fn parse_mtmd_output(stdout: &str) -> String {
  match stdout.rfind("<asr_text>") {
    Some(idx) => stdout[idx + "<asr_text>".len()..].trim().to_string(),
    None => stdout.trim().to_string(),
  }
}

/// Run one transcription in a llama-mtmd-cli subprocess. Cancellation-safe
/// by construction: dropping this future kills the child (kill_on_drop) and
/// removes the temp file (TempFile guard).
pub async fn transcribe_wav(wav_bytes: &[u8]) -> Result<String> {
  let base = local_asr_dir()?;
  if !assets_ready_at(&base) {
    anyhow::bail!("LOCAL_MODEL_MISSING: local model assets are missing or incomplete");
  }

  let tmp_path = std::env::temp_dir().join(format!(
    "saytype-asr-{}-{}.wav",
    std::process::id(),
    TMP_SEQ.fetch_add(1, Ordering::Relaxed)
  ));
  fs::write(&tmp_path, wav_bytes)
    .with_context(|| format!("failed to write temp audio {}", tmp_path.display()))?;
  let _tmp = TempFile(tmp_path.clone());

  let started = std::time::Instant::now();
  let child = tokio::process::Command::new(cli_path(&base))
    .arg("-m").arg(base.join(MODEL_ASSETS[0].rel_path))
    .arg("--mmproj").arg(base.join(MODEL_ASSETS[1].rel_path))
    .arg("--audio").arg(&tmp_path)
    .arg("-p").arg("a")
    .arg("-c").arg(CTX_SIZE)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true)
    .spawn()
    .context("failed to start llama-mtmd-cli")?;

  let output = tokio::time::timeout(TRANSCRIBE_TIMEOUT, child.wait_with_output())
    .await
    .map_err(|_| anyhow::anyhow!("local ASR timed out after {}s", TRANSCRIBE_TIMEOUT.as_secs()))?
    .context("failed to run llama-mtmd-cli")?;

  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
    anyhow::bail!("llama-mtmd-cli failed ({}): {last}", output.status);
  }

  let text = parse_mtmd_output(&String::from_utf8_lossy(&output.stdout));
  // Counts only -- no transcribed text in logs.
  log::info!(
    "local ASR: decoded {} KB wav in {:.2}s ({} chars)",
    wav_bytes.len() / 1024,
    started.elapsed().as_secs_f32(),
    text.chars().count()
  );
  Ok(text)
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

  // Byte-exact stdout captured 2026-07-13 from a real llama-mtmd-cli run
  // (Task 3 Step 1): bin/b9960/llama-mtmd-cli -m models/Qwen3-ASR-0.6B-Q8_0.gguf
  // --mmproj models/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf --audio <wav> -p "a" -c 2048.
  #[test]
  fn parse_extracts_text_after_the_asr_marker() {
    let sample = "\nlanguage Chinese<asr_text>然后这次是我输入了命令之后啊，讲一次哈。我觉得Unity。\n\n\n";
    assert_eq!(parse_mtmd_output(sample), "然后这次是我输入了命令之后啊，讲一次哈。我觉得Unity。");
  }

  #[test]
  fn parse_silence_yields_empty() {
    let sample = "\nlanguage None<asr_text>\n\n\n";
    assert_eq!(parse_mtmd_output(sample), "");
  }

  #[test]
  fn parse_without_marker_falls_back_to_trimmed_whole() {
    assert_eq!(parse_mtmd_output("  plain text out  \n"), "plain text out");
    assert_eq!(parse_mtmd_output(""), "");
  }

  /// Needs the real assets laid out (Task 3 Step 1). Run manually:
  ///   cargo test real_subprocess_smoke -- --ignored --nocapture
  #[test]
  #[ignore]
  fn real_subprocess_smoke() {
    assert!(assets_ready(), "lay out the assets first (plan Task 3 Step 1)");
    let rt = tokio::runtime::Runtime::new().unwrap();
    // 5s of silence WAV (44-byte header + zeros), built inline. Duration
    // matters here: measured 2026-07-13, pure-digital-zero clips <=2s make
    // the model hallucinate a filler "嗯。" instead of returning empty text
    // (0.5s/1s/2s all hallucinate; 5s/10s decode cleanly to ""). 5s clears
    // that threshold with margin.
    let mut wav = Vec::new();
    let data_len = 160_000u32; // 5s * 16000Hz * 2 bytes
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());          // PCM
    wav.extend_from_slice(&1u16.to_le_bytes());          // mono
    wav.extend_from_slice(&16000u32.to_le_bytes());      // rate
    wav.extend_from_slice(&32000u32.to_le_bytes());      // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes());          // block align
    wav.extend_from_slice(&16u16.to_le_bytes());         // bits
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.resize(wav.len() + data_len as usize, 0);
    let text = rt.block_on(transcribe_wav(&wav)).expect("subprocess ok");
    assert_eq!(text, "", "silence must yield empty text");
    // Temp file cleaned up:
    let leftovers = fs::read_dir(std::env::temp_dir()).unwrap()
      .filter_map(|e| e.ok())
      .filter(|e| e.file_name().to_string_lossy().starts_with("saytype-asr-"))
      .count();
    assert_eq!(leftovers, 0, "temp wav files must be removed");
  }
}
