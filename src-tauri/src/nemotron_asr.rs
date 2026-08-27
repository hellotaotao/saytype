//! Nemotron 3.5 streaming ASR runtime, assets, and realtime sessions.

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::Digest;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Emitter;
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::local_asr::{Asset, ModelStatus, NEMOTRON_MODEL_ID};

const MODEL_FILE: &str = "models/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf";
const RUNTIME_BUILD: &str = "nemo-speech-4f967622";
const RUNTIME_ARCHIVE: &str = "nemo-speech-4f967622-macos-arm64.tar.gz";
const RUNTIME_SHA256: &str = "8d70519d55f33a517b79abae0607bcaf82e6b9c85830060746c21cad2637c0ab";
const RUNTIME_SIZE: u64 = 2_052_134;
const MODEL_SIZE: u64 = 741_548_352;
const MODEL_SHA256: &str = "a5c435f294eea8f88ce68dd27b8c3bfea7f777cb2fbba04fcd30eaa555f429ae";
const PROGRESS_EMIT_STEP: u64 = 8 * 1024 * 1024;
const SIDECAR_READY_TIMEOUT: Duration = Duration::from_secs(60);
const FINAL_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_PCM_CHUNK_BYTES: usize = 512 * 1024;

static MODEL_ASSET: Asset = Asset {
  rel_path: MODEL_FILE,
  urls: &[
    "https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/resolve/1c8deaecc64b91f034d73e08dd8b64625eb3395d/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf",
  ],
  bundled: None,
  size: MODEL_SIZE,
  sha256: MODEL_SHA256,
};

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
static RUNTIME_BYTES: &[u8] =
  include_bytes!("../resources/local-asr/nemo-speech-4f967622-macos-arm64.tar.gz");

fn supported() -> bool {
  cfg!(all(target_os = "macos", target_arch = "aarch64"))
}

fn base_dir() -> Result<PathBuf> {
  crate::local_asr::local_asr_dir()
}

fn runtime_dir(base: &Path) -> PathBuf {
  base.join("bin").join(RUNTIME_BUILD)
}

fn runtime_path(base: &Path) -> PathBuf {
  runtime_dir(base).join("nemo-speech")
}

fn runtime_stamp_path(base: &Path) -> PathBuf {
  runtime_dir(base).join(".saytype-runtime-sha256")
}

fn model_path(base: &Path) -> PathBuf {
  base.join(MODEL_FILE)
}

fn exact_file(path: &Path, size: u64) -> bool {
  fs::metadata(path)
    .map(|metadata| metadata.is_file() && metadata.len() == size)
    .unwrap_or(false)
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
  use std::os::unix::fs::PermissionsExt;
  fs::metadata(path)
    .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
    .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
  true
}

fn runtime_ready_at(base: &Path) -> bool {
  let executable = runtime_path(base);
  fs::metadata(&executable)
    .map(|metadata| metadata.is_file())
    .unwrap_or(false)
    && is_executable(&executable)
    && fs::read_to_string(runtime_stamp_path(base))
      .map(|stamp| stamp.trim() == RUNTIME_SHA256)
      .unwrap_or(false)
}

pub fn assets_ready_at(base: &Path) -> bool {
  supported() && exact_file(&model_path(base), MODEL_SIZE) && runtime_ready_at(base)
}

pub fn assets_ready() -> bool {
  if !supported() {
    return false;
  }
  base_dir()
    .map(|base| {
      if exact_file(&model_path(&base), MODEL_SIZE) {
        if let Err(error) = ensure_runtime_at(&base) {
          log::warn!("nemotron: failed to install bundled runtime: {error}");
        }
      }
      assets_ready_at(&base)
    })
    .unwrap_or(false)
}

fn total_bytes() -> u64 {
  MODEL_SIZE + RUNTIME_SIZE
}

