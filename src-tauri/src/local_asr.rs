//! Local Qwen3-ASR backend (provider "local"): on-demand assets (2 GGUF files
//! + a pinned llama.cpp release binary), resumable downloads, and
//! inference via llama-mtmd-cli. The CLI's chat mode keeps one worker warm for
//! a short idle window; a one-shot subprocess remains the compatibility
//! fallback. See docs/superpowers/specs/2026-07-12-local-asr-qwen3-design.md.
use anyhow::{Context, Result};
use serde::Serialize;
use sha2::Digest;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub const LOCAL_PROVIDER: &str = "local";
pub const QWEN_MODEL_ID: &str = "qwen3-asr-0.6b-q8_0";
pub const NEMOTRON_MODEL_ID: &str = "nemotron-3.5-asr-streaming-0.6b-q8_0";

pub fn normalize_local_model_id(model: &str) -> &'static str {
  match model.trim() {
    NEMOTRON_MODEL_ID => NEMOTRON_MODEL_ID,
    _ => QWEN_MODEL_ID,
  }
}
/// Pinned llama.cpp release. Must stay ≥ b9173 (Qwen3-ASR repetition fix,
/// ggml-org/llama.cpp#22357). Upgrading requires re-verifying CLI flags,
/// stdout format, all sha256s, and a real-dictation regression.
// The patched runtime is per-platform: a platform joins this list only after
// its archive passes the two-audio resident regression (vendor/llama.cpp/README.md).
#[cfg(any(
  all(target_os = "macos", target_arch = "aarch64"),
  all(target_os = "windows", target_arch = "x86_64")
))]
pub const LLAMA_BUILD: &str = "b9960-saytype-reset-v1";
#[cfg(not(any(
  all(target_os = "macos", target_arch = "aarch64"),
  all(target_os = "windows", target_arch = "x86_64")
)))]
pub const LLAMA_BUILD: &str = "b9960";

/// Upstream b9960 keeps an mtmd media batch past the lifetime of its chunks,
/// which can reuse the previous audio embedding in a resident process — on
/// Windows it crashed the worker outright on the third alternating clip. Only
/// the maintained runtimes carry the per-audio ownership patch, so this must
/// track LLAMA_BUILD's patched set exactly: a platform pointed at upstream
/// b9960 has to keep retiring its worker after every decode.
#[cfg(any(
  all(target_os = "macos", target_arch = "aarch64"),
  all(target_os = "windows", target_arch = "x86_64")
))]
const RESIDENT_RUNTIME_SAFE: bool = true;
#[cfg(not(any(
  all(target_os = "macos", target_arch = "aarch64"),
  all(target_os = "windows", target_arch = "x86_64")
)))]
const RESIDENT_RUNTIME_SAFE: bool = false;

pub struct Asset {
  /// Final location under local_asr_dir(); doubles as the download's .part
  /// sibling name. Forward slashes are fine in PathBuf::join on Windows.
  pub rel_path: &'static str,
  /// Try in order (mirror fallback); byte-identical across sources.
  pub urls: &'static [&'static str],
  /// A runtime carried inside the app instead of fetched from the network.
  pub bundled: Option<&'static [u8]>,
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
    bundled: None,
    size: 804_749_248,
    sha256: "bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971",
  },
  Asset {
    rel_path: "models/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
    urls: &[
      "https://modelscope.cn/models/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/master/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
      "https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/main/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
    ],
    bundled: None,
    size: 214_392_480,
    sha256: "41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d",
  },
];

