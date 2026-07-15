use crate::hotkey;
use crate::history;
use crate::platform::{self, InsertResult};
use crate::settings::{self, AppConfig, SettingsPayload, TRANSLATE_SHORTCUT};
use crate::state::AppState;
use anyhow::{Context, Result};
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
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
  // Like dictionary: the settings form never carries this flag, and a missing
  // field deserializes to false — without this line every settings save would
  // re-trigger the onboarding wizard.
  config.onboarding_completed = existing.onboarding_completed;
  config.translate_shortcut = TRANSLATE_SHORTCUT.into();
  config.shortcut = settings::normalize_record_shortcut(&config.shortcut);
  settings::local_provider_selectable(&config.provider, crate::local_asr::assets_ready())
    .map_err(stringify_error)?;
  if config.provider == crate::local_asr::LOCAL_PROVIDER {
    // The form's key fields are hidden for the local provider; keep the stored
    // legacy key instead of clobbering it with the (empty) local selection.
    config.api_key = existing.api_key.clone();
  } else {
    config.api_key = settings::selected_api_key(&config);
  }

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

// Marks the first-launch onboarding wizard as done (finished or skipped). A
// dedicated read-modify-write command instead of save_settings because the
// latter takes a FULL AppConfig — building that in the main window would
// require shipping the API keys to it, which get_api_keys deliberately avoids.
#[tauri::command]
pub fn set_onboarding_completed() -> Result<bool, String> {
  log::info!("command:set_onboarding_completed");
  let mut config = settings::read_config().map_err(stringify_error)?;
  config.onboarding_completed = true;
  settings::write_config(&config).map_err(stringify_error)?;
  Ok(true)
}

// Onboarding page 5: set the provider + its API key without round-tripping the
// full config (keys flow INTO Rust only, never out to the main window). When
// the provider actually changes, the model is reset to that provider's default
// — otherwise a fresh config would send the OpenAI default model name to Groq.
#[tauri::command]
pub fn save_onboarding_api_key(app: AppHandle, provider: String, api_key: String) -> Result<bool, String> {
  log::info!("command:save_onboarding_api_key provider={provider}");
  let key = api_key.trim().to_string();
  if key.is_empty() {
    return Err("API key is empty".into());
  }

  let mut config = settings::read_config().map_err(stringify_error)?;
  match provider.as_str() {
    "groq" => config.api_key_groq = key,
    "openai" => config.api_key_openai = key,
    other => return Err(format!("Unknown provider: {other}")),
  }
  switch_provider(&mut config, &provider);
  // Re-derive even when the provider didn't change: the key for the already
  // selected provider may have just been (re)entered.
  config.api_key = settings::selected_api_key(&config);

  settings::write_config(&config).map_err(stringify_error)?;
  broadcast_settings_updates(&app, &config).map_err(stringify_error)?;
  Ok(true)
}

/// The model a provider lands on when it's newly selected: its recommended
/// default (same table the settings UI marks "recommended").
fn default_model_for(provider: &str) -> &'static str {
  match provider {
    "groq" => "whisper-large-v3-turbo",
    crate::local_asr::LOCAL_PROVIDER => "qwen3-asr-0.6b-q8_0",
    _ => "gpt-4o-mini-transcribe",
  }
}

/// Point `config` at `provider`, resetting the model to that provider's
/// default. Everything else (keys, dictionary, shortcuts, onboarding flag)
/// is preserved; the legacy `api_key` mirror is left alone for "local" (no
/// key to mirror — clobbering it would lose the stored cloud key).
fn switch_provider(config: &mut AppConfig, provider: &str) {
  if config.provider == provider {
    return;
  }
  config.provider = provider.to_string();
  config.model = default_model_for(provider).into();
  if provider != crate::local_asr::LOCAL_PROVIDER {
    config.api_key = settings::selected_api_key(config);
  }
}

