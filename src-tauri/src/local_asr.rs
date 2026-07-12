//! Local Qwen3-ASR backend (provider "local"): on-demand assets (2 GGUF files
//! + a pinned llama.cpp release binary), resumable downloads, and
//! per-transcription subprocess inference via llama-mtmd-cli. No resident
//! engine: the subprocess exits after each transcription, so SayType's idle
//! memory is unchanged. See docs/superpowers/specs/2026-07-12-local-asr-qwen3-design.md.
use anyhow::{Context, Result};
use serde::Serialize;
use sha2::Digest;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

pub const LOCAL_PROVIDER: &str = "local";
/// Model id stored in config.model for the local provider. Rust never reads
/// it back (routing keys off provider=="local"); the frontend mirrors this
/// literal in settings.js (modelOptions.local) and input-prompt.js
/// (LOCAL_MODEL_ID) — keep all three in sync.
#[allow(dead_code)]
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

/// Hard ceiling on one decode. Metal does ~60s audio in ~3s; on CPU-only
/// platforms (Windows/Linux, RTF ~0.3) a maximal 25MB-WAV clip (~13 min)
/// could exceed this — acceptable for now, those platforms are not yet
/// real-machine verified. Revisit if long-form CPU dictation becomes real.
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
  let _tmp = TempFile(tmp_path.clone());
  fs::write(&tmp_path, wav_bytes)
    .with_context(|| format!("failed to write temp audio {}", tmp_path.display()))?;

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

/// Emit a progress event at most every this many bytes.
const PROGRESS_EMIT_STEP: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
  pub state: String,
  pub downloaded_bytes: u64,
  pub total_bytes: u64,
}

pub fn model_status(downloading: bool) -> ModelStatus {
  match local_asr_dir() {
    Ok(dir) => model_status_at(&dir, downloading),
    Err(_) => ModelStatus {
      state: "absent".into(),
      downloaded_bytes: 0,
      total_bytes: total_download_bytes(),
    },
  }
}

fn model_status_at(dir: &Path, downloading: bool) -> ModelStatus {
  let mut downloaded = 0u64;
  let mut complete = true;
  let zip = llama_zip_asset();
  // Model files count by exact size; the zip counts as fully downloaded once
  // the extracted CLI exists (the archive is removed after extraction).
  for a in MODEL_ASSETS {
    let got = fs::metadata(dir.join(a.rel_path)).map(|m| m.len()).unwrap_or(0);
    if got == a.size {
      downloaded += a.size;
    } else {
      complete = false;
      downloaded += got.min(a.size);
      if let Ok(m) = fs::metadata(dir.join(format!("{}.part", a.rel_path))) {
        downloaded += m.len().min(a.size);
      }
    }
  }
  let cli = cli_path(dir);
  if fs::metadata(&cli).map(|m| m.is_file()).unwrap_or(false) && is_executable(&cli) {
    downloaded += zip.size;
  } else {
    complete = false;
    if let Ok(m) = fs::metadata(dir.join(format!("{}.part", zip.rel_path))) {
      downloaded += m.len().min(zip.size);
    } else if let Ok(m) = fs::metadata(dir.join(zip.rel_path)) {
      downloaded += m.len().min(zip.size);
    }
  }
  let state = if downloading {
    "downloading"
  } else if complete {
    "ready"
  } else if downloaded > 0 {
    "partial"
  } else {
    "absent"
  };
  ModelStatus { state: state.into(), downloaded_bytes: downloaded, total_bytes: total_download_bytes() }
}

fn emit_progress(app: &tauri::AppHandle, state: &str, downloaded: u64, message: Option<&str>) {
  let _ = app.emit(
    "local-model-download-progress",
    serde_json::json!({
      "state": state,
      "downloadedBytes": downloaded,
      "totalBytes": total_download_bytes(),
      "message": message,
    }),
  );
}

/// Download all missing assets (resumable), verify sha256, extract the llama
/// archive, mark the CLI executable. Terminal events are emitted by the COMMAND.
pub async fn download_model(app: tauri::AppHandle, cancel: CancellationToken) -> Result<(), String> {
  let dir = local_asr_dir().map_err(|e| e.to_string())?;
  let client = reqwest::Client::builder()
    .connect_timeout(std::time::Duration::from_secs(15))
    .build()
    .map_err(|e| e.to_string())?;

  let mut done: u64 = 0;
  for a in MODEL_ASSETS {
    if fs::metadata(dir.join(a.rel_path)).map(|m| m.len() == a.size).unwrap_or(false) {
      done += a.size;
      continue;
    }
    download_asset(&app, &client, &dir, a, &cancel, done).await?;
    done += a.size;
    emit_progress(&app, "downloading", done, None);
  }

  let zip = llama_zip_asset();
  if !(fs::metadata(cli_path(&dir)).map(|m| m.is_file()).unwrap_or(false) && is_executable(&cli_path(&dir))) {
    let zip_final = dir.join(zip.rel_path);
    if !fs::metadata(&zip_final).map(|m| m.len() == zip.size).unwrap_or(false) {
      download_asset(&app, &client, &dir, zip, &cancel, done).await?;
    }
    let dir2 = dir.clone();
    tokio::task::spawn_blocking(move || extract_llama_archive(&dir2))
      .await
      .map_err(|e| e.to_string())??;
    let _ = fs::remove_file(&zip_final); // archive no longer needed
  }
  Ok(())
}