fn downloaded_bytes_at(base: &Path) -> u64 {
  let mut downloaded = 0;
  let model = model_path(base);
  if exact_file(&model, MODEL_SIZE) {
    downloaded += MODEL_SIZE;
  } else {
    downloaded += fs::metadata(&model)
      .map(|metadata| metadata.len())
      .unwrap_or(0)
      .min(MODEL_SIZE);
    downloaded += fs::metadata(base.join(format!("{MODEL_FILE}.part")))
      .map(|metadata| metadata.len())
      .unwrap_or(0)
      .min(MODEL_SIZE);
  }
  if runtime_ready_at(base) {
    downloaded += RUNTIME_SIZE;
  }
  downloaded
}

pub fn model_status(downloading: bool) -> ModelStatus {
  if !supported() {
    return ModelStatus {
      state: "unsupported".into(),
      downloaded_bytes: 0,
      total_bytes: total_bytes(),
    };
  }
  let Ok(base) = base_dir() else {
    return ModelStatus {
      state: "absent".into(),
      downloaded_bytes: 0,
      total_bytes: total_bytes(),
    };
  };
  if exact_file(&model_path(&base), MODEL_SIZE) {
    let _ = ensure_runtime_at(&base);
  }
  let downloaded = downloaded_bytes_at(&base);
  let state = if downloading {
    "downloading"
  } else if assets_ready_at(&base) {
    "ready"
  } else if downloaded > 0 {
    "partial"
  } else {
    "absent"
  };
  ModelStatus {
    state: state.into(),
    downloaded_bytes: downloaded,
    total_bytes: total_bytes(),
  }
}

fn emit_progress(app: &tauri::AppHandle, state: &str, downloaded: u64, message: Option<&str>) {
  let _ = app.emit(
    "local-model-download-progress",
    json!({
      "model": NEMOTRON_MODEL_ID,
      "state": state,
      "downloadedBytes": downloaded,
      "totalBytes": total_bytes(),
      "message": message,
    }),
  );
}

pub async fn download_model(
  app: tauri::AppHandle,
  cancel: CancellationToken,
) -> Result<(), String> {
  if !supported() {
    return Err("Nemotron is currently available on Apple Silicon Macs only".into());
  }
  let base = base_dir().map_err(|error| error.to_string())?;
  if !exact_file(&model_path(&base), MODEL_SIZE) {
    let client = reqwest::Client::builder()
      .connect_timeout(Duration::from_secs(15))
      .build()
      .map_err(|error| error.to_string())?;
    download_asset(&app, &client, &base, &MODEL_ASSET, &cancel).await?;
  }
  ensure_runtime_at(&base)?;
  Ok(())
}