/// Engine quick-switch core, shared by the tray submenu (direct call) and the
/// `set_provider` command (home-page switcher / wizard). Guards "local" behind
/// downloaded assets, persists, and broadcasts so every window's badges — and
/// the tray checkmarks — update live.
pub fn apply_provider_change(app: &AppHandle, provider: &str) -> Result<(), String> {
  if !matches!(provider, "groq" | "openai" | crate::local_asr::LOCAL_PROVIDER) {
    return Err(format!("Unknown provider: {provider}"));
  }
  settings::local_provider_selectable(provider, crate::local_asr::assets_ready())?;
  let mut config = settings::read_config().map_err(stringify_error)?;
  switch_provider(&mut config, provider);
  settings::write_config(&config).map_err(stringify_error)?;
  broadcast_settings_updates(app, &config).map_err(stringify_error)?;
  Ok(())
}

#[tauri::command]
pub fn set_provider(app: AppHandle, provider: String) -> Result<bool, String> {
  log::info!("command:set_provider provider={provider}");
  apply_provider_change(&app, &provider)?;
  Ok(true)
}

// Every "local isn't downloaded yet" guide (tray submenu, home switcher)
// funnels here: bring up Settings and have it reveal the model download panel.
#[tauri::command]
pub fn open_local_model_panel(app: AppHandle) -> Result<(), String> {
  log::info!("command:open_local_model_panel");
  if let Some(window) = app.get_webview_window("settings") {
    window.show().map_err(stringify_error)?;
    window.set_focus().map_err(stringify_error)?;
  }
  app
    .emit_to("settings", "open-local-model-panel", ())
    .map_err(stringify_error)?;
  Ok(())
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

/// Removes its entry from `active_transcriptions` when dropped, so the
/// bookkeeping survives every exit path — normal return, `?`, a panic inside
/// the transcription future, or the command future being dropped. Without it a
/// panicking request would leave its stale token in the map forever, making
/// cancel_transcription report "cancelled something" on an idle app.
struct ActiveTranscriptionGuard<'a> {
  map: &'a Mutex<HashMap<u64, CancellationToken>>,
  id: u64,
}