/// Extract every regular file in the archive, flattened to its basename, into
/// bin/<LLAMA_BUILD>/, and mark all of them executable on unix (the CLI needs
/// it; the bundled dylibs don't care). Flattening keeps us independent of the
/// archive's top-level folder naming across llama.cpp releases -- adjust ONLY
/// if the Task-3 Step-1 rpath check demanded preserved structure.
///
/// macOS/Linux releases are gzip-compressed tarballs; Windows releases are a
/// real zip (Task 2 finding) -- so the two platforms use different crates.
#[cfg(unix)]
fn extract_llama_archive(base: &Path) -> Result<(), String> {
  let archive_path = base.join(llama_zip_asset().rel_path);
  let out_dir = bin_dir(base);
  fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
  let file = fs::File::open(&archive_path).map_err(|e| e.to_string())?;
  let gz = flate2::read::GzDecoder::new(file);
  let mut archive = tar::Archive::new(gz);
  for entry in archive.entries().map_err(|e| e.to_string())? {
    let mut entry = entry.map_err(|e| e.to_string())?;
    if !entry.header().entry_type().is_file() {
      continue;
    }
    let entry_path = entry.path().map_err(|e| e.to_string())?.into_owned();
    let Some(name) = entry_path.file_name().map(|n| n.to_owned()) else { continue };
    let out_path = out_dir.join(name);
    let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
    std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&out_path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
  }
  if !fs::metadata(cli_path(base)).map(|m| m.is_file()).unwrap_or(false) {
    return Err("archive did not contain llama-mtmd-cli".into());
  }
  Ok(())
}

#[cfg(windows)]
fn extract_llama_archive(base: &Path) -> Result<(), String> {
  let zip_path = base.join(llama_zip_asset().rel_path);
  let out_dir = bin_dir(base);
  fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
  let file = fs::File::open(&zip_path).map_err(|e| e.to_string())?;
  let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
  for i in 0..archive.len() {
    let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
    if entry.is_dir() {
      continue;
    }
    let Some(name) = Path::new(entry.name()).file_name().map(|n| n.to_owned()) else { continue };
    let out_path = out_dir.join(name);
    let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
    std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
  }
  if !fs::metadata(cli_path(base)).map(|m| m.is_file()).unwrap_or(false) {
    return Err("archive did not contain llama-mtmd-cli".into());
  }
  Ok(())
}

async fn download_asset(
  app: &tauri::AppHandle,
  client: &reqwest::Client,
  dir: &Path,
  asset: &Asset,
  cancel: &CancellationToken,
  done_bytes: u64,
) -> Result<(), String> {
  let part_path = dir.join(format!("{}.part", asset.rel_path));
  if let Some(parent) = part_path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }

  let mut last_err = String::new();
  for url in asset.urls {
    if cancel.is_cancelled() {
      return Err("DOWNLOAD_CANCELLED".into());
    }
    let offset = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    // A .part larger than the target is corrupt — restart it. One exactly at
    // the target size may be a finished stream that died before verification
    // (sha256 of ~800MB takes seconds) — skip straight to verification and
    // salvage it instead of asking the server for `bytes=<size>-` (HTTP 416).
    let offset = if offset > asset.size { 0 } else { offset };
    let stream_result = if offset == asset.size {
      Ok(())
    } else {
      stream_to_part(app, client, url, &part_path, offset, asset, cancel, done_bytes).await
    };
    match stream_result {
      Ok(()) => {
        let got = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
        if got != asset.size {
          last_err = format!("{}: size mismatch {got} != {}", asset.rel_path, asset.size);
          let _ = fs::remove_file(&part_path);
          continue;
        }
        let path_for_hash = part_path.clone();
        let hash = tokio::task::spawn_blocking(move || -> Result<String, String> {
          let mut hasher = sha2::Sha256::new();
          let mut reader = fs::File::open(&path_for_hash).map_err(|e| e.to_string())?;
          std::io::copy(&mut reader, &mut hasher).map_err(|e| e.to_string())?;
          Ok(format!("{:x}", hasher.finalize()))
        })
        .await
        .map_err(|e| e.to_string())??;
        if hash != asset.sha256 {
          last_err = format!("{}: sha256 mismatch", asset.rel_path);
          let _ = fs::remove_file(&part_path);
          continue;
        }
        fs::rename(&part_path, dir.join(asset.rel_path)).map_err(|e| e.to_string())?;
        return Ok(());
      }
      Err(err) if err == "DOWNLOAD_CANCELLED" => return Err(err),
      Err(err) => {
        // Keep the .part -- the next source (byte-identical) resumes it.
        last_err = format!("{url}: {err}");
        log::warn!("asset download source failed: {last_err}");
      }
    }
  }
  Err(format!("failed to download {}: {last_err}", asset.rel_path))
}