async fn download_asset(
  app: &tauri::AppHandle,
  client: &reqwest::Client,
  base: &Path,
  asset: &Asset,
  cancel: &CancellationToken,
) -> Result<(), String> {
  use std::io::Write;

  let part_path = base.join(format!("{}.part", asset.rel_path));
  if let Some(parent) = part_path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let mut last_error = String::new();
  for url in asset.urls {
    if cancel.is_cancelled() {
      return Err("DOWNLOAD_CANCELLED".into());
    }
    let existing = fs::metadata(&part_path)
      .map(|metadata| metadata.len())
      .unwrap_or(0);
    let offset = if existing > asset.size { 0 } else { existing };
    let stream_result = async {
      if offset == asset.size {
        return Ok(());
      }
      let mut request = client.get(*url);
      if offset > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
      }
      let mut response = request.send().await.map_err(|error| error.to_string())?;
      if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
      }
      let append = offset > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
      let mut output = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&part_path)
        .map_err(|error| error.to_string())?;
      let mut written = if append { offset } else { 0 };
      let mut last_emit = written;
      loop {
        let chunk = tokio::select! {
          _ = cancel.cancelled() => return Err("DOWNLOAD_CANCELLED".into()),
          chunk = response.chunk() => chunk.map_err(|error| error.to_string())?,
        };
        let Some(chunk) = chunk else { break };
        output
          .write_all(&chunk)
          .map_err(|error| error.to_string())?;
        written += chunk.len() as u64;
        if written.saturating_sub(last_emit) >= PROGRESS_EMIT_STEP {
          last_emit = written;
          emit_progress(app, "downloading", written.min(asset.size), None);
        }
      }
      output.flush().map_err(|error| error.to_string())?;
      Ok(())
    }
    .await;

    match stream_result {
      Ok(()) => {
        let got = fs::metadata(&part_path)
          .map(|metadata| metadata.len())
          .unwrap_or(0);
        if got != asset.size {
          last_error = format!("size mismatch {got} != {}", asset.size);
          let _ = fs::remove_file(&part_path);
          continue;
        }
        let hash_path = part_path.clone();
        let hash = tokio::task::spawn_blocking(move || -> Result<String, String> {
          let mut hasher = sha2::Sha256::new();
          let mut reader = fs::File::open(hash_path).map_err(|error| error.to_string())?;
          std::io::copy(&mut reader, &mut hasher).map_err(|error| error.to_string())?;
          Ok(format!("{:x}", hasher.finalize()))
        })
        .await
        .map_err(|error| error.to_string())??;
        if hash != asset.sha256 {
          last_error = "sha256 mismatch".into();
          let _ = fs::remove_file(&part_path);
          continue;
        }
        fs::rename(&part_path, base.join(asset.rel_path)).map_err(|error| error.to_string())?;
        emit_progress(app, "downloading", MODEL_SIZE, None);
        return Ok(());
      }
      Err(error) if error == "DOWNLOAD_CANCELLED" => return Err(error),
      Err(error) => {
        last_error = format!("{url}: {error}");
        log::warn!("nemotron: download source failed: {last_error}");
      }
    }
  }
  Err(format!(
    "failed to download {}: {last_error}",
    asset.rel_path
  ))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn ensure_runtime_at(base: &Path) -> Result<(), String> {
  if runtime_ready_at(base) {
    return Ok(());
  }
  if !exact_file(&model_path(base), MODEL_SIZE) {
    return Ok(());
  }
  if RUNTIME_BYTES.len() as u64 != RUNTIME_SIZE {
    return Err("bundled Nemotron runtime size mismatch".into());
  }
  if format!("{:x}", sha2::Sha256::digest(RUNTIME_BYTES)) != RUNTIME_SHA256 {
    return Err("bundled Nemotron runtime sha256 mismatch".into());
  }
  let archive_path = base.join(RUNTIME_ARCHIVE);
  fs::create_dir_all(base).map_err(|error| error.to_string())?;
  fs::write(&archive_path, RUNTIME_BYTES).map_err(|error| error.to_string())?;
  extract_runtime(base, &archive_path)?;
  let _ = fs::remove_file(archive_path);
  fs::write(runtime_stamp_path(base), RUNTIME_SHA256).map_err(|error| error.to_string())?;
  Ok(())
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn ensure_runtime_at(_base: &Path) -> Result<(), String> {
  Err("Nemotron is currently available on Apple Silicon Macs only".into())
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn extract_runtime(base: &Path, archive_path: &Path) -> Result<(), String> {
  use std::os::unix::fs::PermissionsExt;

  let output_dir = runtime_dir(base);
  let _ = fs::remove_dir_all(&output_dir);
  fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;
  let file = fs::File::open(archive_path).map_err(|error| error.to_string())?;
  let decoder = flate2::read::GzDecoder::new(file);
  let mut archive = tar::Archive::new(decoder);
  archive
    .unpack(&output_dir)
    .map_err(|error| error.to_string())?;
  for entry in fs::read_dir(&output_dir).map_err(|error| error.to_string())? {
    let path = entry.map_err(|error| error.to_string())?.path();
    if path.is_file() {
      fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
        .map_err(|error| error.to_string())?;
    }
  }
  if !runtime_path(base).is_file() {
    return Err("Nemotron runtime archive did not contain nemo-speech".into());
  }
  Ok(())
}

#[derive(Clone)]
struct SidecarEndpoint {
  port: u16,
  token: String,
}

struct Sidecar {
  child: Child,
  endpoint: SidecarEndpoint,
}

static SIDECAR: Mutex<Option<Sidecar>> = Mutex::const_new(None);
static LIVE_SESSIONS: OnceLock<Mutex<HashMap<u64, mpsc::Sender<LiveCommand>>>> = OnceLock::new();
static TOKEN_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn live_sessions() -> &'static Mutex<HashMap<u64, mpsc::Sender<LiveCommand>>> {
  LIVE_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

enum LiveCommand {
  Audio(Vec<u8>),
  Commit(oneshot::Sender<Result<String, String>>),
  Cancel,
}

#[derive(Debug, PartialEq, Eq)]
enum ServerEvent {
  Ignore,
  Partial(String),
  Final(String),
  Committed,
  Error(String),
}

fn parse_server_event(text: &str, partial: &mut String) -> ServerEvent {
  let Ok(event) = serde_json::from_str::<Value>(text) else {
    return ServerEvent::Ignore;
  };
  match event
    .get("type")
    .and_then(Value::as_str)
    .unwrap_or_default()
  {
    "conversation.item.input_audio_transcription.delta" => {
      if let Some(delta) = event.get("delta").and_then(Value::as_str) {
        partial.push_str(delta);
      }
      ServerEvent::Partial(partial.clone())
    }
    "conversation.item.input_audio_transcription.completed" => ServerEvent::Final(
      event
        .get("transcript")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string(),
    ),
    "input_audio_buffer.committed" => ServerEvent::Committed,
    "error" => ServerEvent::Error(
      event
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("Nemotron realtime session failed")
        .to_string(),
    ),
    _ => ServerEvent::Ignore,
  }
}

fn next_token() -> String {
  let seed = format!(
    "{}:{}:{}",
    std::process::id(),
    std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap_or_default()
      .as_nanos(),
    TOKEN_SEQUENCE.fetch_add(1, Ordering::Relaxed)
  );
  format!("{:x}", sha2::Sha256::digest(seed.as_bytes()))
}

fn reserve_loopback_port() -> Result<u16> {
  let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
  Ok(listener.local_addr()?.port())
}

async fn ensure_sidecar() -> Result<SidecarEndpoint> {
  if !assets_ready() {
    anyhow::bail!("LOCAL_MODEL_MISSING: Nemotron assets are missing or incomplete");
  }
  let mut slot = SIDECAR.lock().await;
  if let Some(sidecar) = slot.as_mut() {
    if matches!(sidecar.child.try_wait(), Ok(None)) {
      return Ok(sidecar.endpoint.clone());
    }
    slot.take();
  }

  let base = base_dir()?;
  let port = reserve_loopback_port()?;
  let token = next_token();
  let mut child = tokio::process::Command::new(runtime_path(&base))
    .arg("serve")
    .arg("--host")
    .arg("127.0.0.1")
    .arg("--port")
    .arg(port.to_string())
    .arg("--threads")
    .arg("2")
    .arg("--max-upload-mb")
    .arg("64")
    .arg("--read-timeout")
    .arg("120")
    .arg("--write-timeout")
    .arg("120")
    .arg("--no-ui")
    .arg("--asr-model")
    .arg(model_path(&base))
    .arg("--device")
    .arg("metal")
    .env("NEMO_SPEECH_HTTP_API_KEY", &token)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .kill_on_drop(true)
    .spawn()
    .context("failed to start the Nemotron runtime")?;

  let endpoint = SidecarEndpoint { port, token };
  let client = reqwest::Client::builder()
    .connect_timeout(Duration::from_millis(300))
    .timeout(Duration::from_secs(2))
    .build()?;
  let started = std::time::Instant::now();
  loop {
    if let Some(status) = child.try_wait()? {
      anyhow::bail!("Nemotron runtime exited during startup ({status})");
    }
    let ready = client
      .get(format!("http://127.0.0.1:{port}/ready"))
      .send()
      .await
      .map(|response| response.status().is_success())
      .unwrap_or(false);
    if ready {
      break;
    }
    if started.elapsed() >= SIDECAR_READY_TIMEOUT {
      let _ = child.start_kill();
      anyhow::bail!("Nemotron runtime did not become ready within 60 seconds");
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
  }

  log::info!("nemotron: sidecar ready on loopback port {port}");
  *slot = Some(Sidecar {
    child,
    endpoint: endpoint.clone(),
  });
  Ok(endpoint)
}

pub async fn prewarm() -> Result<()> {
  ensure_sidecar().await.map(|_| ())
}

pub async fn start_live_session(
  app: tauri::AppHandle,
  session_id: u64,
  sample_rate: u32,
  language: String,
) -> Result<(), String> {
  if !(8_000..=96_000).contains(&sample_rate) {
    return Err(format!("unsupported realtime sample rate: {sample_rate}"));
  }
  let endpoint = ensure_sidecar().await.map_err(|error| error.to_string())?;
  let url = format!(
    "ws://127.0.0.1:{}/v1/realtime?api_key={}",
    endpoint.port, endpoint.token
  );
  let (mut socket, _) = tokio_tungstenite::connect_async(url)
    .await
    .map_err(|error| format!("failed to connect to Nemotron realtime API: {error}"))?;

  let created = tokio::time::timeout(Duration::from_secs(5), socket.next())
    .await
    .map_err(|_| "Nemotron realtime session did not initialize".to_string())?
    .ok_or_else(|| "Nemotron realtime socket closed during initialization".to_string())?
    .map_err(|error| error.to_string())?;
  let created_ok = match created {
    Message::Text(text) => {
      serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| {
          value
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_string)
        })
        .as_deref()
        == Some("session.created")
    }
    _ => false,
  };
  if !created_ok {
    return Err("Nemotron realtime API returned an invalid session handshake".into());
  }

  let language = if language.trim().is_empty() {
    "auto"
  } else {
    language.trim()
  };
  socket
    .send(Message::Text(
      json!({
        "type": "session.update",
        "session": {
          "sample_rate": sample_rate,
          "language": language,
          "automatic_punctuation": true,
        }
      })
      .to_string(),
    ))
    .await
    .map_err(|error| error.to_string())?;

  let (tx, mut rx) = mpsc::channel::<LiveCommand>(32);
  if let Some(previous) = live_sessions().lock().await.insert(session_id, tx) {
    let _ = previous.send(LiveCommand::Cancel).await;
  }

  tauri::async_runtime::spawn(async move {
    let mut partial = String::new();
    let mut final_reply: Option<oneshot::Sender<Result<String, String>>> = None;
    loop {
      tokio::select! {
        command = rx.recv() => match command {
          Some(LiveCommand::Audio(bytes)) => {
            if let Err(error) = socket.send(Message::Binary(bytes)).await {
              if let Some(reply) = final_reply.take() {
                let _ = reply.send(Err(error.to_string()));
              }
              break;
            }
          }
          Some(LiveCommand::Commit(reply)) => {
            final_reply = Some(reply);
            if let Err(error) = socket.send(Message::Text(
              json!({ "type": "input_audio_buffer.commit" }).to_string()
            )).await {
              if let Some(reply) = final_reply.take() {
                let _ = reply.send(Err(error.to_string()));
              }
              break;
            }
          }
          Some(LiveCommand::Cancel) | None => {
            let _ = socket.send(Message::Text(
              json!({ "type": "response.cancel" }).to_string()
            )).await;
            if let Some(reply) = final_reply.take() {
              let _ = reply.send(Err("TRANSCRIPTION_CANCELLED".into()));
            }
            break;
          }
        },
        incoming = socket.next() => {
          let Some(incoming) = incoming else {
            if let Some(reply) = final_reply.take() {
              let _ = reply.send(Err("Nemotron realtime socket closed before final transcription".into()));
            }
            break;
          };
          match incoming {
            Ok(Message::Text(text)) => match parse_server_event(&text, &mut partial) {
              ServerEvent::Partial(text) if !text.is_empty() => {
                let _ = app.emit(
                  "local-transcription-partial",
                  json!({ "sessionId": session_id, "text": text, "engine": "nemotron" }),
                );
              }
              ServerEvent::Final(text) => {
                if let Some(reply) = final_reply.take() {
                  let _ = reply.send(Ok(text));
                }
              }
              ServerEvent::Error(error) => {
                if let Some(reply) = final_reply.take() {
                  let _ = reply.send(Err(error));
                }
                break;
              }
              _ => {}
            },
            Ok(Message::Close(_)) | Err(_) => {
              if let Some(reply) = final_reply.take() {
                let _ = reply.send(Err("Nemotron realtime socket closed before final transcription".into()));
              }
              break;
            }
            _ => {}
          }
        }
      }
    }
    let _ = socket.close(None).await;
  });
  Ok(())
}

pub async fn push_live_audio(session_id: u64, bytes: Vec<u8>) -> Result<(), String> {
  if bytes.is_empty() {
    return Ok(());
  }
  if bytes.len() > MAX_PCM_CHUNK_BYTES || bytes.len() % 2 != 0 {
    return Err("invalid PCM16 realtime audio chunk".into());
  }
  let sender = live_sessions()
    .lock()
    .await
    .get(&session_id)
    .cloned()
    .ok_or_else(|| "Nemotron realtime session is not active".to_string())?;
  sender
    .send(LiveCommand::Audio(bytes))
    .await
    .map_err(|_| "Nemotron realtime session closed".to_string())
}

pub async fn finish_live_session(session_id: u64) -> Result<String, String> {
  let sender = live_sessions()
    .lock()
    .await
    .get(&session_id)
    .cloned()
    .ok_or_else(|| "Nemotron realtime session is not active".to_string())?;
  let (reply_tx, reply_rx) = oneshot::channel();
  let result = if sender.send(LiveCommand::Commit(reply_tx)).await.is_err() {
    Err("Nemotron realtime session closed".to_string())
  } else {
    match tokio::time::timeout(FINAL_TIMEOUT, reply_rx).await {
      Ok(Ok(result)) => result,
      Ok(Err(_)) => Err("Nemotron realtime session closed".to_string()),
      Err(_) => Err("Nemotron final transcription timed out".to_string()),
    }
  };
  live_sessions().lock().await.remove(&session_id);
  let _ = sender.send(LiveCommand::Cancel).await;
  result
}

pub async fn cancel_live_session(session_id: u64) -> bool {
  let sender = live_sessions().lock().await.remove(&session_id);
  if let Some(sender) = sender {
    let _ = sender.send(LiveCommand::Cancel).await;
    true
  } else {
    false
  }
}

pub async fn transcribe_wav(wav: Vec<u8>, language: &str) -> Result<String> {
  let endpoint = ensure_sidecar().await?;
  let part = reqwest::multipart::Part::bytes(wav)
    .file_name("audio.wav")
    .mime_str("audio/wav")?;
  let form = reqwest::multipart::Form::new()
    .part("file", part)
    .text(
      "language",
      if language.trim().is_empty() {
        "auto"
      } else {
        language
      }
      .to_string(),
    )
    .text("response_format", "json");
  let client = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(5))
    .timeout(FINAL_TIMEOUT)
    .build()?;
  let response = client
    .post(format!(
      "http://127.0.0.1:{}/v1/audio/transcriptions",
      endpoint.port
    ))
    .bearer_auth(endpoint.token)
    .multipart(form)
    .send()
    .await?;
  let status = response.status();
  let body = response.text().await?;
  if !status.is_success() {
    anyhow::bail!("Nemotron transcription failed ({status}): {body}");
  }
  let value: Value = serde_json::from_str(&body)?;
  Ok(
    value
      .get("text")
      .and_then(Value::as_str)
      .unwrap_or_default()
      .to_string(),
  )
}

