use crate::hotkey;
use crate::history;
use crate::platform::{self, InsertResult};
use crate::settings::{self, AppConfig, SettingsPayload, TRANSLATE_SHORTCUT};
use crate::state::AppState;
use anyhow::{Context, Result};
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

const MAX_AUDIO_SIZE_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityStatus {
  pub granted: bool,
  pub status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneStatus {
  pub status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeTextResponse {
  pub success: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub method: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub message: Option<String>,
  #[serde(default)]
  pub skipped_no_text: bool,
}

#[tauri::command]
pub fn get_settings() -> Result<SettingsPayload, String> {
  log::info!("command:get_settings");
  settings::read_config()
    .map(|config| SettingsPayload::from_config(&config))
    .map_err(stringify_error)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeys {
  pub api_key: String,
  pub api_key_groq: String,
  #[serde(rename = "apiKeyOpenAI")]
  pub api_key_openai: String,
}

// The raw API keys, kept out of get_settings so the secrets are only ever sent
// to the window that edits them (settings) — not to every window that reads
// general settings (main, input-prompt).
#[tauri::command]
pub fn get_api_keys() -> Result<ApiKeys, String> {
  let config = settings::read_config().map_err(stringify_error)?;
  Ok(ApiKeys {
    api_key: config.api_key,
    api_key_groq: config.api_key_groq,
    api_key_openai: config.api_key_openai,
  })
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings_input: AppConfig, state: State<'_, AppState>) -> Result<bool, String> {
  log::info!(
    "command:save_settings provider={} shortcut={} ui_theme={}",
    settings_input.provider,
    settings_input.shortcut,
    settings_input.ui_theme
  );
  let existing = settings::read_config().map_err(stringify_error)?;
  let mut config = settings_input;
  config.dictionary = existing.dictionary;
  config.translate_shortcut = TRANSLATE_SHORTCUT.into();
  config.shortcut = settings::normalize_record_shortcut(&config.shortcut);
  config.api_key = settings::selected_api_key(&config);

  settings::write_config(&config).map_err(stringify_error)?;
  // Only re-apply the login item when auto-launch actually changed. Re-running
  // `launchctl load` on every save would spawn a duplicate instance (the agent
  // is RunAtLoad), which is the root cause of the double-transcribe bug.
  if settings::auto_launch_needs_update(existing.auto_launch, config.auto_launch) {
    settings::update_auto_launch(config.auto_launch).map_err(stringify_error)?;
  }

  if let Some(handle) = state.hotkey.lock().unwrap().as_ref() {
    handle.update_shortcut(config.shortcut.clone());
  }

  broadcast_settings_updates(&app, &config).map_err(stringify_error)?;
  Ok(true)
}

#[tauri::command]
pub fn get_app_version() -> String {
  env!("CARGO_PKG_VERSION").into()
}

#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<(), String> {
  log::info!("command:open_settings");
  if let Some(window) = app.get_webview_window("settings") {
    window.show().map_err(stringify_error)?;
    window.set_focus().map_err(stringify_error)?;
  }
  Ok(())
}

#[tauri::command]
pub fn close_settings(app: AppHandle) -> Result<(), String> {
  log::info!("command:close_settings");
  if let Some(window) = app.get_webview_window("settings") {
    window.hide().map_err(stringify_error)?;
  }

  if let Some(window) = app.get_webview_window("main") {
    if window.is_visible().unwrap_or(false) {
      let _ = window.set_focus();
    }
  }

  Ok(())
}

#[tauri::command]
pub fn hide_input_prompt(app: AppHandle) -> Result<(), String> {
  let _ = app.emit_to("input-prompt", "cleanup-microphone", ());
  if let Some(window) = app.get_webview_window("input-prompt") {
    window.hide().map_err(stringify_error)?;
  }
  Ok(())
}

#[tauri::command]
pub fn cleanup_microphone(app: AppHandle) -> Result<bool, String> {
  let _ = app.emit_to("input-prompt", "cleanup-microphone", ());
  Ok(true)
}

#[tauri::command]
pub fn cancel_transcription(state: State<'_, AppState>) -> Result<bool, String> {
  let mut cancelled = false;
  for token in state.active_transcriptions.lock().unwrap().values() {
    token.cancel();
    cancelled = true;
  }
  Ok(cancelled)
}

#[tauri::command]
pub async fn transcribe_audio(
  app: AppHandle,
  state: State<'_, AppState>,
  request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
  // The audio arrives as the raw IPC body (Tauri's octet-stream fast path), not
  // a JSON number array — see ipc-bridge.js (tauriRawBody). translate_mode /
  // mime_type ride along as headers. NOTE: this requires input-prompt.html's CSP
  // to allow `connect-src ipc:`; without it Tauri falls back to the postMessage
  // transport, which JSON-encodes the bytes → body() is Json, not Raw → the error
  // below. (Page origin is tauri://localhost; the IPC fetch is ipc://localhost.)
  let audio_buffer: Vec<u8> = match request.body() {
    tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
    tauri::ipc::InvokeBody::Json(_) => {
      return Err("transcribe_audio expects a raw audio body".into());
    }
  };
  let headers = request.headers();
  let translate_mode = headers
    .get("translate-mode")
    .and_then(|value| value.to_str().ok())
    .map(|value| value == "true")
    .unwrap_or(false);
  let mime = headers
    .get("mime-type")
    .and_then(|value| value.to_str().ok())
    .filter(|value| !value.is_empty())
    .unwrap_or("audio/webm")
    .to_string();

  if audio_buffer.is_empty() {
    return Err("Audio buffer is empty".into());
  }
  if audio_buffer.len() > MAX_AUDIO_SIZE_BYTES {
    return Err(format!(
      "Audio too large: {} bytes (max {})",
      audio_buffer.len(),
      MAX_AUDIO_SIZE_BYTES
    ));
  }

  let config = settings::read_config().map_err(stringify_error)?;
  let api_key = settings::selected_api_key(&config);
  if api_key.trim().is_empty() {
    return Err("API key not configured".into());
  }

  let request_id = state.next_transcription_id.fetch_add(1, Ordering::Relaxed) + 1;
  let cancellation = CancellationToken::new();
  state
    .active_transcriptions
    .lock()
    .unwrap()
    .insert(request_id, cancellation.clone());

  // Dev-only: keep a copy of the exact bytes we send, so history can play the
  // recording back (for diagnosing first-word drop / quality). Never in release.
  let audio_for_debug =
    cfg!(debug_assertions).then(|| (audio_buffer.clone(), mime.clone()));

  let result = tokio::select! {
    _ = cancellation.cancelled() => Err(anyhow::anyhow!("TRANSCRIPTION_CANCELLED")),
    result = perform_transcription_request(
      &state.http_client,
      &config,
      &api_key,
      audio_buffer,
      translate_mode,
      mime,
    ) => result,
  };

  state.active_transcriptions.lock().unwrap().remove(&request_id);

  match result {
    Ok(text) => {
      // Saving to history is best-effort: the transcription already succeeded,
      // so a history read/write failure must NOT bubble up as an Err — that
      // would show the user "transcription failed" AND drop the text without
      // ever inserting it, losing a result the API actually returned.
      if let Err(err) = append_activity(&text, true, None, audio_for_debug) {
        log::warn!("failed to record transcription in history: {err:#}");
      }
      let _ = app.emit("activity-updated", ());
      Ok(text)
    }
    Err(error) => {
      if is_cancellation_error(&error) {
        return Err("TRANSCRIPTION_CANCELLED".into());
      }

      let mode = if translate_mode {
        "Translation"
      } else {
        "Transcription"
      };
      let message = format!("{mode} failed: {}", error);
      // Best-effort here too: surface the original API error to the user, not a
      // secondary history-write error.
      if let Err(err) = append_activity(&message, false, Some(error.to_string()), audio_for_debug) {
        log::warn!("failed to record failed transcription in history: {err:#}");
      }
      let _ = app.emit("activity-updated", ());
      Err(error.to_string())
    }
  }
}

#[tauri::command]
pub async fn type_text(
  _state: State<'_, AppState>,
  text: String,
) -> Result<TypeTextResponse, String> {
  if text.trim().is_empty() {
    return Ok(TypeTextResponse {
      success: false,
      method: None,
      message: Some("No text to insert.".into()),
      skipped_no_text: true,
    });
  }

  // No clipboard fallback by design: every transcription is already saved to
  // history (see transcribe_audio), so a failed insert just points the user
  // there instead of overwriting their clipboard. The per-OS mechanism lives
  // behind `platform::insert_text`; this maps its outcome to the response.
  Ok(match platform::insert_text(&text) {
    InsertResult::Inserted { method } => TypeTextResponse {
      success: true,
      method: Some(method.into()),
      message: Some("Text inserted directly.".into()),
      skipped_no_text: false,
    },
    InsertResult::NoEditableTarget => TypeTextResponse {
      success: false,
      method: None,
      message: Some("No editable text field is focused.".into()),
      skipped_no_text: false,
    },
    InsertResult::Failed => TypeTextResponse {
      success: false,
      method: None,
      message: Some("Text insertion failed; copy it from History.".into()),
      skipped_no_text: false,
    },
  })
}

#[tauri::command]
pub fn show_permission_dialog() -> Result<i32, String> {
  platform::open_accessibility_settings();
  Ok(0)
}

// Explicit, user-initiated clipboard write — used ONLY by the input-prompt's
// "insertion failed → click Copy" affordance. The per-OS mechanism (pbcopy on
// macOS) lives behind `platform::copy_to_clipboard`. There is still no
// AUTOMATIC clipboard touch anywhere — this only fires on a real button click.
#[tauri::command]
pub fn copy_to_clipboard(text: String) -> Result<bool, String> {
  platform::copy_to_clipboard(&text)
    .map(|_| true)
    .map_err(stringify_error)
}

#[tauri::command]
pub fn check_microphone_permission() -> MicrophoneStatus {
  MicrophoneStatus {
    status: platform::microphone_status(),
  }
}

#[tauri::command]
pub fn check_accessibility_permission() -> AccessibilityStatus {
  accessibility_status(false)
}

#[tauri::command]
pub fn request_accessibility_permission(app: AppHandle, state: State<'_, AppState>) -> AccessibilityStatus {
  sync_accessibility_status(app, state, accessibility_status(true))
}

#[tauri::command]
pub fn recheck_accessibility_permission(app: AppHandle, state: State<'_, AppState>) -> AccessibilityStatus {
  sync_accessibility_status(app, state, accessibility_status(false))
}

fn sync_accessibility_status(app: AppHandle, state: State<'_, AppState>, status: AccessibilityStatus) -> AccessibilityStatus {
  let mut previous = state.accessibility.lock().unwrap();
  let changed = previous.map(|value| value != status.granted).unwrap_or(true);
  let became_granted = previous.map(|value| !value && status.granted).unwrap_or(status.granted);
  *previous = Some(status.granted);
  drop(previous);

  if changed {
    let message = if status.granted {
      "Accessibility permission granted! Global hotkeys are now active."
    } else {
      "Accessibility permission revoked. Global hotkeys are disabled."
    };
    let _ = app.emit(
      "accessibility-permission-changed",
      json!({ "granted": status.granted, "message": message }),
    );
  }

  if became_granted {
    if let Some(handle) = state.hotkey.lock().unwrap().as_ref().cloned() {
      hotkey::restart_os_listener(handle);
    }
  }

  status
}

#[tauri::command]
pub fn get_recent_activities() -> Result<Vec<Value>, String> {
  history::read_history_entries().map_err(stringify_error)
}

#[derive(Serialize)]
pub struct DebugAudio {
  pub bytes: Vec<u8>,
  pub mime: String,
}

// Dev-only: return the original recorded audio for a history entry so the UI can
// play it back. Errors if the file is absent (e.g. an entry without audio).
#[tauri::command]
pub fn read_debug_audio(id: String) -> Result<DebugAudio, String> {
  let (bytes, mime) = history::read_debug_audio(&id).map_err(stringify_error)?;
  Ok(DebugAudio { bytes, mime })
}

#[tauri::command]
pub fn delete_history_item(app: AppHandle, id: String) -> Result<bool, String> {
  log::info!("command:delete_history_item id={id}");
  history::delete_history_entry(&id).map_err(stringify_error)?;
  let _ = history::delete_debug_audio(&id);
  let _ = app.emit("activity-updated", ());
  Ok(true)
}

#[tauri::command]
pub fn clear_history(app: AppHandle) -> Result<bool, String> {
  log::info!("command:clear_history");
  history::clear_history_entries().map_err(stringify_error)?;
  let _ = history::clear_debug_audio();
  let _ = app.emit("activity-updated", ());
  Ok(true)
}

#[tauri::command]
pub fn get_dictionary() -> Result<String, String> {
  settings::read_config()
    .map(|config| config.dictionary)
    .map_err(stringify_error)
}

#[tauri::command]
pub fn save_dictionary(text: String) -> Result<bool, String> {
  let mut config = settings::read_config().map_err(stringify_error)?;
  config.dictionary = text;
  settings::write_config(&config).map_err(stringify_error)?;
  Ok(true)
}

pub fn current_accessibility_granted() -> bool {
  platform::accessibility_granted(false)
}

fn stringify_error<E>(error: E) -> String
where
  E: std::fmt::Display,
{
  error.to_string()
}

fn broadcast_settings_updates(app: &AppHandle, config: &AppConfig) -> Result<()> {
  app.emit(
    "shortcut-updated",
    json!({
      "recordShortcut": config.shortcut,
      "translateShortcut": config.translate_shortcut,
      // Piggyback provider+model so the input-prompt's model badge updates live
      // on save without a dedicated event (non-secret, unlike the API keys).
      "provider": config.provider,
      "model": config.model,
    }),
  )?;
  app.emit(
    "ui-language-updated",
    json!({ "language": config.ui_language }),
  )?;
  app.emit("ui-theme-updated", json!({ "theme": config.ui_theme }))?;
  Ok(())
}

fn append_activity(
  text: &str,
  success: bool,
  error: Option<String>,
  audio: Option<(Vec<u8>, String)>,
) -> Result<()> {
  // Tolerate an unreadable/corrupt history: start a fresh log rather than
  // failing, so the (atomic) write below repairs the file instead of every
  // future append inheriting the same read error.
  let mut entries = history::read_history_entries().unwrap_or_else(|err| {
    log::warn!("history unreadable, starting a fresh log: {err:#}");
    Vec::new()
  });
  let id = Utc::now().timestamp_millis().to_string();
  let mut entry = json!({
    "id": id,
    "text": text,
    "timestamp": Utc::now().to_rfc3339(),
    "success": success,
    "error": error,
  });
  // Dev-only: persist the original audio and link it to this entry.
  if let Some((bytes, mime)) = audio {
    match history::write_debug_audio(&id, &bytes, &mime) {
      Ok(()) => {
        entry["audioId"] = json!(id);
        entry["audioMime"] = json!(mime);
      }
      Err(e) => log::warn!("failed to save debug audio: {e:#}"),
    }
  }
  entries.insert(0, entry);
  if entries.len() > 100 {
    // Drop the audio files of entries falling off the 100-entry cap.
    for dropped in &entries[100..] {
      if let Some(aid) = dropped.get("audioId").and_then(Value::as_str) {
        let _ = history::delete_debug_audio(aid);
      }
    }
    entries.truncate(100);
  }
  history::write_history_entries(&entries)?;
  Ok(())
}

async fn perform_transcription_request(
  client: &reqwest::Client,
  config: &AppConfig,
  api_key: &str,
  audio_buffer: Vec<u8>,
  translate_mode: bool,
  mime_type: String,
) -> Result<String> {
  let provider = if config.provider == "groq" { "groq" } else { "openai" };
  let endpoint_root = if provider == "groq" {
    "https://api.groq.com/openai/v1"
  } else {
    "https://api.openai.com/v1"
  };
  let endpoint = if translate_mode {
    format!("{endpoint_root}/audio/translations")
  } else {
    format!("{endpoint_root}/audio/transcriptions")
  };
  let model = if translate_mode {
    if provider == "groq" {
      "whisper-large-v3".to_string()
    } else {
      "whisper-1".to_string()
    }
  } else if config.model.trim().is_empty() {
    if provider == "groq" {
      "whisper-large-v3-turbo".to_string()
    } else {
      "gpt-4o-mini-transcribe".to_string()
    }
  } else {
    config.model.clone()
  };

  let extension = if mime_type.contains("mp4") {
    "m4a"
  } else if mime_type.contains("wav") {
    "wav"
  } else {
    "webm"
  };
  let file_part = reqwest::multipart::Part::bytes(audio_buffer)
    .file_name(format!("audio.{extension}"));

  let mut form = reqwest::multipart::Form::new()
    .part("file", file_part)
    .text("model", model.clone())
    .text("response_format", "text");

  if !translate_mode {
    if config.language != "auto" && !config.language.trim().is_empty() {
      form = form.text("language", config.language.clone());
    }
    if !config.dictionary.trim().is_empty() {
      form = form.text("prompt", config.dictionary.clone());
    }
  }

  // Diagnostic: record which model ACTUALLY hits the API. Translate mode is
  // hardcoded to whisper-1 above (OpenAI's /audio/translations endpoint only
  // supports whisper-1), so the selected model is ignored there — this line is
  // the only reliable way to see the real model behind any given request. No API
  // key or transcribed text is logged (see the log setup note in lib.rs).
  log::info!(
    "transcribe: model={model} translate_mode={translate_mode} provider={provider} language={}",
    config.language
  );

  let response = client
    .post(endpoint)
    .bearer_auth(api_key)
    .multipart(form)
    .send()
    .await
    .context("failed to send transcription request")?;

  if !response.status().is_success() {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    return Err(anyhow::anyhow!("API error {status}: {body}"));
  }

  let text = response
    .text()
    .await
    .context("failed to read transcription response")?;
  Ok(text.trim().to_string())
}

fn is_cancellation_error(error: &anyhow::Error) -> bool {
  error
    .to_string()
    .contains("TRANSCRIPTION_CANCELLED")
}

fn accessibility_status(prompt: bool) -> AccessibilityStatus {
  if platform::accessibility_required() {
    let granted = platform::accessibility_granted(prompt);
    AccessibilityStatus {
      granted,
      status: if granted { "granted".into() } else { "denied".into() },
    }
  } else {
    AccessibilityStatus {
      granted: true,
      status: "not_required".into(),
    }
  }
}