#[allow(clippy::too_many_arguments)]
async fn stream_to_part(
  app: &tauri::AppHandle,
  client: &reqwest::Client,
  url: &str,
  part_path: &Path,
  offset: u64,
  asset: &Asset,
  cancel: &CancellationToken,
  done_bytes: u64,
) -> Result<(), String> {
  use std::io::Write;

  let mut request = client.get(url);
  if offset > 0 {
    request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
  }
  let response = request.send().await.map_err(|e| e.to_string())?;
  let status = response.status();
  if !status.is_success() {
    return Err(format!("HTTP {status}"));
  }
  let append = offset > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
  let mut out = fs::OpenOptions::new()
    .create(true)
    .append(append)
    .write(true)
    .truncate(!append)
    .open(part_path)
    .map_err(|e| e.to_string())?;
  let mut written = if append { offset } else { 0 };
  let mut last_emit = written;

  let mut response = response;
  loop {
    let chunk = tokio::select! {
      _ = cancel.cancelled() => return Err("DOWNLOAD_CANCELLED".into()),
      chunk = response.chunk() => chunk.map_err(|e| e.to_string())?,
    };
    let Some(chunk) = chunk else { break };
    out.write_all(&chunk).map_err(|e| e.to_string())?;
    written += chunk.len() as u64;
    if written - last_emit >= PROGRESS_EMIT_STEP {
      last_emit = written;
      emit_progress(app, "downloading", done_bytes + written.min(asset.size), None);
    }
  }
  out.flush().map_err(|e| e.to_string())?;
  Ok(())
}

/// Settings "delete model": remove the whole local-asr dir (models + bin).
/// No engine unload needed -- nothing is resident between transcriptions.
pub fn delete_model() -> Result<(), String> {
  let dir = local_asr_dir().map_err(|e| e.to_string())?;
  match fs::remove_dir_all(&dir) {
    Ok(()) => Ok(()),
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(err) => Err(err.to_string()),
  }
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

  #[test]
  fn model_status_reports_absent_partial_ready() {
    let temp = tempfile::TempDir::new().unwrap();
    let dir = temp.path();
    let s = model_status_at(dir, false);
    assert_eq!(s.state, "absent");
    assert_eq!(s.total_bytes, total_download_bytes());
    assert_eq!(s.downloaded_bytes, 0);

    // One finished GGUF + one .part -> partial, bytes add up.
    let a0 = &MODEL_ASSETS[0];
    let p = dir.join(a0.rel_path);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::File::create(&p).unwrap().set_len(a0.size).unwrap();
    let part = dir.join(format!("{}.part", MODEL_ASSETS[1].rel_path));
    fs::create_dir_all(part.parent().unwrap()).unwrap();
    fs::File::create(&part).unwrap().set_len(1000).unwrap();
    let s = model_status_at(dir, false);
    assert_eq!(s.state, "partial");
    assert_eq!(s.downloaded_bytes, a0.size + 1000);

    assert_eq!(model_status_at(dir, true).state, "downloading");

    // Everything in place (incl. executable cli) -> ready. The zip itself is
    // deleted after extraction, so "ready" ignores it; its bytes count as
    // downloaded when the cli exists.
    for a in MODEL_ASSETS {
      let p = dir.join(a.rel_path);
      fs::create_dir_all(p.parent().unwrap()).unwrap();
      fs::File::create(&p).unwrap().set_len(a.size).unwrap();
    }
    let cli = cli_path(dir);
    fs::create_dir_all(cli.parent().unwrap()).unwrap();
    fs::write(&cli, b"x").unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let s = model_status_at(dir, false);
    assert_eq!(s.state, "ready");
    assert_eq!(s.downloaded_bytes, s.total_bytes);
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