pub fn shutdown() {
  let mut sessions_pending = false;
  if let Some(sessions) = LIVE_SESSIONS.get() {
    if let Ok(mut sessions) = sessions.try_lock() {
      sessions.clear();
    } else {
      sessions_pending = true;
    }
  }
  let mut sidecar_pending = false;
  if let Ok(mut sidecar) = SIDECAR.try_lock() {
    if let Some(mut sidecar) = sidecar.take() {
      let _ = sidecar.child.start_kill();
    }
  } else {
    sidecar_pending = true;
  }

  if sessions_pending || sidecar_pending {
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
      runtime.spawn(async move {
        if sessions_pending {
          live_sessions().lock().await.clear();
        }
        if sidecar_pending {
          if let Some(mut sidecar) = SIDECAR.lock().await.take() {
            let _ = sidecar.child.start_kill();
          }
        }
      });
    }
  }
}

pub fn delete_model() -> Result<(), String> {
  shutdown();
  let _sidecar_guard = SIDECAR
    .try_lock()
    .map_err(|_| "Nemotron runtime is busy; try deleting the model again shortly".to_string())?;
  let base = base_dir().map_err(|error| error.to_string())?;
  let _ = fs::remove_file(model_path(&base));
  let _ = fs::remove_file(base.join(format!("{MODEL_FILE}.part")));
  let _ = fs::remove_file(base.join(RUNTIME_ARCHIVE));
  match fs::remove_dir_all(runtime_dir(&base)) {
    Ok(()) => Ok(()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(error.to_string()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn manifest_matches_the_bundled_runtime_and_model() {
    assert_eq!(MODEL_ASSET.size, MODEL_SIZE);
    assert_eq!(MODEL_ASSET.sha256, MODEL_SHA256);
    assert_eq!(MODEL_SHA256.len(), 64);
    assert_eq!(RUNTIME_SHA256.len(), 64);
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
      assert_eq!(RUNTIME_BYTES.len() as u64, RUNTIME_SIZE);
      assert_eq!(
        format!("{:x}", sha2::Sha256::digest(RUNTIME_BYTES)),
        RUNTIME_SHA256
      );
    }
  }

  #[test]
  fn realtime_events_accumulate_partials_and_replace_them_with_the_final() {
    let mut partial = String::new();
    assert_eq!(
      parse_server_event(
        r#"{"type":"conversation.item.input_audio_transcription.delta","delta":"hello"}"#,
        &mut partial,
      ),
      ServerEvent::Partial("hello".into())
    );
    assert_eq!(
      parse_server_event(
        r#"{"type":"conversation.item.input_audio_transcription.delta","delta":" world"}"#,
        &mut partial,
      ),
      ServerEvent::Partial("hello world".into())
    );
    assert_eq!(
      parse_server_event(
        r#"{"type":"conversation.item.input_audio_transcription.completed","transcript":"Hello world."}"#,
        &mut partial,
      ),
      ServerEvent::Final("Hello world.".into())
    );
  }

  #[test]
  fn qwen_files_do_not_make_nemotron_ready() {
    let temp = tempfile::TempDir::new().unwrap();
    let base = temp.path();
    let qwen = base.join(crate::local_asr::MODEL_ASSETS[0].rel_path);
    fs::create_dir_all(qwen.parent().unwrap()).unwrap();
    fs::File::create(qwen)
      .unwrap()
      .set_len(crate::local_asr::MODEL_ASSETS[0].size)
      .unwrap();
    assert!(!assets_ready_at(base));
  }
}