// One llama.cpp archive per platform; only the current platform's entry is
// used. macOS/Linux releases are gzip-compressed tarballs, Windows is a real
// zip -- rel_path/urls reflect each asset's actual file extension.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
static MAC_ZIP: Asset = Asset {
  rel_path: "llama-b9960-saytype-reset-v1-bin-macos-arm64.tar.gz",
  urls: &[],
  bundled: Some(include_bytes!(
    "../resources/local-asr/llama-b9960-saytype-reset-v1-bin-macos-arm64.tar.gz"
  )),
  size: 3_709_958,
  sha256: "adc9efc6ea408e9e708e193efc26ce0914f5fdc4ecd6c2d7de1bbd9cc65885ef",
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
  bundled: None,
  size: 11_007_527,
  sha256: "d42000ae003fd61d7db50997af0e80f421524e30b534856c66573d064a478c1d",
};
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
pub fn llama_zip_asset() -> &'static Asset {
  &MAC_ZIP
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
static WIN_ZIP: Asset = Asset {
  rel_path: "llama-b9960-saytype-reset-v1-bin-windows-x64.zip",
  urls: &[],
  bundled: Some(include_bytes!(
    "../resources/local-asr/llama-b9960-saytype-reset-v1-bin-windows-x64.zip"
  )),
  size: 3_751_460,
  sha256: "78b767a628f6ba31acd58916f76700415f4406d27ecf2fcd6428be3d1dc5c54e",
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
  bundled: None,
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

fn remove_legacy_dir(path: &Path) -> Result<()> {
  match fs::remove_dir_all(path) {
    Ok(()) => {
      log::info!("local-asr: removed legacy assets at {}", path.display());
      Ok(())
    }
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(error)
      .with_context(|| format!("failed to remove legacy assets at {}", path.display())),
  }
}

fn cleanup_legacy_assets_at(app_data: &Path) -> Result<()> {
  // The pre-GGUF spike stored three ONNX graphs here. No current code reads
  // this exact directory; leaving it behind costs roughly another model copy.
  remove_legacy_dir(&app_data.join("models/qwen3-asr-0.6b-int8"))?;

  // Apple Silicon moved from the unpatched upstream runtime to a request-local
  // build. On platforms where b9960 is still current, keep it untouched.
  if LLAMA_BUILD != "b9960" {
    remove_legacy_dir(&app_data.join("local-asr/bin/b9960"))?;
  }
  Ok(())
}

pub fn cleanup_legacy_assets() -> Result<()> {
  cleanup_legacy_assets_at(&crate::settings::app_data_dir()?)
}

pub fn bin_dir(base: &Path) -> PathBuf {
  base.join("bin").join(LLAMA_BUILD)
}

pub fn cli_path(base: &Path) -> PathBuf {
  let name = if cfg!(target_os = "windows") { "llama-mtmd-cli.exe" } else { "llama-mtmd-cli" };
  bin_dir(base).join(name)
}

/// Records which bundled/downloaded archive produced the extracted runtime.
/// The CLI merely being present is not proof it is the *current* one: a runtime
/// id can be rebuilt in place (b9960-saytype-reset-v1 shipped once with a
/// machine-specific rpath that died with the build directory), and without this
/// stamp a stale extraction would survive the very update that fixes it.
fn runtime_stamp_path(base: &Path) -> PathBuf {
  bin_dir(base).join(".saytype-runtime-sha256")
}

fn write_runtime_stamp(base: &Path) {
  let _ = fs::write(runtime_stamp_path(base), llama_zip_asset().sha256);
}

fn installed_runtime_is_current(base: &Path) -> bool {
  let cli = cli_path(base);
  fs::metadata(&cli).map(|m| m.is_file()).unwrap_or(false)
    && is_executable(&cli)
    && fs::read_to_string(runtime_stamp_path(base))
      .map(|stamp| stamp.trim() == llama_zip_asset().sha256)
      .unwrap_or(false)
}

fn models_ready_at(dir: &Path) -> bool {
  MODEL_ASSETS.iter().all(|a| {
    fs::metadata(dir.join(a.rel_path)).map(|m| m.len() == a.size).unwrap_or(false)
  })
}

fn local_asr_command(program: PathBuf) -> tokio::process::Command {
  let command = tokio::process::Command::new(program);
  #[cfg(target_os = "windows")]
  {
    let mut command = command;
    // llama-mtmd-cli is a console executable. Without CREATE_NO_WINDOW,
    // Windows opens a terminal for every transcription and may steal focus
    // from the app that should receive the resulting text.
    command.creation_flags(0x0800_0000);
    command
  }
  #[cfg(not(target_os = "windows"))]
  {
    command
  }
}

/// Cheap readiness: every GGUF at its exact size, plus the extracted CLI
/// present (executable on unix). sha256 is verified once at download time.
pub fn assets_ready_at(dir: &Path) -> bool {
  let models_ok = models_ready_at(dir);
  let cli = cli_path(dir);
  let cli_ok = fs::metadata(&cli).map(|m| m.is_file()).unwrap_or(false)
    && is_executable(&cli);
  models_ok && cli_ok
}

pub fn assets_ready() -> bool {
  local_asr_dir()
    .map(|d| {
      if let Err(error) = ensure_bundled_runtime_at(&d) {
        log::warn!("failed to install bundled local ASR runtime: {error}");
      }
      assets_ready_at(&d)
    })
    .unwrap_or(false)
}

#[cfg(test)]
pub fn assets_ready_for_at(dir: &Path, model: &str) -> bool {
  match normalize_local_model_id(model) {
    NEMOTRON_MODEL_ID => crate::nemotron_asr::assets_ready_at(dir),
    _ => assets_ready_at(dir),
  }
}

pub fn assets_ready_for(model: &str) -> bool {
  match normalize_local_model_id(model) {
    NEMOTRON_MODEL_ID => crate::nemotron_asr::assets_ready(),
    _ => assets_ready(),
  }
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
// The per-decode watchdog is not an end-to-end deadline: a request can wait
// for a permit, start a worker, retry one-shot and then wait for child exit.
// Leave room for both existing decode budgets, but bound the whole request.
const PIPELINE_TIMEOUT: Duration = Duration::from_secs(420);
const PREWARM_TIMEOUT: Duration = Duration::from_secs(30);

struct PipelineProgress {
  operation: &'static str,
  session_id: Option<u64>,
  chunk_index: Option<u32>,
  started: std::time::Instant,
  phase: Mutex<(&'static str, std::time::Instant)>,
  finished: AtomicBool,
}

impl PipelineProgress {
  fn new(operation: &'static str, session_id: Option<u64>, chunk_index: Option<u32>) -> Self {
    let now = std::time::Instant::now();
    let progress = Self {
      operation,
      session_id,
      chunk_index,
      started: now,
      phase: Mutex::new(("inference-queue", now)),
      finished: AtomicBool::new(false),
    };
    progress.report("start", log::Level::Info);
    progress
  }

  fn enter(&self, phase: &'static str) {
    let now = std::time::Instant::now();
    let (previous_phase, entered) = {
      let mut current = self.phase.lock().unwrap_or_else(|error| error.into_inner());
      let previous = *current;
      *current = (phase, now);
      previous
    };
    // One transition retains both the new wait and the previous stage's
    // duration, without doubling the release log volume at each boundary.
    log::info!(
      target: "saytype_lifecycle",
      "native operation={} session_id={:?} chunk_index={:?} phase={} event=start previous_phase={} previous_elapsed_ms={} total_ms={}",
      self.operation, self.session_id, self.chunk_index, phase, previous_phase,
      now.duration_since(entered).as_millis(), self.started.elapsed().as_millis()
    );
  }

  fn report(&self, event: &'static str, level: log::Level) {
    let (phase, entered) = *self.phase.lock().unwrap_or_else(|error| error.into_inner());
    log::log!(
      target: "saytype_lifecycle",
      level,
      "native operation={} session_id={:?} chunk_index={:?} phase={} event={} elapsed_ms={} total_ms={}",
      self.operation, self.session_id, self.chunk_index, phase, event,
      entered.elapsed().as_millis(), self.started.elapsed().as_millis()
    );
  }
}

impl Drop for PipelineProgress {
  fn drop(&mut self) {
    if !self.finished.load(Ordering::Relaxed) {
      // The command's CancellationToken drops this future directly. Persist
      // that path too, without logging audio or exception/transcript strings.
      if std::thread::panicking() {
        self.report("panic", log::Level::Warn);
      } else {
        self.report("cancel", log::Level::Info);
      }
    }
  }
}

async fn with_pipeline_deadline<T>(
  future: impl std::future::Future<Output = Result<T>>,
  deadline: Duration,
  progress: &PipelineProgress,
) -> Result<T> {
  let result = match tokio::time::timeout(deadline, future).await {
    Ok(result) => {
      progress.report(if result.is_ok() { "complete" } else { "error" },
        if result.is_ok() { log::Level::Info } else { log::Level::Warn });
      result
    }
    Err(_) => {
      progress.report("timeout", log::Level::Warn);
      let phase = progress.phase.lock().unwrap_or_else(|error| error.into_inner()).0;
      Err(anyhow::anyhow!("local ASR {} timed out during {} after {}ms", progress.operation, phase, deadline.as_millis()))
    }
  };
  progress.finished.store(true, Ordering::Relaxed);
  result
}
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
/// `TRANSCRIBE_TIMEOUT` remains the per-attempt cap; `PIPELINE_TIMEOUT` also
/// covers queue acquisition, initialization, fallback and process teardown.
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

/// Skip llama.cpp's per-process device-memory fitting pass. SayType already
/// supplies a bounded context size, and real-device benchmarks show that
/// re-running the automatic fit calculation on every short transcription adds
/// measurable latency without changing output or peak memory.
const FIT_ARGS: &[&str] = &["--fit", "off"];

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
/// llama-mtmd-cli maps roughly 1.3-1.9 GiB per decode. Keep all local entry
/// points single-flight so overlapping hotkeys and History retries cannot
/// multiply that memory or contend for the same Metal device. Cloud requests
/// do not pass through this module and remain concurrent.
static LOCAL_INFERENCE: Semaphore = Semaphore::const_new(1);
static RESIDENT_WORKER: Mutex<Option<ResidentWorker>> = Mutex::new(None);
static RESIDENT_GENERATION: AtomicU64 = AtomicU64::new(0);
static RESIDENT_EPOCH: AtomicU64 = AtomicU64::new(0);
static BUNDLED_RUNTIME_INSTALL: Mutex<()> = Mutex::new(());
#[cfg(test)]
static RESIDENT_STARTS: AtomicU64 = AtomicU64::new(0);

/// Keep the ~1.3 GiB worker only long enough to cover normal back-to-back
/// dictation. This preserves the old near-zero idle footprint after a pause.
#[cfg(not(test))]
const RESIDENT_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(test)]
const RESIDENT_IDLE_TIMEOUT: Duration = Duration::from_millis(100);
/// A preloaded worker must survive until the frontend's 75 s hard chunk cut.
/// Once it serves a decode, the normal shorter idle timeout applies again.
const PREWARM_IDLE_TIMEOUT: Duration = Duration::from_secs(80);
const CHAT_PROMPT: &[u8] = b"\n> ";

struct ResidentWorker {
  child: Child,
  stdin: ChildStdin,
  stdout: ChildStdout,
  ctx_size: u32,
  generation: u64,
  epoch: u64,
}

impl ResidentWorker {
  async fn spawn(base: &Path, ctx_size: u32) -> Result<Self> {
    let mut child = local_asr_command(cli_path(base))
      .arg("-m").arg(base.join(MODEL_ASSETS[0].rel_path))
      .arg("--mmproj").arg(base.join(MODEL_ASSETS[1].rel_path))
      .arg("--no-warmup")
      .args(FIT_ARGS)
      .arg("-c").arg(ctx_size.to_string())
      // With no --audio and no prompt, mtmd enters chat mode and accepts a
      // sequence of `/audio <path>` commands while keeping both models loaded.
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      // Chat-mode stderr is verbose enough to fill a pipe over a long session;
      // one-shot fallback below retains detailed stderr for error reporting.
      .stderr(Stdio::null())
      .kill_on_drop(true)
      .spawn()
      .context("failed to start resident llama-mtmd-cli")?;
    let stdin = child.stdin.take().expect("stdin is piped");
    let mut stdout = child.stdout.take().expect("stdout is piped");
    read_chat_response(&mut stdout, 0, false, |_| {}).await
      .context("resident llama-mtmd-cli did not reach its initial prompt")?;
    #[cfg(test)]
    RESIDENT_STARTS.fetch_add(1, Ordering::Relaxed);
    Ok(Self {
      child,
      stdin,
      stdout,
      ctx_size,
      generation: 0,
      epoch: RESIDENT_EPOCH.load(Ordering::Relaxed),
    })
  }

  fn is_running(&mut self) -> bool {
    matches!(self.child.try_wait(), Ok(None))
  }

  async fn transcribe(
    &mut self,
    audio_path: &Path,
    wav_len: usize,
    on_partial: &mut impl FnMut(&str),
  ) -> Result<String> {
    let audio_path_text = audio_path.to_string_lossy();
    if audio_path_text.contains('\n') || audio_path_text.contains('\r') {
      anyhow::bail!("temporary audio path contains a newline");
    }

    self.stdin.write_all(b"/clear\n").await?;
    self.stdin.flush().await?;
    read_chat_response(&mut self.stdout, 0, false, |_| {}).await
      .context("resident worker did not clear its previous conversation")?;

    self.stdin
      .write_all(format!("/audio {}\n", audio_path.display()).as_bytes())
      .await?;
    self.stdin.flush().await?;
    let loaded = read_chat_response(&mut self.stdout, 0, false, |_| {}).await
      .context("resident worker did not load the audio")?;
    if !String::from_utf8_lossy(&loaded).contains("audio loaded") {
      anyhow::bail!("resident worker rejected the audio file");
    }

    self.stdin.write_all(b"a\n").await?;
    self.stdin.flush().await?;
    let response = read_chat_response(&mut self.stdout, wav_len, true, on_partial).await?;
    let output = String::from_utf8_lossy(&response);
    if !output.contains("<asr_text>") {
      anyhow::bail!("resident worker returned no ASR marker");
    }
    Ok(parse_mtmd_output(&output))
  }
}

/// Read one chat-mode response, ending at the next prompt. For an inference
/// response, stream text after `<asr_text>` while retaining the existing
/// first-token and no-progress watchdog semantics.
async fn read_chat_response(
  stdout: &mut ChildStdout,
  wav_len: usize,
  stream_partials: bool,
  mut on_partial: impl FnMut(&str),
) -> Result<Vec<u8>> {
  let started = std::time::Instant::now();
  let mut last_progress = started;
  let mut acc = Vec::new();
  let mut buf = [0u8; 2048];
  let mut seen_asr_marker = false;
  let mut last_emit: Option<std::time::Instant> = None;
  let mut last_sent = 0usize;

  loop {
    let allowed_gap = if seen_asr_marker {
      NO_PROGRESS_TIMEOUT
    } else {
      first_byte_deadline(wav_len)
    };
    let elapsed = if seen_asr_marker {
      last_progress.elapsed()
    } else {
      started.elapsed()
    };
    let remaining = allowed_gap.saturating_sub(elapsed);
    if remaining.is_zero() {
      if seen_asr_marker {
        anyhow::bail!(
          "local ASR stalled mid-decode (no progress for {}s) — treating as hung",
          NO_PROGRESS_TIMEOUT.as_secs()
        );
      }
      anyhow::bail!(
        "local ASR produced no output within {}s for a {}s clip — treating as hung",
        first_byte_deadline(wav_len).as_secs(),
        wav_len.saturating_sub(44) / 32000
      );
    }

    let n = tokio::time::timeout(remaining, stdout.read(&mut buf))
      .await
      .map_err(|_| anyhow::anyhow!("resident local ASR response timed out"))?
      .context("failed to read resident llama-mtmd-cli output")?;
    if n == 0 {
      anyhow::bail!("resident llama-mtmd-cli exited unexpectedly");
    }
    last_progress = std::time::Instant::now();
    acc.extend_from_slice(&buf[..n]);
    seen_asr_marker |= acc.windows("<asr_text>".len()).any(|w| w == b"<asr_text>");

    if acc.ends_with(CHAT_PROMPT) {
      acc.truncate(acc.len() - CHAT_PROMPT.len());
      if stream_partials {
        if let Some(text) = partial_text(&acc) {
          if text.len() != last_sent {
            on_partial(&text);
          }
        }
      }
      return Ok(acc);
    }

    if stream_partials && seen_asr_marker
      && !last_emit.is_some_and(|t| t.elapsed() < PARTIAL_EMIT_INTERVAL)
    {
      if let Some(text) = partial_text(&acc) {
        if text.len() != last_sent {
          last_sent = text.len();
          last_emit = Some(std::time::Instant::now());
          on_partial(&text);
        }
      }
    }
  }
}

fn retire_resident_worker(generation: Option<u64>) {
  let mut slot = RESIDENT_WORKER.lock().unwrap();
  let retire = slot
    .as_ref()
    .is_some_and(|worker| generation.is_none() || generation == Some(worker.generation));
  if retire {
    if let Some(mut worker) = slot.take() {
      let _ = worker.child.start_kill();
    }
  }
}

/// Stop the warm local worker when SayType exits, switches away from local, or
/// removes the model files.
pub fn shutdown_resident_worker() {
  // Invalidate a worker currently checked out for inference as well as one in
  // the idle cache. A checked-out worker observes the new epoch in park() and
  // kills itself instead of becoming resident again.
  RESIDENT_EPOCH.fetch_add(1, Ordering::Relaxed);
  retire_resident_worker(None);
}

fn schedule_resident_retirement(generation: u64, idle_timeout: Duration) {
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(idle_timeout).await;
    retire_resident_worker(Some(generation));
  });
}

