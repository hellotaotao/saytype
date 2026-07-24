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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::Emitter;
use tokio::io::AsyncReadExt;
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

// Intel-Mac slice of the universal binary. Never built by ci.yml (which is
// aarch64-only for macOS) — only the release's universal-apple-darwin build
// compiles this arch, so this gap first surfaced at the v1.4.0 release.
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
static MAC_ZIP: Asset = Asset {
  rel_path: "llama-macos-x64.tar.gz",
  urls: &[
    "https://github.com/ggml-org/llama.cpp/releases/download/b9960/llama-b9960-bin-macos-x64.tar.gz",
  ],
  size: 11_007_527,
  sha256: "d42000ae003fd61d7db50997af0e80f421524e30b534856c66573d064a478c1d",
};
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
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

fn local_asr_command(program: PathBuf) -> tokio::process::Command {
  let mut command = tokio::process::Command::new(program);
  #[cfg(target_os = "windows")]
  {
    // llama-mtmd-cli is a console executable. Without CREATE_NO_WINDOW,
    // Windows opens a terminal for every transcription and may steal focus
    // from the app that should receive the resulting text.
    command.creation_flags(0x0800_0000);
  }
  command
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
/// Context size for one decode, sized to the clip. It MUST be passed
/// explicitly: the model metadata declares ctx 65536 and the CLI default
/// ("0" = from model) preallocates a ~7 GiB KV cache (measured). But a fixed
/// small ctx overflows on long audio — llama.cpp preallocates the KV cache to
/// the *full* ctx, and Qwen3-ASR streams the clip into it at ~15 tokens/s on
/// top of the generated transcript. At the old fixed 2048 this failed past
/// ~2 min: `failed to decode audio` once the audio alone overflowed (~2.7 min),
/// or `failed to decode token` when the audio fit but audio+transcript didn't
/// (~2.2 min, the common user-visible one). So we size ctx to the clip.
///
/// The frontend always uploads 16 kHz mono 16-bit WAV in local mode
/// (vad-gate.js forceWav/encodeFullWav) = 32000 bytes/s, so seconds ≈
/// (len-44)/32000. Budget ~20 tokens/s (audio ~15/s + transcript headroom) plus
/// a 512 base, clamped to [FLOOR, CAP]. The 2048 FLOOR keeps short clips at the
/// old memory; the 16384 CAP bounds a pathological clip (~2.9 GiB peak RSS,
/// ~13 min of speech). Measured peak RSS ≈ 110 KiB/token: ctx 2048→1288 MiB,
/// 8192→2020, 16384→2891, 32768→4659. Verified 135 s–300 s clips that failed at
/// 2048 all decode cleanly under this formula.
const CTX_FLOOR: u32 = 2048;
const CTX_CAP: u32 = 16384;
fn ctx_size_for_wav(wav_len: usize) -> u32 {
  let seconds = wav_len.saturating_sub(44) as f64 / 32000.0;
  let tokens = (seconds * 20.0) as u32 + 512;
  tokens.clamp(CTX_FLOOR, CTX_CAP)
}

/// How long to wait for the FIRST stdout byte before declaring the decode hung,
/// sized to the clip. Qwen3-ASR encodes the whole clip before emitting token 1,
/// and that encode grows with clip length (measured ~0.03 s per audio-second:
/// first byte 2.4 s into an 82 s clip, 7.7 s into a 5.5 min one). Budget
/// generously — a 15 s base + 0.1 s per audio-second gives ~5-10x margin over
/// those measurements, so a slow machine is never mistaken for a wedged process.
/// The flat `TRANSCRIBE_TIMEOUT` remains the outer hard cap.
const FIRST_BYTE_BASE: Duration = Duration::from_secs(15);
fn first_byte_deadline(wav_len: usize) -> Duration {
  let seconds = wav_len.saturating_sub(44) as f64 / 32000.0;
  FIRST_BYTE_BASE + Duration::from_millis((seconds * 100.0) as u64)
}

/// Once tokens are flowing, a healthy decode never pauses this long between
/// stdout growth. A gap beyond this means the CLI wedged mid-decode.
const NO_PROGRESS_TIMEOUT: Duration = Duration::from_secs(20);

/// How often the hang watchdog re-evaluates progress. Coarse on purpose — the
/// thresholds it guards are tens of seconds, so a 1 s cadence is plenty.
const WATCHDOG_POLL: Duration = Duration::from_secs(1);

/// Verdict of the hang watchdog at one poll tick.
#[derive(Debug, PartialEq, Eq)]
enum StallCheck {
  /// Still making (or plausibly about to make) progress — keep waiting.
  Ok,
  /// No stdout at all past the clip-sized first-byte grace: the CLI never
  /// started producing, treat as wedged.
  HungBeforeFirstByte,
  /// Tokens were flowing but stdout has been silent past NO_PROGRESS_TIMEOUT.
  HungMidDecode,
}

/// Decide whether a decode has hung, given whether any stdout byte has landed,
/// how long since the process started, how long since stdout last grew, and the
/// clip length (which sets the first-byte grace). Pure so it can be unit-tested
/// without a subprocess; the async pump calls it on a poll tick.
fn stall_check(
  seen_first_byte: bool,
  since_start: Duration,
  since_progress: Duration,
  wav_len: usize,
) -> StallCheck {
  if !seen_first_byte {
    if since_start > first_byte_deadline(wav_len) {
      return StallCheck::HungBeforeFirstByte;
    }
  } else if since_progress > NO_PROGRESS_TIMEOUT {
    return StallCheck::HungMidDecode;
  }
  StallCheck::Ok
}

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

/// The transcript so far, from a partially-read stdout. None until the
/// `<asr_text>` marker lands — everything before it is the chat template's
/// `language <lang>` prefix, which is not transcript. Unlike
/// parse_mtmd_output this must tolerate a truncated tail: a read can split a
/// multi-byte char, which from_utf8_lossy renders as U+FFFD, so trailing
/// replacement chars are dropped rather than shown as garbage.
fn partial_text(stdout: &[u8]) -> Option<String> {
  let s = String::from_utf8_lossy(stdout);
  let idx = s.rfind("<asr_text>")?;
  Some(s[idx + "<asr_text>".len()..].trim_start().trim_end_matches('\u{FFFD}').to_string())
}

/// Floor on how often partial text is pushed to the webview. The model emits
/// tokens far faster than the UI needs repainting.
const PARTIAL_EMIT_INTERVAL: Duration = Duration::from_millis(100);

/// Run one transcription in a llama-mtmd-cli subprocess. Cancellation-safe
/// by construction: dropping this future kills the child (kill_on_drop) and
/// removes the temp file (TempFile guard).
///
/// stdout is drained incrementally rather than via wait_with_output(): the CLI
/// emits the transcript token-by-token (measured: first byte 2.4s into a 6.5s
/// decode of an 82s clip; 7.7s into 31.7s for a 5.5min one), so partial text is
/// forwarded to the input-prompt window as it lands. This buys *visible
/// progress only* — the whole clip is still encoded before the first token, so
/// total latency and peak memory are unchanged; it is not streaming ASR (the
/// model is encoder-decoder and cannot be).
pub async fn transcribe_wav(app: Option<&tauri::AppHandle>, wav_bytes: &[u8]) -> Result<String> {
  transcribe_wav_inner(wav_bytes, |text| {
    let Some(app) = app else { return };
    // Broadcast, NOT emit_to: the frontend registers its listener with
    // target { kind: "Any" } (ipc-bridge.js), which only receives app.emit()
    // events. An emit_to("input-prompt", …) targets Webview("input-prompt") and
    // is silently dropped by an Any listener — every working event in this app
    // broadcasts. input-prompt is the only window listening for this, so a
    // broadcast is harmless.
    let _ = app.emit(
      "local-transcription-partial",
      serde_json::json!({ "text": text }),
    );
  })
  .await
}

/// The runner behind transcribe_wav. `on_partial` receives the transcript so
/// far as tokens land (throttled to PARTIAL_EMIT_INTERVAL, and only when the
/// text actually grew). Split out so tests can observe the streaming without
/// standing up an AppHandle.
async fn transcribe_wav_inner(
  wav_bytes: &[u8],
  mut on_partial: impl FnMut(&str),
) -> Result<String> {
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
  let mut child = local_asr_command(cli_path(&base))
    .arg("-m").arg(base.join(MODEL_ASSETS[0].rel_path))
    .arg("--mmproj").arg(base.join(MODEL_ASSETS[1].rel_path))
    .arg("--audio").arg(&tmp_path)
    // Each invocation performs real inference immediately and then exits.
    // llama.cpp's default dummy warmup is redundant here; on the Windows
    // i5-7400 test machine disabling it cut a 3.2 s clip from 5.40 s to 4.62 s.
    .arg("--no-warmup")
    .arg("-p").arg("a")
    .arg("-c").arg(ctx_size_for_wav(wav_bytes.len()).to_string())
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true)
    .spawn()
    .context("failed to start llama-mtmd-cli")?;

  let mut child_stdout = child.stdout.take().expect("stdout is piped");
  let mut child_stderr = child.stderr.take().expect("stderr is piped");

  // Shared progress state read by the hang watchdog below. The stdout loop
  // stamps `last_progress_ms` (millis since `started`) every time bytes land and
  // flips `seen_first_byte` on the first one; the watchdog turns a lack of
  // movement into an abort. Relaxed ordering is fine — these are advisory
  // liveness signals, not a synchronization protocol.
  let last_progress_ms = AtomicU64::new(0);
  let seen_first_byte = AtomicBool::new(false);
  let wav_len = wav_bytes.len();

  // Both pipes must be drained concurrently -- letting either fill blocks the
  // child. stdout additionally streams partial text out as it arrives.
  let pump = async {
    let stream_stdout = async {
      let mut acc: Vec<u8> = Vec::new();
      let mut buf = [0u8; 2048];
      let mut last_emit: Option<std::time::Instant> = None;
      let mut last_sent = 0usize;
      loop {
        let n = child_stdout.read(&mut buf).await?;
        if n == 0 {
          break;
        }
        seen_first_byte.store(true, Ordering::Relaxed);
        last_progress_ms.store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
        acc.extend_from_slice(&buf[..n]);
        if last_emit.is_some_and(|t| t.elapsed() < PARTIAL_EMIT_INTERVAL) {
          continue;
        }
        if let Some(text) = partial_text(&acc) {
          if text.len() != last_sent {
            last_sent = text.len();
            last_emit = Some(std::time::Instant::now());
            on_partial(&text);
          }
        }
      }
      Ok::<Vec<u8>, std::io::Error>(acc)
    };
    let drain_stderr = async {
      let mut acc = Vec::new();
      child_stderr.read_to_end(&mut acc).await?;
      Ok::<Vec<u8>, std::io::Error>(acc)
    };
    tokio::try_join!(stream_stdout, drain_stderr)
  };

  // Hang watchdog: a healthy decode either produces its first byte within the
  // clip-sized grace, or — once flowing — never pauses past NO_PROGRESS_TIMEOUT.
  // Detect a wedged CLI early instead of making the user wait out the flat
  // TRANSCRIBE_TIMEOUT (which stays as the outer hard cap). On a hung verdict we
  // return Err; the function returning drops `child` (kill_on_drop) and `_tmp`.
  let watchdog = async {
    loop {
      tokio::time::sleep(WATCHDOG_POLL).await;
      let since_start = started.elapsed();
      let since_progress =
        since_start.saturating_sub(Duration::from_millis(last_progress_ms.load(Ordering::Relaxed)));
      match stall_check(
        seen_first_byte.load(Ordering::Relaxed),
        since_start,
        since_progress,
        wav_len,
      ) {
        StallCheck::Ok => continue,
        StallCheck::HungBeforeFirstByte => {
          break anyhow::anyhow!(
            "local ASR produced no output within {}s for a {}s clip — treating as hung",
            first_byte_deadline(wav_len).as_secs(),
            wav_len.saturating_sub(44) / 32000
          );
        }
        StallCheck::HungMidDecode => {
          break anyhow::anyhow!(
            "local ASR stalled mid-decode (no progress for {}s) — treating as hung",
            NO_PROGRESS_TIMEOUT.as_secs()
          );
        }
      }
    }
  };

  let (stdout_bytes, stderr_bytes) = tokio::select! {
    pumped = tokio::time::timeout(TRANSCRIBE_TIMEOUT, pump) => pumped
      .map_err(|_| anyhow::anyhow!("local ASR timed out after {}s", TRANSCRIBE_TIMEOUT.as_secs()))?
      .context("failed to read llama-mtmd-cli output")?,
    hung = watchdog => return Err(hung),
  };
  let status = child.wait().await.context("failed to run llama-mtmd-cli")?;

  if !status.success() {
    let stderr = String::from_utf8_lossy(&stderr_bytes);
    let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
    // After dynamic ctx sizing (see CTX_CAP), a decode failure almost always
    // means the clip still exceeded the KV-cache cap. Translate the raw llama
    // error ("failed to decode audio"/"failed to decode token") into something
    // the user can act on instead of surfacing the CLI's internals.
    if stderr.contains("failed to decode") {
      let secs = wav_bytes.len().saturating_sub(44) / 32000;
      anyhow::bail!(
        "Recording is too long for the on-device model ({secs}s). Keep local dictation under ~13 minutes, or switch to a cloud provider in Settings for long recordings."
      );
    }
    anyhow::bail!("llama-mtmd-cli failed ({status}): {last}");
  }

  let text = parse_mtmd_output(&String::from_utf8_lossy(&stdout_bytes));
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

/// Extract the archive into bin/<LLAMA_BUILD>/, flattening every entry to its
/// basename, and mark extracted files executable on unix (the CLI needs it; the
/// bundled dylibs don't care). Flattening keeps us independent of the archive's
/// top-level folder naming across llama.cpp releases -- adjust ONLY if the
/// Task-3 Step-1 rpath check demanded preserved structure.
///
/// Symlinks MUST be recreated, not skipped: macOS/Linux llama.cpp ships each
/// versioned dylib/.so as a real file (libX.0.0.9960.dylib) PLUS a compatibility
/// symlink (libX.0.dylib) that is the install-name the executables link against.
/// Dropping those symlinks (the pre-2026-07 bug: `!is_file() { continue }` ate
/// them) left dyld unable to resolve @rpath/libX.0.dylib, so llama-mtmd-cli
/// SIGABRT'd on the FIRST clean download. It hid in dev because that machine's
/// bin/ had been laid out by a manual `tar` extraction, which keeps symlinks.
///
/// macOS/Linux releases are gzip-compressed tarballs; Windows releases are a
/// real zip (Task 2 finding) -- so the two platforms use different crates.
#[cfg(unix)]
fn extract_llama_archive(base: &Path) -> Result<(), String> {
  use std::os::unix::fs::PermissionsExt;
  let archive_path = base.join(llama_zip_asset().rel_path);
  let out_dir = bin_dir(base);
  fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
  let file = fs::File::open(&archive_path).map_err(|e| e.to_string())?;
  let gz = flate2::read::GzDecoder::new(file);
  let mut archive = tar::Archive::new(gz);
  for entry in archive.entries().map_err(|e| e.to_string())? {
    let mut entry = entry.map_err(|e| e.to_string())?;
    let entry_type = entry.header().entry_type();
    let entry_path = entry.path().map_err(|e| e.to_string())?.into_owned();
    let Some(name) = entry_path.file_name().map(|n| n.to_owned()) else { continue };
    let out_path = out_dir.join(&name);

    // Compat symlink (libX.0.dylib -> libX.0.0.9960.dylib): recreate it,
    // flattening the target to a basename to match our same-dir flattened
    // layout (llama's targets are already same-dir). Creating it before the
    // target file lands is fine -- a dangling symlink resolves once the real
    // file is written later in this same loop.
    if entry_type.is_symlink() {
      if let Some(target) = entry
        .link_name()
        .map_err(|e| e.to_string())?
        .and_then(|t| t.file_name().map(|n| n.to_owned()))
      {
        let _ = fs::remove_file(&out_path); // replace any stale entry
        std::os::unix::fs::symlink(&target, &out_path).map_err(|e| e.to_string())?;
      }
      continue;
    }
    if !entry_type.is_file() {
      continue;
    }
    let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
    std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
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
  fn partial_text_waits_for_the_marker_then_tracks_the_tail() {
    // Nothing to show until the marker lands: the `language <lang>` prefix is
    // chat-template noise, not transcript.
    assert_eq!(partial_text(b"\nlangua"), None);
    assert_eq!(partial_text(b"\nlanguage Chinese"), None);
    // Marker present but no tokens yet -> empty, not None.
    assert_eq!(partial_text("\nlanguage Chinese<asr_text>".as_bytes()), Some(String::new()));
    // Tokens arriving.
    assert_eq!(
      partial_text("\nlanguage Chinese<asr_text>今天我想".as_bytes()),
      Some("今天我想".into())
    );
    // A read can split a multi-byte char; the partial tail must be dropped
    // rather than surfaced as U+FFFD garbage in the UI.
    let full = "\nlanguage Chinese<asr_text>今天".as_bytes();
    let truncated = &full[..full.len() - 1]; // chop one byte off 天
    assert_eq!(partial_text(truncated), Some("今".into()));
  }

  #[test]
  fn ctx_scales_with_clip_length_within_bounds() {
    // 16 kHz mono 16-bit WAV = 32000 bytes/s after a 44-byte header.
    let wav = |secs: f64| 44 + (secs * 32000.0) as usize;
    // Short clips stay at the floor (== the old fixed 2048), so their memory
    // footprint is unchanged; empty/sub-header input must not underflow.
    assert_eq!(ctx_size_for_wav(wav(1.0)), CTX_FLOOR);
    assert_eq!(ctx_size_for_wav(wav(60.0)), CTX_FLOOR); // 60*20+512=1712 < floor
    assert_eq!(ctx_size_for_wav(0), CTX_FLOOR);
    assert_eq!(ctx_size_for_wav(10), CTX_FLOOR); // shorter than the WAV header
    // ~135 s failed at the old fixed 2048; the formula lifts it clear (verified
    // end-to-end: 135 s–300 s clips that failed at 2048 decode cleanly here).
    assert_eq!(ctx_size_for_wav(wav(135.0)), 135 * 20 + 512);
    assert!(ctx_size_for_wav(wav(135.0)) > CTX_FLOOR);
    // A pathological clip clamps to the cap rather than ballooning the KV cache.
    assert_eq!(ctx_size_for_wav(wav(900.0)), CTX_CAP); // 900*20+512 > cap
  }

  #[test]
  fn first_byte_deadline_scales_with_clip_length_over_a_base() {
    // 16 kHz mono 16-bit WAV = 32000 bytes/s after a 44-byte header.
    let wav = |secs: f64| 44 + (secs * 32000.0) as usize;
    // Empty / sub-header input must not underflow — just the base.
    assert_eq!(first_byte_deadline(0), FIRST_BYTE_BASE);
    assert_eq!(first_byte_deadline(10), FIRST_BYTE_BASE); // shorter than the header
    // Base + 0.1 s per audio-second. Measured first byte was 2.4 s for an 82 s
    // clip and 7.7 s for a 5.5 min one, so these deadlines keep ~5-10x margin.
    assert_eq!(first_byte_deadline(wav(82.0)), FIRST_BYTE_BASE + Duration::from_millis(8200));
    assert_eq!(first_byte_deadline(wav(330.0)), FIRST_BYTE_BASE + Duration::from_millis(33000));
    // Longer clip => longer grace, and it stays under the hard cap.
    assert!(first_byte_deadline(wav(780.0)) > first_byte_deadline(wav(82.0)));
    assert!(first_byte_deadline(wav(780.0)) < TRANSCRIBE_TIMEOUT);
  }

  #[test]
  fn stall_check_flags_a_missing_first_byte_past_the_clip_grace() {
    let wav = |secs: f64| 44 + (secs * 32000.0) as usize;
    let clip = wav(82.0);
    let grace = first_byte_deadline(clip); // 23.2 s
    // Before the grace elapses, a silent process is still just encoding.
    assert_eq!(
      stall_check(false, grace - Duration::from_secs(1), grace - Duration::from_secs(1), clip),
      StallCheck::Ok
    );
    // Past the grace with still no byte -> wedged during encode.
    assert_eq!(
      stall_check(false, grace + Duration::from_secs(1), grace + Duration::from_secs(1), clip),
      StallCheck::HungBeforeFirstByte
    );
  }

  #[test]
  fn stall_check_flags_a_stalled_decode_after_first_byte() {
    let clip = 44 + 82 * 32000;
    // Tokens flowing recently -> Ok, regardless of total elapsed.
    assert_eq!(
      stall_check(true, Duration::from_secs(300), NO_PROGRESS_TIMEOUT - Duration::from_secs(1), clip),
      StallCheck::Ok
    );
    // Silent past the no-progress window -> wedged mid-decode.
    assert_eq!(
      stall_check(true, Duration::from_secs(300), NO_PROGRESS_TIMEOUT + Duration::from_secs(1), clip),
      StallCheck::HungMidDecode
    );
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

  // Regression for the fresh-download SIGABRT: the tar extractor used to drop
  // the versioned-dylib compatibility symlinks, so dyld could not resolve
  // @rpath/libX.0.dylib and llama-mtmd-cli aborted on every clean download.
  #[cfg(unix)]
  #[test]
  fn extract_recreates_dylib_symlinks() {
    use flate2::{write::GzEncoder, Compression};

    let temp = tempfile::TempDir::new().unwrap();
    let base = temp.path();
    let archive_path = base.join(llama_zip_asset().rel_path);
    fs::create_dir_all(archive_path.parent().unwrap_or(base)).unwrap();

    // A .tar.gz mimicking llama's macOS layout under a top-level folder (to
    // exercise basename-flattening): real versioned dylib + compat symlink + CLI.
    {
      let gz = GzEncoder::new(fs::File::create(&archive_path).unwrap(), Compression::fast());
      let mut b = tar::Builder::new(gz);

      let real = b"real-dylib-bytes";
      let mut h = tar::Header::new_gnu();
      h.set_entry_type(tar::EntryType::Regular);
      h.set_size(real.len() as u64);
      h.set_mode(0o644);
      b.append_data(&mut h, "llama/build/bin/libllama-common.0.0.9960.dylib", &real[..]).unwrap();

      let mut h = tar::Header::new_gnu();
      h.set_entry_type(tar::EntryType::Symlink);
      h.set_size(0);
      h.set_mode(0o777);
      b.append_link(&mut h, "llama/build/bin/libllama-common.0.dylib", "libllama-common.0.0.9960.dylib")
        .unwrap();

      let cli = b"#!/bin/sh\n";
      let mut h = tar::Header::new_gnu();
      h.set_entry_type(tar::EntryType::Regular);
      h.set_size(cli.len() as u64);
      h.set_mode(0o755);
      b.append_data(&mut h, "llama/build/bin/llama-mtmd-cli", &cli[..]).unwrap();

      b.into_inner().unwrap().finish().unwrap();
    }

    extract_llama_archive(base).unwrap();

    let link = bin_dir(base).join("libllama-common.0.dylib");
    assert!(
      fs::symlink_metadata(&link).unwrap().file_type().is_symlink(),
      "compat symlink must be recreated, not skipped"
    );
    assert_eq!(
      fs::read(&link).unwrap(),
      b"real-dylib-bytes",
      "symlink must resolve to the real versioned dylib"
    );
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
    let text = rt.block_on(transcribe_wav(None, &wav)).expect("subprocess ok");
    assert_eq!(text, "", "silence must yield empty text");
    // Temp file cleaned up:
    let leftovers = fs::read_dir(std::env::temp_dir()).unwrap()
      .filter_map(|e| e.ok())
      .filter(|e| e.file_name().to_string_lossy().starts_with("saytype-asr-"))
      .count();
    assert_eq!(leftovers, 0, "temp wav files must be removed");
  }
}