impl Drop for ActiveTranscriptionGuard<'_> {
  fn drop(&mut self) {
    // Skip cleanup on a poisoned lock rather than double-panic during unwind.
    if let Ok(mut map) = self.map.lock() {
      map.remove(&self.id);
    }
  }
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
  let route = resolve_transcription_route(&config, translate_mode)?;

  let request_id = state.next_transcription_id.fetch_add(1, Ordering::Relaxed) + 1;
  let cancellation = CancellationToken::new();
  state
    .active_transcriptions
    .lock()
    .unwrap()
    .insert(request_id, cancellation.clone());
  let active_transcription = ActiveTranscriptionGuard {
    map: &state.active_transcriptions,
    id: request_id,
  };

  // Dev-only: keep a copy of the exact bytes we send, so history can play the
  // recording back (for diagnosing first-word drop / quality). Never in release.
  let audio_for_debug =
    cfg!(debug_assertions).then(|| (audio_buffer.clone(), mime.clone()));

  let result = tokio::select! {
    _ = cancellation.cancelled() => Err(anyhow::anyhow!("TRANSCRIPTION_CANCELLED")),
    result = async {
      match &route {
        TranscriptionRoute::Local => perform_local_transcription(audio_buffer, &mime).await,
        TranscriptionRoute::Cloud { provider, api_key } => {
          perform_transcription_request(
            &state.http_client,
            &config,
            provider,
            api_key,
            audio_buffer,
            translate_mode,
            mime.clone(),
          ).await
        }
      }
    } => result,
  };

  drop(active_transcription);

  match result {
    Ok(raw) => {
      // Strip known Whisper hallucination boilerplate (明镜与点点 outros etc.)
      // before the text reaches history or insertion — see scrub.rs / TODO #10.
      let text = crate::scrub::scrub_transcription(&raw);
      if text != raw {
        // Counts only — the "no transcribed text in logs" promise holds.
        log::info!(
          "transcribe: scrubbed hallucination boilerplate ({} -> {} chars)",
          raw.chars().count(),
          text.chars().count()
        );
      }
      if text.is_empty() {
        // The entire output was boilerplate. Return the empty string (the
        // frontend renders it as the no-speech state) without logging an
        // empty history row.
        return Ok(text);
      }
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

// Shape-only text diagnostics (counts, never content — the "no transcribed
// text in logs" promise holds). `shape` is the same metric computed by the
// sender in JS; a mismatch between the two pins IPC-leg text corruption.
fn text_shape(text: &str) -> String {
  let (mut chars, mut cjk, mut latin1) = (0usize, 0usize, 0usize);
  for c in text.chars() {
    chars += 1;
    let u = c as u32;
    if (0x3000..=0x9FFF).contains(&u) {
      cjk += 1;
    } else if (0x80..=0xFF).contains(&u) {
      latin1 += 1;
    }
  }
  format!("chars={chars} cjk={cjk} latin1sup={latin1}")
}

#[tauri::command]
pub async fn type_text(
  _state: State<'_, AppState>,
  text: String,
  shape: Option<String>,
) -> Result<TypeTextResponse, String> {
  log::warn!(
    "diag:type_text rust[{}] js[{}]",
    text_shape(&text),
    shape.as_deref().unwrap_or("-")
  );
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

// Onboarding: deep link to the Microphone privacy pane, for when the user
// denied the system prompt and needs to flip the toggle manually.
#[tauri::command]
pub fn open_microphone_settings() -> Result<(), String> {
  platform::open_microphone_settings();
  Ok(())
}

// Accessibility recovery: reveal the app bundle in Finder so the user can
// drag it into the Accessibility list — the drop equals clicking "+". Needed
// when the row is absent and the one-shot system prompt won't re-add it
// (typically after the user once removed SayType from the list).
#[tauri::command]
pub fn reveal_app_in_finder() -> Result<(), String> {
  platform::reveal_app_in_finder();
  Ok(())
}

// Explicit, user-initiated clipboard write — used ONLY by the input-prompt's
// "insertion failed → click Copy" affordance. The per-OS mechanism (pbcopy on
// macOS) lives behind `platform::copy_to_clipboard`. There is still no
// AUTOMATIC clipboard touch anywhere — this only fires on a real button click.
#[tauri::command]
pub fn copy_to_clipboard(text: String, shape: Option<String>) -> Result<bool, String> {
  log::warn!(
    "diag:copy_to_clipboard rust[{}] js[{}]",
    text_shape(&text),
    shape.as_deref().unwrap_or("-")
  );
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

// --- Local ASR asset management (settings window) ---

#[tauri::command]
pub async fn download_local_model(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
  log::info!("command:download_local_model");
  let cancel = CancellationToken::new();
  {
    let mut slot = state.local_model_download.lock().unwrap();
    if slot.is_some() {
      return Err("Model download already in progress".into());
    }
    *slot = Some(cancel.clone());
  }

  let result = crate::local_asr::download_model(app.clone(), cancel).await;
  *state.local_model_download.lock().unwrap() = None;

  let status = crate::local_asr::model_status(false);
  match result {
    Ok(()) => {
      let _ = app.emit(
        "local-model-download-progress",
        json!({ "state": "ready", "downloadedBytes": status.downloaded_bytes, "totalBytes": status.total_bytes }),
      );
      Ok(true)
    }
    Err(err) if err == "DOWNLOAD_CANCELLED" => {
      let _ = app.emit(
        "local-model-download-progress",
        json!({ "state": "cancelled", "downloadedBytes": status.downloaded_bytes, "totalBytes": status.total_bytes }),
      );
      Ok(false)
    }
    Err(err) => {
      let _ = app.emit(
        "local-model-download-progress",
        json!({ "state": "error", "downloadedBytes": status.downloaded_bytes, "totalBytes": status.total_bytes, "message": err }),
      );
      Err(err)
    }
  }
}

#[tauri::command]
pub fn cancel_local_model_download(state: State<'_, AppState>) -> Result<bool, String> {
  log::info!("command:cancel_local_model_download");
  if let Some(token) = state.local_model_download.lock().unwrap().as_ref() {
    token.cancel();
    return Ok(true);
  }
  Ok(false)
}

#[tauri::command]
pub fn get_local_model_status(state: State<'_, AppState>) -> crate::local_asr::ModelStatus {
  let downloading = state.local_model_download.lock().unwrap().is_some();
  crate::local_asr::model_status(downloading)
}

#[tauri::command]
pub fn delete_local_model(state: State<'_, AppState>) -> Result<bool, String> {
  log::info!("command:delete_local_model");
  if state.local_model_download.lock().unwrap().is_some() {
    return Err("Cancel the running download first".into());
  }
  crate::local_asr::delete_model()?;
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
  // The tray's Engine checkmarks mirror config.provider; every config write
  // funnels through here, so this keeps them in sync with all three switch
  // surfaces (settings form, tray, home switcher/wizard).
  crate::tray::refresh_menu(app);
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

// A strong, richly-punctuated Chinese example appended to the transcription
// `prompt` — but ONLY for Whisper + Chinese (see `build_transcription_prompt`).
//
// Whisper-family models treat the `prompt` as a *style example*, NOT an
// instruction: they mirror its punctuation density rather than obeying "add
// punctuation". Verified on real audio (2026-07-02) — with no prompt, or an
// unpunctuated word-list dictionary, Groq `whisper-large-v3-turbo` returns a
// wall of text with ZERO punctuation for Chinese; prepend this seed and
// punctuation comes back reliably and deterministically (a hard clip went
// 0 → 12 marks, identical across repeated runs). It says "简体中文" to pin
// Simplified output, and must stay multi-sentence carrying all four marks
// (。，？！): a one-liner lost to the user's comma-list dictionary on the hard
// clip, while this held.
//
// Chinese-ONLY on purpose. Whisper's zero-punctuation collapse is a CJK/Chinese
// trait; high-resource languages punctuate acceptably on their own, and
// gpt-4o-transcribe punctuates everywhere by default. Injecting an unverified,
// possibly wrong-script seed into another language could only hurt — so every
// non-Chinese language (and every gpt-4o model) gets no seed at all.
//
// NOTE: this literal is mirrored in `src/views/main.html` (`#punctuation-seed`,
// in the Dictionary page) for the read-only display — keep the two in sync.
pub const SEED_ZH: &str =
  "以下是一段简体中文语音的转写记录。你好，欢迎使用听写工具。今天的会议进展如何？太好了，我们继续！";

fn is_chinese(language: &str) -> bool {
  language.trim().to_lowercase().starts_with("zh")
}

/// Build the transcription `prompt` from the resolved model, the dictation
/// language, and the user's vocabulary dictionary.
///
/// A punctuation seed is added only for **Whisper + Chinese**: it's appended
/// LAST, closest to the audio, where Whisper weights style most heavily
/// (verified: seed-last beats seed-first), and is injected even with an empty
/// dictionary. Every other case — a gpt-4o model (already punctuates) or any
/// non-Chinese language — passes the dictionary through unchanged, or sends no
/// prompt at all when the dictionary is empty.
fn build_transcription_prompt(model: &str, language: &str, dictionary: &str) -> Option<String> {
  let dict = dictionary.trim();
  let seed_chinese = !model.to_lowercase().contains("gpt-4o") && is_chinese(language);
  if seed_chinese {
    if dict.is_empty() {
      Some(SEED_ZH.to_string())
    } else {
      Some(format!("{dict}\n{SEED_ZH}"))
    }
  } else if dict.is_empty() {
    None
  } else {
    Some(dict.to_string())
  }
}

#[derive(Debug)]
pub enum TranscriptionRoute {
  Local,
  Cloud { provider: &'static str, api_key: String },
}

/// Decide where this transcription goes. Local provider transcribes locally;
/// translate mode is the exception — Qwen3-ASR only transcribes, so translation
/// falls back to whichever cloud key is configured (Groq preferred: cheaper,
/// and its whisper-large-v3 is the existing translate default).
pub fn resolve_transcription_route(
  config: &AppConfig,
  translate_mode: bool,
) -> Result<TranscriptionRoute, String> {
  if config.provider == crate::local_asr::LOCAL_PROVIDER {
    if !translate_mode {
      return Ok(TranscriptionRoute::Local);
    }
    if !config.api_key_groq.trim().is_empty() {
      return Ok(TranscriptionRoute::Cloud { provider: "groq", api_key: config.api_key_groq.trim().into() });
    }
    if !config.api_key_openai.trim().is_empty() {
      return Ok(TranscriptionRoute::Cloud { provider: "openai", api_key: config.api_key_openai.trim().into() });
    }
    return Err(
      "Translation needs a cloud API key (the local model only transcribes). Add a Groq or OpenAI key in Settings.".into(),
    );
  }
  let provider = if config.provider == "groq" { "groq" } else { "openai" };
  let api_key = settings::selected_api_key(config);
  if api_key.trim().is_empty() {
    return Err("API key not configured".into());
  }
  Ok(TranscriptionRoute::Cloud { provider, api_key })
}

/// Local decode: hand the (frontend-guaranteed) WAV to the subprocess runner.
/// Lives inside the caller's tokio::select! — dropping this future kills the
/// child process (kill_on_drop), so cancel truly aborts the decode.
async fn perform_local_transcription(audio_buffer: Vec<u8>, mime_type: &str) -> Result<String> {
  if !mime_type.contains("wav") {
    return Err(anyhow::anyhow!(
      "local transcription expects WAV audio, got {mime_type} (frontend must re-encode)"
    ));
  }
  crate::local_asr::transcribe_wav(&audio_buffer).await.map_err(|err| {
    if err.to_string().starts_with("LOCAL_MODEL_MISSING") {
      anyhow::anyhow!("Local model files are missing — download the model again in Settings.")
    } else {
      err
    }
  })
}

async fn perform_transcription_request(
  client: &reqwest::Client,
  config: &AppConfig,
  provider: &str,
  api_key: &str,
  audio_buffer: Vec<u8>,
  translate_mode: bool,
  mime_type: String,
) -> Result<String> {
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
    if let Some(prompt) = build_transcription_prompt(&model, &config.language, &config.dictionary) {
      form = form.text("prompt", prompt);
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

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<crate::updater::UpdateStatus, String> {
  log::info!("command:check_for_updates");
  Ok(crate::updater::check_and_download(&app).await)
}

#[tauri::command]
pub fn get_update_status(app: AppHandle) -> crate::updater::UpdateStatus {
  crate::updater::current_status(&app)
}

#[tauri::command]
pub fn install_update_and_restart(app: AppHandle) -> Result<(), String> {
  log::info!("command:install_update_and_restart");
  crate::updater::install_pending_and_restart(&app)
}

#[cfg(test)]
mod tests {
  use super::*;

  // --- Engine switch: model reset + config preservation ---

  #[test]
  fn switch_provider_resets_model_to_the_new_providers_default() {
    let mut config = AppConfig::default(); // openai / gpt-4o-mini-transcribe
    switch_provider(&mut config, "groq");
    assert_eq!(config.provider, "groq");
    assert_eq!(config.model, "whisper-large-v3-turbo");
    switch_provider(&mut config, "local");
    assert_eq!(config.model, "qwen3-asr-0.6b-q8_0");
    switch_provider(&mut config, "openai");
    assert_eq!(config.model, "gpt-4o-mini-transcribe");
  }

  #[test]
  fn switch_provider_same_provider_keeps_custom_model() {
    let mut config = AppConfig::default();
    config.model = "whisper-1".into();
    switch_provider(&mut config, "openai");
    assert_eq!(config.model, "whisper-1");
  }

  #[test]
  fn switch_provider_preserves_keys_and_dictionary() {
    let mut config = AppConfig::default();
    config.api_key_groq = "gsk_x".into();
    config.api_key_openai = "sk_x".into();
    config.api_key = "sk_x".into();
    config.dictionary = "Claude".into();
    config.onboarding_completed = true;

    // → local: the legacy api_key mirror must survive (no key to mirror).
    switch_provider(&mut config, "local");
    assert_eq!(config.api_key, "sk_x");
    assert_eq!(config.api_key_groq, "gsk_x");
    assert_eq!(config.dictionary, "Claude");
    assert!(config.onboarding_completed);

    // → groq: the mirror follows the newly selected provider's key.
    switch_provider(&mut config, "groq");
    assert_eq!(config.api_key, "gsk_x");
    assert_eq!(config.api_key_openai, "sk_x");
  }

  // --- ActiveTranscriptionGuard: cleanup must survive every exit path ---

  #[test]
  fn transcription_guard_removes_its_entry_on_drop() {
    let map = Mutex::new(HashMap::new());
    map.lock().unwrap().insert(7, CancellationToken::new());
    {
      let _guard = ActiveTranscriptionGuard { map: &map, id: 7 };
    }
    assert!(map.lock().unwrap().is_empty());
  }

  #[test]
  fn transcription_guard_removes_its_entry_during_panic_unwind() {
    // The whole point of the guard: a panic inside the transcription future
    // must not leave a stale token behind.
    let map = Mutex::new(HashMap::new());
    map.lock().unwrap().insert(7, CancellationToken::new());
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
      let _guard = ActiveTranscriptionGuard { map: &map, id: 7 };
      panic!("simulated transcription panic");
    }));
    assert!(panicked.is_err());
    assert!(map.lock().unwrap().is_empty());
  }

  #[test]
  fn transcription_guard_only_removes_its_own_entry() {
    let map = Mutex::new(HashMap::new());
    map.lock().unwrap().insert(7, CancellationToken::new());
    map.lock().unwrap().insert(8, CancellationToken::new());
    drop(ActiveTranscriptionGuard { map: &map, id: 7 });
    let remaining = map.lock().unwrap();
    assert!(!remaining.contains_key(&7));
    assert!(remaining.contains_key(&8));
  }

  // --- Whisper + Chinese: the seed is injected, placed LAST ---

  #[test]
  fn whisper_chinese_empty_dictionary_gets_the_seed() {
    // Bug repro: no prompt at all -> Whisper emits zero punctuation for Chinese,
    // so the seed must be injected even with an empty dictionary.
    let p = build_transcription_prompt("whisper-large-v3-turbo", "zh", "").unwrap();
    assert_eq!(p, SEED_ZH);
    assert!(p.contains('。') && p.contains('？') && p.contains('！'));
  }

  #[test]
  fn whisper_chinese_appends_seed_after_dictionary() {
    // Seed sits LAST (closest to the audio); the vocabulary comes first.
    let dict = "Claude\nAzure";
    let p = build_transcription_prompt("whisper-large-v3-turbo", "zh", dict).unwrap();
    assert_eq!(p, format!("{dict}\n{SEED_ZH}"));
    assert!(p.starts_with(dict) && p.ends_with(SEED_ZH));
    assert!(p.find(SEED_ZH).unwrap() > p.find("Claude").unwrap());
  }

  #[test]
  fn whisper_chinese_trims_dictionary_whitespace() {
    let p = build_transcription_prompt("whisper-large-v3-turbo", "zh", "  \n Claude \n ").unwrap();
    assert_eq!(p, format!("Claude\n{SEED_ZH}"));
  }

  #[test]
  fn chinese_detection_is_case_and_region_insensitive() {
    // Any zh* code counts as Chinese and is seeded. (There is no Traditional
    // option in the app today; a zh-TW user would still get the Simplified seed —
    // an accepted limitation, revisit if Traditional is ever offered.)
    for lang in ["zh", "ZH", "zh-Hans", "zh-CN", "zh-TW"] {
      let p = build_transcription_prompt("whisper-large-v3-turbo", lang, "").unwrap();
      assert_eq!(p, SEED_ZH, "language {lang:?} should be seeded as Chinese");
    }
  }

  // --- Non-Chinese languages: NO seed (dictionary passes through, or nothing) ---

  #[test]
  fn whisper_non_chinese_is_never_seeded() {
    for lang in ["en", "en-AU", "ja", "es", "auto", ""] {
      // empty dictionary -> no prompt at all
      assert_eq!(
        build_transcription_prompt("whisper-large-v3-turbo", lang, ""),
        None,
        "language {lang:?} should send no prompt when the dictionary is empty"
      );
      // non-empty dictionary -> passed through verbatim, never seeded
      let p = build_transcription_prompt("whisper-large-v3-turbo", lang, "Claude").unwrap();
      assert_eq!(p, "Claude", "language {lang:?} must not be seeded");
      assert!(!p.contains(SEED_ZH));
    }
  }

  // --- gpt-4o family: never seeded, even for Chinese (it already punctuates) ---

  #[test]
  fn gpt4o_is_never_seeded_even_for_chinese() {
    for model in ["gpt-4o-transcribe", "gpt-4o-mini-transcribe"] {
      assert_eq!(build_transcription_prompt(model, "zh", ""), None);
      assert_eq!(build_transcription_prompt(model, "zh", "   "), None);
      let p = build_transcription_prompt(model, "zh", "Claude\nAzure").unwrap();
      assert_eq!(p, "Claude\nAzure");
      assert!(!p.contains(SEED_ZH) && !p.contains('。'));
    }
  }

  // --- Transcription routing: local vs cloud ---

  fn config_with(provider: &str, groq: &str, openai: &str) -> AppConfig {
    let mut c = AppConfig::default();
    c.provider = provider.into();
    c.api_key_groq = groq.into();
    c.api_key_openai = openai.into();
    c
  }

  #[test]
  fn local_provider_routes_to_local_for_normal_dictation() {
    let route = resolve_transcription_route(&config_with("local", "", ""), false).unwrap();
    assert!(matches!(route, TranscriptionRoute::Local));
  }

  #[test]
  fn local_translate_falls_back_to_a_cloud_key_groq_first() {
    match resolve_transcription_route(&config_with("local", "gsk", "osk"), true).unwrap() {
      TranscriptionRoute::Cloud { provider, api_key } => {
        assert_eq!(provider, "groq");
        assert_eq!(api_key, "gsk");
      }
      other => panic!("expected cloud, got {other:?}"),
    }
    match resolve_transcription_route(&config_with("local", "", "osk"), true).unwrap() {
      TranscriptionRoute::Cloud { provider, api_key } => {
        assert_eq!(provider, "openai");
        assert_eq!(api_key, "osk");
      }
      other => panic!("expected cloud, got {other:?}"),
    }
  }

  #[test]
  fn local_translate_without_any_cloud_key_errors_clearly() {
    let err = resolve_transcription_route(&config_with("local", "", ""), true).unwrap_err();
    assert!(err.contains("cloud API key"), "{err}");
  }

  #[test]
  fn cloud_providers_route_unchanged_and_require_a_key() {
    match resolve_transcription_route(&config_with("groq", "gsk", ""), false).unwrap() {
      TranscriptionRoute::Cloud { provider, api_key } => {
        assert_eq!(provider, "groq");
        assert_eq!(api_key, "gsk");
      }
      other => panic!("{other:?}"),
    }
    assert!(resolve_transcription_route(&config_with("openai", "", ""), false).is_err());
  }
}