/// Extend the idle deadline when a new local dictation starts recording. This
/// is deliberately a no-op when no worker is already warm: pressing the hotkey
/// should not allocate ~1.3 GiB before the user has completed any audio.
pub fn keep_resident_worker_warm() -> bool {
  let generation = {
    let mut slot = RESIDENT_WORKER.lock().unwrap();
    let Some(worker) = slot.as_mut() else {
      return false;
    };
    if !worker.is_running() {
      slot.take();
      return false;
    }
    let generation = RESIDENT_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    worker.generation = generation;
    generation
  };
  schedule_resident_retirement(generation, RESIDENT_IDLE_TIMEOUT);
  true
}

fn park_resident_worker_for(mut worker: ResidentWorker, idle_timeout: Duration) {
  if !RESIDENT_RUNTIME_SAFE {
    let _ = worker.child.start_kill();
    return;
  }
  if worker.epoch != RESIDENT_EPOCH.load(Ordering::Relaxed) {
    let _ = worker.child.start_kill();
    return;
  }
  let generation = RESIDENT_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
  worker.generation = generation;
  *RESIDENT_WORKER.lock().unwrap() = Some(worker);
  schedule_resident_retirement(generation, idle_timeout);
}

fn park_resident_worker(worker: ResidentWorker) {
  park_resident_worker_for(worker, RESIDENT_IDLE_TIMEOUT);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentPrewarmOutcome {
  Unsupported,
  Ineligible,
  AssetsMissing,
  Reused,
  Spawned,
}

impl ResidentPrewarmOutcome {
  pub fn is_ready(self) -> bool {
    matches!(self, Self::Reused | Self::Spawned)
  }
}

/// Load the fixed short-dictation worker while recording is already underway.
/// The shared inference permit makes this single-flight with both decode and
/// other prewarm requests. Eligibility is rechecked after waiting for the
/// permit, so a provider/model switch cannot start a stale worker.
pub async fn prewarm_resident_worker(
  eligible: impl FnOnce() -> Result<bool>,
) -> Result<ResidentPrewarmOutcome> {
  let progress = PipelineProgress::new("prewarm", None, None);
  with_pipeline_deadline(prewarm_resident_worker_inner(eligible, &progress), PREWARM_TIMEOUT, &progress).await
}

async fn prewarm_resident_worker_inner(
  eligible: impl FnOnce() -> Result<bool>,
  progress: &PipelineProgress,
) -> Result<ResidentPrewarmOutcome> {
  if !RESIDENT_RUNTIME_SAFE {
    return Ok(ResidentPrewarmOutcome::Unsupported);
  }

  let queued_at = std::time::Instant::now();
  let _inference_permit = LOCAL_INFERENCE
    .acquire()
    .await
    .expect("local inference semaphore is never closed");
  let queue_ms = queued_at.elapsed().as_millis();
  let lease_epoch = RESIDENT_EPOCH.load(Ordering::Relaxed);
  progress.enter("prepare");

  if !eligible()? {
    log::info!("local-asr: prewarm outcome=ineligible queue_ms={queue_ms}");
    return Ok(ResidentPrewarmOutcome::Ineligible);
  }

  let base = local_asr_dir()?;
  ensure_bundled_runtime_at(&base).map_err(anyhow::Error::msg)?;
  if !assets_ready_at(&base) {
    log::info!("local-asr: prewarm outcome=assets_missing queue_ms={queue_ms}");
    return Ok(ResidentPrewarmOutcome::AssetsMissing);
  }

  let cached = RESIDENT_WORKER.lock().unwrap().take();
  if let Some(mut worker) = cached {
    if worker.ctx_size == CTX_FLOOR && worker.is_running() {
      worker.epoch = lease_epoch;
      park_resident_worker_for(worker, PREWARM_IDLE_TIMEOUT);
      log::info!(
        "local-asr: prewarm outcome=reused ctx={} queue_ms={} resident_spawn_ms=0 idle_ms={}",
        CTX_FLOOR,
        queue_ms,
        PREWARM_IDLE_TIMEOUT.as_millis()
      );
      return Ok(ResidentPrewarmOutcome::Reused);
    }
  }

  let spawn_started = std::time::Instant::now();
  progress.enter("worker-start");
  let mut worker = ResidentWorker::spawn(&base, CTX_FLOOR).await?;
  let resident_spawn_ms = spawn_started.elapsed().as_millis();
  worker.epoch = lease_epoch;
  park_resident_worker_for(worker, PREWARM_IDLE_TIMEOUT);
  log::info!(
    "local-asr: prewarm outcome=spawned ctx={} queue_ms={} resident_spawn_ms={} idle_ms={}",
    CTX_FLOOR,
    queue_ms,
    resident_spawn_ms,
    PREWARM_IDLE_TIMEOUT.as_millis()
  );
  Ok(ResidentPrewarmOutcome::Spawned)
}

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
fn partial_event_payload(
  session_id: Option<u64>,
  chunk_index: Option<u32>,
  text: &str,
) -> serde_json::Value {
  serde_json::json!({
    "sessionId": session_id,
    "chunkIndex": chunk_index,
    "text": text,
  })
}

/// `chunk_index` is `Some` only on the chunked long-audio path, where one
/// dictation decodes as an ordered series of ≤75 s chunks; the frontend routes
/// each partial to that chunk's slot so finalized chunks are not overwritten by
/// a later chunk's in-progress text. `None` means the whole clip is one decode.
pub async fn transcribe_wav(
  app: Option<&tauri::AppHandle>,
  session_id: Option<u64>,
  chunk_index: Option<u32>,
  wav_bytes: &[u8],
) -> Result<String> {
  let progress = PipelineProgress::new("decode", session_id, chunk_index);
  let inference = transcribe_wav_inner(session_id, chunk_index, wav_bytes, &progress, |text| {
    let Some(app) = app else { return };
    // Broadcast, NOT emit_to: the frontend registers its listener with
    // target { kind: "Any" } (ipc-bridge.js), which only receives app.emit()
    // events. An emit_to("input-prompt", …) targets Webview("input-prompt") and
    // is silently dropped by an Any listener — every working event in this app
    // broadcasts. input-prompt is the only window listening for this, so a
    // broadcast is harmless.
    let _ = app.emit(
      "local-transcription-partial",
      partial_event_payload(session_id, chunk_index, text),
    );
  });
  with_pipeline_deadline(inference, PIPELINE_TIMEOUT, &progress).await
}

/// The runner behind transcribe_wav. `on_partial` receives the transcript so
/// far as tokens land (throttled to PARTIAL_EMIT_INTERVAL, and only when the
/// text actually grew). Split out so tests can observe the streaming without
/// standing up an AppHandle.
async fn transcribe_wav_inner(
  session_id: Option<u64>,
  chunk_index: Option<u32>,
  wav_bytes: &[u8],
  progress: &PipelineProgress,
  mut on_partial: impl FnMut(&str),
) -> Result<String> {
  let lease_epoch = RESIDENT_EPOCH.load(Ordering::Relaxed);
  let queued_at = std::time::Instant::now();
  let _inference_permit = LOCAL_INFERENCE
    .acquire()
    .await
    .expect("local inference semaphore is never closed");
  let queue_time = queued_at.elapsed();
  progress.enter("prepare");
  if queue_time >= Duration::from_millis(10) {
    log::info!("local-asr: waited {} ms for inference slot", queue_time.as_millis());
  }
  let first_visible_partial_ms = AtomicU64::new(u64::MAX);
  let mut tracked_partial = |text: &str| {
    let elapsed_ms = queued_at.elapsed().as_millis() as u64;
    let _ = first_visible_partial_ms.compare_exchange(
      u64::MAX,
      elapsed_ms,
      Ordering::Relaxed,
      Ordering::Relaxed,
    );
    on_partial(text);
  };

  let base = local_asr_dir()?;
  ensure_bundled_runtime_at(&base).map_err(anyhow::Error::msg)?;
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

  let ctx_size = ctx_size_for_wav(wav_bytes.len());
  let cached = RESIDENT_WORKER.lock().unwrap().take();
  let (reusable, reuse_miss_reason) = match cached {
    None => (None, "cold"),
    Some(mut cached) => {
      if cached.ctx_size != ctx_size {
        (None, "ctx_mismatch")
      } else if !cached.is_running() {
        (None, "worker_exited")
      } else {
        (Some(cached), "none")
      }
    }
  };
  let worker_reused = reusable.is_some();
  let mut resident_spawn_ms = None;
  // A worker that never reaches its chat prompt must not fail the dictation:
  // fall through to the one-shot path, which captures the child's stderr and
  // so reports the real cause (a broken runtime install, an unreadable model)
  // instead of the opaque "did not reach its initial prompt".
  let started_worker = match reusable {
    Some(worker) => Some(worker),
    None => {
      progress.enter("worker-start");
      let spawn_started = std::time::Instant::now();
      let result = ResidentWorker::spawn(&base, ctx_size).await;
      resident_spawn_ms = Some(spawn_started.elapsed().as_millis());
      match result {
        Ok(worker) => Some(worker),
        Err(error) => {
          log::warn!("local-asr: resident worker could not start, falling back to one-shot: {error:#}");
          None
        }
      }
    }
  };

  if let Some(mut worker) = started_worker {
    progress.enter("resident-decode");
    worker.epoch = lease_epoch;
    let resident_started = std::time::Instant::now();
    match tokio::time::timeout(
      TRANSCRIBE_TIMEOUT,
      worker.transcribe(&tmp_path, wav_bytes.len(), &mut tracked_partial),
    ).await {
      Ok(Ok(text)) => {
        let resident_decode_ms = resident_started.elapsed().as_millis();
        progress.enter("park-worker");
        park_resident_worker(worker);
        let total_ms = queued_at.elapsed().as_millis();
        log::info!(
          "local-asr: decode mode=resident session_id={} chunk_index={} ctx={} worker_reused={} reuse_miss={} resident_spawn_ms={} queue_ms={} total_ms={} resident_decode_ms={} first_visible_partial_ms={} wav_kb={} chars={}",
          session_id.map_or_else(|| "none".into(), |value| value.to_string()),
          chunk_index.map_or_else(|| "none".into(), |value| value.to_string()),
          ctx_size,
          worker_reused,
          reuse_miss_reason,
          resident_spawn_ms.map_or_else(|| "0".into(), |value| value.to_string()),
          queue_time.as_millis(),
          total_ms,
          resident_decode_ms,
          match first_visible_partial_ms.load(Ordering::Relaxed) {
            u64::MAX => "none".into(),
            value => value.to_string(),
          },
          wav_bytes.len() / 1024,
          text.chars().count()
        );
        return Ok(text);
      }
      Ok(Err(error)) => {
        log::warn!("local-asr: resident worker failed, retrying one-shot: {error:#}");
      }
      Err(_) => {
        log::warn!(
          "local-asr: resident worker timed out after {}s, retrying one-shot",
          TRANSCRIBE_TIMEOUT.as_secs()
        );
      }
    }
    // `worker` is deliberately not returned to the cache after any protocol
    // failure. kill_on_drop terminates it so the one-shot retry starts clean.
    drop(worker);
  }

  // Compatibility fallback: preserve the original one-process-per-clip path
  // and its detailed stderr diagnostics if chat mode ever drifts in a future
  // pinned llama.cpp build.
  // This path has no ready prompt, so its phase timing intentionally includes
  // process start, model initialization, and decode as one `one_shot_ms` value.
  let started = std::time::Instant::now();
  progress.enter("one-shot-decode");
  let mut child = local_asr_command(cli_path(&base))
    .arg("-m").arg(base.join(MODEL_ASSETS[0].rel_path))
    .arg("--mmproj").arg(base.join(MODEL_ASSETS[1].rel_path))
    .arg("--audio").arg(&tmp_path)
    // Each invocation performs real inference immediately and then exits.
    // llama.cpp's default dummy warmup is redundant here; on the Windows
    // i5-7400 test machine disabling it cut a 3.2 s clip from 5.40 s to 4.62 s.
    .arg("--no-warmup")
    .args(FIT_ARGS)
    .arg("-p").arg("a")
    .arg("-c").arg(ctx_size.to_string())
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
            tracked_partial(&text);
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
  progress.enter("child-exit");
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
  let one_shot_ms = started.elapsed().as_millis();
  let total_ms = queued_at.elapsed().as_millis();
  // Counts only -- no transcribed text in logs.
  log::info!(
    "local-asr: decode mode=one_shot session_id={} chunk_index={} ctx={} worker_reused={} reuse_miss={} resident_spawn_ms={} queue_ms={} total_ms={} one_shot_ms={} first_visible_partial_ms={} wav_kb={} chars={}",
    session_id.map_or_else(|| "none".into(), |value| value.to_string()),
    chunk_index.map_or_else(|| "none".into(), |value| value.to_string()),
    ctx_size,
    worker_reused,
    reuse_miss_reason,
    resident_spawn_ms.map_or_else(|| "0".into(), |value| value.to_string()),
    queue_time.as_millis(),
    total_ms,
    one_shot_ms,
    match first_visible_partial_ms.load(Ordering::Relaxed) {
      u64::MAX => "none".into(),
      value => value.to_string(),
    },
    wav_bytes.len() / 1024,
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
    Ok(dir) => {
      if let Err(error) = ensure_bundled_runtime_at(&dir) {
        log::warn!("failed to install bundled local ASR runtime: {error}");
      }
      model_status_at(&dir, downloading)
    }
    Err(_) => ModelStatus {
      state: "absent".into(),
      downloaded_bytes: 0,
      total_bytes: total_download_bytes(),
    },
  }
}

fn ensure_bundled_runtime_at(dir: &Path) -> Result<(), String> {
  let asset = llama_zip_asset();
  let Some(bytes) = asset.bundled else { return Ok(()) };
  if !models_ready_at(dir) || installed_runtime_is_current(dir) {
    return Ok(());
  }

  let _install = BUNDLED_RUNTIME_INSTALL.lock().map_err(|e| e.to_string())?;
  if installed_runtime_is_current(dir) {
    return Ok(());
  }
  if bytes.len() as u64 != asset.size {
    return Err(format!("bundled runtime size mismatch: {} != {}", bytes.len(), asset.size));
  }
  let hash = format!("{:x}", sha2::Sha256::digest(bytes));
  if hash != asset.sha256 {
    return Err("bundled runtime sha256 mismatch".into());
  }

  let archive_path = dir.join(asset.rel_path);
  let part_path = dir.join(format!("{}.part", asset.rel_path));
  if let Some(parent) = archive_path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  fs::write(&part_path, bytes).map_err(|e| e.to_string())?;
  fs::rename(&part_path, &archive_path).map_err(|e| e.to_string())?;
  extract_llama_archive(dir)?;
  let _ = fs::remove_file(archive_path);
  Ok(())
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
      "model": QWEN_MODEL_ID,
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

  ensure_bundled_runtime_at(&dir)?;
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
  write_runtime_stamp(base);
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
  write_runtime_stamp(base);
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

/// Settings "delete model": stop the Qwen worker, then remove only Qwen files.
pub fn delete_model() -> Result<(), String> {
  shutdown_resident_worker();
  let dir = local_asr_dir().map_err(|e| e.to_string())?;
  for asset in MODEL_ASSETS.iter().chain(std::iter::once(llama_zip_asset())) {
    let _ = fs::remove_file(dir.join(asset.rel_path));
    let _ = fs::remove_file(dir.join(format!("{}.part", asset.rel_path)));
  }
  match fs::remove_dir_all(bin_dir(&dir)) {
    Ok(()) => Ok(()),
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(err) => Err(err.to_string()),
  }
}

pub fn model_status_for(model: &str, downloading: bool) -> ModelStatus {
  match normalize_local_model_id(model) {
    NEMOTRON_MODEL_ID => crate::nemotron_asr::model_status(downloading),
    _ => model_status(downloading),
  }
}

pub async fn download_model_for(
  model: &str,
  app: tauri::AppHandle,
  cancel: CancellationToken,
) -> Result<(), String> {
  match normalize_local_model_id(model) {
    NEMOTRON_MODEL_ID => crate::nemotron_asr::download_model(app, cancel).await,
    _ => download_model(app, cancel).await,
  }
}

pub fn delete_model_for(model: &str) -> Result<(), String> {
  match normalize_local_model_id(model) {
    NEMOTRON_MODEL_ID => crate::nemotron_asr::delete_model(),
    _ => delete_model(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn pipeline_phase_transition_emits_one_line_with_previous_duration() {
    struct CaptureLogger(Mutex<Vec<String>>);
    impl log::Log for CaptureLogger {
      fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.target() == "saytype_lifecycle"
      }
      fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
          let line = record.args().to_string();
          if line.contains("operation=transition-test ") {
            self.0.lock().unwrap().push(line);
          }
        }
      }
      fn flush(&self) {}
    }
    static LOGGER: CaptureLogger = CaptureLogger(Mutex::new(Vec::new()));
    log::set_logger(&LOGGER).expect("this test owns the process logger");
    log::set_max_level(log::LevelFilter::Info);
    let progress = PipelineProgress::new("transition-test", Some(77), Some(4));
    LOGGER.0.lock().unwrap().clear();
    progress.enter("resident-decode");
    progress.finished.store(true, Ordering::Relaxed);
    let lines = LOGGER.0.lock().unwrap().clone();
    assert_eq!(lines.len(), 1, "a phase change needs only one persisted event");
    assert!(lines[0].contains("phase=resident-decode event=start"));
    assert!(lines[0].contains("previous_phase=inference-queue"));
    assert!(lines[0].contains("previous_elapsed_ms="));
    assert!(lines[0].contains("total_ms="));
  }

  #[tokio::test]
  async fn pipeline_deadline_releases_a_slot_held_during_an_unbounded_wait() {
    let semaphore = Semaphore::new(1);
    let progress = PipelineProgress::new("decode", Some(7), Some(0));
    let result: Result<()> = with_pipeline_deadline(
      async {
        let _permit = semaphore.acquire().await.unwrap();
        progress.enter("child-exit");
        std::future::pending().await
      },
      Duration::from_millis(10),
      &progress,
    ).await;
    let message = result.unwrap_err().to_string();
    assert!(message.contains("timed out"));
    assert!(message.contains("child-exit"));
    assert_eq!(semaphore.available_permits(), 1);
  }

  #[tokio::test]
  async fn pipeline_deadline_covers_waiting_for_the_inference_slot() {
    let semaphore = Semaphore::new(1);
    let held = semaphore.acquire().await.unwrap();
    let progress = PipelineProgress::new("decode", Some(8), None);
    let result: Result<()> = with_pipeline_deadline(
      async {
        let _permit = semaphore.acquire().await.unwrap();
        Ok(())
      },
      Duration::from_millis(10),
      &progress,
    ).await;
    assert!(result.unwrap_err().to_string().contains("inference-queue"));
    drop(held);
    assert!(semaphore.try_acquire().is_ok());
  }

  #[tokio::test]
  async fn pipeline_deadline_preserves_success_and_ordinary_errors() {
    let progress = PipelineProgress::new("decode", Some(9), None);
    assert_eq!(with_pipeline_deadline(async { Ok(42) }, Duration::from_secs(1), &progress).await.unwrap(), 42);
    let progress = PipelineProgress::new("prewarm", None, None);
    let result: Result<()> = with_pipeline_deadline(
      async { anyhow::bail!("test failure") }, Duration::from_secs(1), &progress
    ).await;
    assert_eq!(result.unwrap_err().to_string(), "test failure");
  }

  #[cfg(unix)]
  #[tokio::test]
  async fn pipeline_deadline_cleans_up_when_child_outlives_both_pipes() {
    let directory = tempfile::TempDir::new().unwrap();
    let path = directory.path().join("request.wav");
    fs::write(&path, b"test audio").unwrap();
    let pid = std::sync::atomic::AtomicU32::new(0);
    let progress = PipelineProgress::new("decode", Some(10), Some(0));
    let result: Result<()> = with_pipeline_deadline(async {
      let _temp_file = TempFile(path.clone());
      let mut child = tokio::process::Command::new("/bin/sh")
        .args(["-c", "exec 1>&- 2>&-; exec sleep 60"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
      pid.store(child.id().unwrap(), Ordering::Relaxed);
      let mut stdout = child.stdout.take().unwrap();
      let mut stderr = child.stderr.take().unwrap();
      let mut out = Vec::new();
      let mut err = Vec::new();
      tokio::try_join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))?;
      progress.enter("child-exit");
      child.wait().await?;
      Ok(())
    }, Duration::from_secs(1), &progress).await;
    assert!(result.unwrap_err().to_string().contains("child-exit"));
    assert!(!path.exists(), "timing out removes the owned temporary audio");
    let child_pid = pid.load(Ordering::Relaxed).to_string();
    tokio::time::timeout(Duration::from_secs(2), async {
      loop {
        let alive = tokio::process::Command::new("/bin/kill")
          .args(["-0", &child_pid])
          .stdout(Stdio::null()).stderr(Stdio::null())
          .status().await.unwrap().success();
        if !alive { break; }
        tokio::time::sleep(Duration::from_millis(20)).await;
      }
    }).await.expect("kill_on_drop must terminate the child");
  }

  #[test]
  fn manifest_is_filled_and_totals_are_sane() {
    assert_eq!(MODEL_ASSETS.len(), 2);
    for a in MODEL_ASSETS.iter().chain(std::iter::once(llama_zip_asset())) {
      assert_eq!(a.sha256.len(), 64, "{} sha256 must be real", a.rel_path);
      assert!(a.size > 0, "{} size must be real", a.rel_path);
      assert!(!a.urls.is_empty() || a.bundled.is_some());
    }
    let total = total_download_bytes();
    // ~1.02GB models + a 10-80MB zip
    assert!(total > 1_020_000_000 && total < 1_150_000_000, "total = {total}");
    assert_ne!(LLAMA_BUILD, "<FILL-STEP-1>");
  }

  #[test]
  fn local_model_ids_normalize_to_qwen_without_clobbering_nemotron() {
    assert_eq!(normalize_local_model_id(""), QWEN_MODEL_ID);
    assert_eq!(normalize_local_model_id("unknown-model"), QWEN_MODEL_ID);
    assert_eq!(normalize_local_model_id(QWEN_MODEL_ID), QWEN_MODEL_ID);
    assert_eq!(normalize_local_model_id(NEMOTRON_MODEL_ID), NEMOTRON_MODEL_ID);
  }

  #[test]
  fn model_readiness_is_independent_for_qwen_and_nemotron() {
    let temp = tempfile::TempDir::new().unwrap();
    let dir = temp.path();

    for asset in MODEL_ASSETS {
      let path = dir.join(asset.rel_path);
      fs::create_dir_all(path.parent().unwrap()).unwrap();
      fs::File::create(path).unwrap().set_len(asset.size).unwrap();
    }
    let cli = cli_path(dir);
    fs::create_dir_all(cli.parent().unwrap()).unwrap();
    fs::write(&cli, b"#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
    }

    assert!(assets_ready_for_at(dir, QWEN_MODEL_ID));
    assert!(!assets_ready_for_at(dir, NEMOTRON_MODEL_ID));
  }

  #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
  #[test]
  fn bundled_runtime_matches_the_pinned_manifest() {
    let asset = llama_zip_asset();
    let bytes = asset.bundled.expect("Apple Silicon runtime must be bundled");
    assert_eq!(LLAMA_BUILD, "b9960-saytype-reset-v1");
    assert!(RESIDENT_RUNTIME_SAFE);
    assert_eq!(bytes.len() as u64, asset.size);
    assert_eq!(format!("{:x}", sha2::Sha256::digest(bytes)), asset.sha256);
  }

  #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
  #[test]
  fn bundled_runtime_migrates_an_existing_model_without_a_download() {
    let temp = tempfile::TempDir::new().unwrap();
    let dir = temp.path();
    for asset in MODEL_ASSETS {
      let path = dir.join(asset.rel_path);
      fs::create_dir_all(path.parent().unwrap()).unwrap();
      fs::File::create(path).unwrap().set_len(asset.size).unwrap();
    }
    assert!(!assets_ready_at(dir));

    ensure_bundled_runtime_at(dir).unwrap();

    assert!(assets_ready_at(dir));
    assert!(!dir.join(llama_zip_asset().rel_path).exists());
  }

  #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
  #[test]
  fn a_stale_runtime_extraction_is_replaced_by_the_bundled_archive() {
    let temp = tempfile::TempDir::new().unwrap();
    let dir = temp.path();
    for asset in MODEL_ASSETS {
      let path = dir.join(asset.rel_path);
      fs::create_dir_all(path.parent().unwrap()).unwrap();
      fs::File::create(path).unwrap().set_len(asset.size).unwrap();
    }
    ensure_bundled_runtime_at(dir).unwrap();
    let cli = cli_path(dir);
    let fresh_len = fs::metadata(&cli).unwrap().len();
    assert_eq!(fs::read_to_string(runtime_stamp_path(dir)).unwrap(), llama_zip_asset().sha256);

    // What a rebuilt archive under an unchanged runtime id meets on a machine
    // that already extracted the old one: the CLI is present and executable, so
    // nothing but the stamp can tell the app those files are stale.
    fs::write(&cli, b"stale").unwrap();
    fs::write(runtime_stamp_path(dir), "0".repeat(64)).unwrap();
    ensure_bundled_runtime_at(dir).unwrap();
    assert_eq!(fs::metadata(&cli).unwrap().len(), fresh_len, "stamp mismatch must re-extract");

    // An extraction predating the stamp counts as stale for the same reason.
    fs::write(&cli, b"stale").unwrap();
    fs::remove_file(runtime_stamp_path(dir)).unwrap();
    ensure_bundled_runtime_at(dir).unwrap();
    assert_eq!(fs::metadata(&cli).unwrap().len(), fresh_len, "missing stamp must re-extract");
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
  fn partial_event_payload_includes_the_recording_session() {
    let payload = partial_event_payload(Some(7), None, "hello");

    assert_eq!(payload["sessionId"], 7);
    assert_eq!(payload["text"], "hello");
  }

  #[test]
  fn legacy_assets_are_removed_without_touching_current_models() {
    let root = std::env::temp_dir().join(format!(
      "saytype-legacy-assets-{}-{}",
      std::process::id(),
      TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let legacy_onnx = root.join("models/qwen3-asr-0.6b-int8");
    let current_model = root.join("local-asr/models/Qwen3-ASR-0.6B-Q8_0.gguf");
    let legacy_runtime = root.join("local-asr/bin/b9960");
    let current_runtime = root.join("local-asr/bin").join(LLAMA_BUILD);
    fs::create_dir_all(&legacy_onnx).unwrap();
    fs::create_dir_all(current_model.parent().unwrap()).unwrap();
    fs::create_dir_all(&legacy_runtime).unwrap();
    fs::create_dir_all(&current_runtime).unwrap();
    fs::write(legacy_onnx.join("encoder.int8.onnx"), b"old").unwrap();
    fs::write(&current_model, b"current").unwrap();

    cleanup_legacy_assets_at(&root).unwrap();

    assert!(!legacy_onnx.exists());
    assert!(current_model.exists());
    assert!(current_runtime.exists());
    if LLAMA_BUILD != "b9960" {
      assert!(!legacy_runtime.exists());
    }
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn ctx_scales_with_clip_length_within_bounds() {
    // 16 kHz mono 16-bit WAV = 32000 bytes/s after a 44-byte header.
    let wav = |secs: f64| 44 + (secs * 32000.0) as usize;
    // Short clips stay at the floor (== the old fixed 2048), so their memory
    // footprint is unchanged; empty/sub-header input must not underflow.
    assert_eq!(ctx_size_for_wav(wav(1.0)), CTX_FLOOR);
    assert_eq!(ctx_size_for_wav(wav(60.0)), CTX_FLOOR); // 60*20+512=1712 < floor
    // Keep this paired with chunk-decision.mjs HARD_MAX_S. Every live chunk
    // must fit the same resident worker created at recording start.
    assert_eq!(ctx_size_for_wav(wav(75.0)), CTX_FLOOR);
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
  fn local_inference_disables_per_process_device_fitting() {
    assert_eq!(FIT_ARGS, ["--fit", "off"]);
  }

  #[tokio::test]
  async fn local_inference_semaphore_allows_only_one_decode() {
    let first = LOCAL_INFERENCE.acquire().await.unwrap();
    assert_eq!(LOCAL_INFERENCE.available_permits(), 0);
    assert!(
      tokio::time::timeout(Duration::from_millis(10), LOCAL_INFERENCE.acquire())
        .await
        .is_err(),
      "a second local decode must wait"
    );

    drop(first);
    let second = tokio::time::timeout(Duration::from_millis(100), LOCAL_INFERENCE.acquire())
      .await
      .expect("released slot should wake the next decode")
      .unwrap();
    drop(second);
    assert_eq!(LOCAL_INFERENCE.available_permits(), 1);
  }

  #[test]
  fn dictation_keep_alive_does_not_preload_a_worker() {
    shutdown_resident_worker();
    assert!(!keep_resident_worker_warm());
    assert!(RESIDENT_WORKER.lock().unwrap().is_none());
  }

  #[test]
  fn prewarm_deadline_outlives_the_frontend_hard_chunk_limit() {
    assert!(PREWARM_IDLE_TIMEOUT > Duration::from_secs(75));
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

  /// Needs the real assets laid out. Prewarms before the first decode, then runs
  /// two decodes to prove all three operations share one model process. Run:
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
    let starts_before = RESIDENT_STARTS.load(Ordering::Relaxed);
    let prewarm = rt
      .block_on(prewarm_resident_worker(|| Ok(true)))
      .expect("resident prewarm ok");
    assert_eq!(prewarm, ResidentPrewarmOutcome::Spawned);
    assert_eq!(
      RESIDENT_STARTS.load(Ordering::Relaxed) - starts_before,
      1,
      "prewarm must start exactly one resident worker"
    );
    let first = rt.block_on(transcribe_wav(None, None, None, &wav)).expect("first resident decode ok");
    assert!(keep_resident_worker_warm(), "recording start should touch a warm worker");
    rt.block_on(async {
      tokio::time::sleep(Duration::from_millis(75)).await;
    });
    assert!(keep_resident_worker_warm(), "a later dictation should refresh the deadline again");
    rt.block_on(async {
      tokio::time::sleep(Duration::from_millis(75)).await;
    });
    assert!(
      RESIDENT_WORKER.lock().unwrap().is_some(),
      "the refreshed worker must survive beyond its original idle deadline"
    );
    let second = rt.block_on(transcribe_wav(None, None, None, &wav)).expect("second resident decode ok");
    assert_eq!(first, "", "silence must yield empty text");
    assert_eq!(second, "", "warm-worker silence must yield empty text");
    assert_eq!(
      RESIDENT_STARTS.load(Ordering::Relaxed) - starts_before,
      1,
      "prewarm and two same-context decodes must share one resident worker"
    );
    rt.block_on(async {
      tokio::time::sleep(Duration::from_millis(500)).await;
    });
    assert!(
      RESIDENT_WORKER.lock().unwrap().is_none(),
      "idle worker must retire after the test idle timeout"
    );
    shutdown_resident_worker();
    // Temp file cleaned up:
    let leftovers = fs::read_dir(std::env::temp_dir()).unwrap()
      .filter_map(|e| e.ok())
      .filter(|e| e.file_name().to_string_lossy().starts_with("saytype-asr-"))
      .count();
    assert_eq!(leftovers, 0, "temp wav files must be removed");
  }

  /// The regression that gates a platform joining the resident-safe set.
  /// Upstream b9960 leaves the media batch on the chat context, so a decode can
  /// be handed the *previous* audio's embedding. `real_subprocess_smoke` cannot
  /// see that — it decodes the same silence twice, which makes a contaminated
  /// result indistinguishable from a correct one.
  ///
  /// This drives one ResidentWorker directly instead of going through
  /// transcribe_wav: a parked worker's idle timeout is 100 ms under cfg(test),
  /// so routing through the pool would race retirement and test the lifecycle
  /// rather than the embedding.
  ///
  /// Needs the real assets plus two distinct 16 kHz mono WAVs:
  ///   SAYTYPE_TEST_WAV_A=a.wav SAYTYPE_TEST_WAV_B=b.wav \
  ///     cargo test real_two_audio_contamination -- --ignored --nocapture
  #[test]
  #[ignore]
  fn real_two_audio_contamination() {
    assert!(assets_ready(), "lay out the assets first");
    let path_a = std::env::var("SAYTYPE_TEST_WAV_A").expect("set SAYTYPE_TEST_WAV_A");
    let path_b = std::env::var("SAYTYPE_TEST_WAV_B").expect("set SAYTYPE_TEST_WAV_B");
    let wav_a = fs::read(&path_a).expect("read SAYTYPE_TEST_WAV_A");
    let wav_b = fs::read(&path_b).expect("read SAYTYPE_TEST_WAV_B");
    assert_ne!(wav_a, wav_b, "the two clips must differ");
    // A context change respawns the worker, which would quietly turn this into
    // a series of one-shot decodes and prove nothing.
    let ctx = ctx_size_for_wav(wav_a.len());
    assert_eq!(ctx, ctx_size_for_wav(wav_b.len()), "both clips must map to one context");

    let base = local_asr_dir().expect("assets dir");
    let rt = tokio::runtime::Runtime::new().unwrap();
    let mut worker = rt.block_on(ResidentWorker::spawn(&base, ctx)).expect("resident worker");

    let reference_a = rt
      .block_on(worker.transcribe(Path::new(&path_a), wav_a.len(), &mut |_: &str| {}))
      .expect("first decode of A");
    let reference_b = rt
      .block_on(worker.transcribe(Path::new(&path_b), wav_b.len(), &mut |_: &str| {}))
      .expect("first decode of B");
    assert!(!reference_a.trim().is_empty(), "clip A must transcribe to speech");
    assert_ne!(
      reference_a, reference_b,
      "the clips must transcribe differently or contamination stays invisible"
    );

    // The stale-embedding reuse is intermittent, so one A/B pair is not evidence.
    for round in 0..6 {
      for (label, path, len, reference) in [
        ("A", &path_a, wav_a.len(), &reference_a),
        ("B", &path_b, wav_b.len(), &reference_b),
      ] {
        let got = rt
          .block_on(worker.transcribe(Path::new(path), len, &mut |_: &str| {}))
          .expect("resident decode");
        assert_eq!(&got, reference, "round {round} clip {label}: decoded as another clip");
      }
    }

    assert!(worker.is_running(), "all decodes must have come from one live process");
  }
}
