use crate::hotkey;
use crate::history;
use crate::settings::{self, AppConfig, SettingsPayload, TRANSLATE_SHORTCUT};
use crate::state::AppState;
use anyhow::{Context, Result};
use arboard::Clipboard;
use chrono::Utc;
#[cfg(target_os = "macos")]
use core_foundation::base::TCFType;
#[cfg(target_os = "macos")]
use core_foundation::boolean::CFBoolean;
#[cfg(target_os = "macos")]
use core_foundation::dictionary::CFDictionary;
#[cfg(target_os = "macos")]
use core_foundation::string::CFString;
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};
#[cfg(target_os = "macos")]
use objc::runtime::Object;
use serde::Serialize;
use serde_json::{json, Value};
#[cfg(target_os = "macos")]
use std::ffi::c_void;
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::time::sleep;
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
  settings::update_auto_launch(config.auto_launch).map_err(stringify_error)?;

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
  audio_buffer: Vec<u8>,
  translate_mode: Option<bool>,
  mime_type: Option<String>,
) -> Result<String, String> {
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

  let result = tokio::select! {
    _ = cancellation.cancelled() => Err(anyhow::anyhow!("TRANSCRIPTION_CANCELLED")),
    result = perform_transcription_request(
      &state.http_client,
      &config,
      &api_key,
      audio_buffer,
      translate_mode.unwrap_or(false),
      mime_type.unwrap_or_else(|| "audio/webm".into()),
    ) => result,
  };

  state.active_transcriptions.lock().unwrap().remove(&request_id);

  match result {
    Ok(text) => {
      append_activity(&text, true, None).map_err(stringify_error)?;
      let _ = app.emit("activity-updated", ());
      Ok(text)
    }
    Err(error) => {
      if is_cancellation_error(&error) {
        return Err("TRANSCRIPTION_CANCELLED".into());
      }

      let mode = if translate_mode.unwrap_or(false) {
        "Translation"
      } else {
        "Transcription"
      };
      let message = format!("{mode} failed: {}", error);
      append_activity(&message, false, Some(error.to_string())).map_err(stringify_error)?;
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

  #[cfg(target_os = "macos")]
  {
    let accessibility_granted = current_accessibility_granted();

    if accessibility_granted {
      match insert_text_via_cgevent(&text) {
        Ok(()) => {
          return Ok(TypeTextResponse {
            success: true,
            method: Some("cgevent_unicode".into()),
            message: Some("Text inserted directly via macOS CGEvent.".into()),
            skipped_no_text: false,
          });
        }
        Err(error) => {
          log::warn!("direct text insertion failed, falling back to clipboard: {error:#}");
        }
      }
    }

    return clipboard_insert_text(&text, accessibility_granted).await.map_err(stringify_error);
  }

  #[cfg(not(target_os = "macos"))]
  {
    clipboard_insert_text(&text, false).await.map_err(stringify_error)
  }
}

#[tauri::command]
pub fn show_permission_dialog() -> Result<i32, String> {
  #[cfg(target_os = "macos")]
  {
    let _ = Command::new("open")
      .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
      .status();
  }

  Ok(0)
}

#[tauri::command]
pub fn check_microphone_permission() -> MicrophoneStatus {
  #[cfg(target_os = "macos")]
  {
    MicrophoneStatus {
      status: macos_microphone_permission_status(),
    }
  }

  #[cfg(not(target_os = "macos"))]
  {
    MicrophoneStatus {
      status: "granted".into(),
    }
  }
}

#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)]
fn macos_microphone_permission_status() -> String {
  const AV_AUTHORIZATION_STATUS_NOT_DETERMINED: i32 = 0;
  const AV_AUTHORIZATION_STATUS_RESTRICTED: i32 = 1;
  const AV_AUTHORIZATION_STATUS_DENIED: i32 = 2;
  const AV_AUTHORIZATION_STATUS_AUTHORIZED: i32 = 3;

  let media_type = CFString::new("soun");
  let status: i32 = unsafe {
    msg_send![
      class!(AVCaptureDevice),
      authorizationStatusForMediaType: media_type.as_concrete_TypeRef() as *mut Object
    ]
  };

  match status {
    AV_AUTHORIZATION_STATUS_NOT_DETERMINED => "not-determined",
    AV_AUTHORIZATION_STATUS_RESTRICTED => "restricted",
    AV_AUTHORIZATION_STATUS_DENIED => "denied",
    AV_AUTHORIZATION_STATUS_AUTHORIZED => "granted",
    _ => "not-determined",
  }
  .into()
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
  #[cfg(target_os = "macos")]
  {
    accessibility_status(false).granted
  }

  #[cfg(not(target_os = "macos"))]
  {
    true
  }
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
    }),
  )?;
  app.emit(
    "ui-language-updated",
    json!({ "language": config.ui_language }),
  )?;
  app.emit("ui-theme-updated", json!({ "theme": config.ui_theme }))?;
  Ok(())
}

fn append_activity(text: &str, success: bool, error: Option<String>) -> Result<()> {
  let mut entries = history::read_history_entries()?;
  entries.insert(
    0,
    json!({
      "id": Utc::now().timestamp_millis().to_string(),
      "text": text,
      "timestamp": Utc::now().to_rfc3339(),
      "success": success,
      "error": error,
    }),
  );
  if entries.len() > 100 {
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

async fn clipboard_insert_text(text: &str, can_auto_paste: bool) -> Result<TypeTextResponse> {
  let mut clipboard = Clipboard::new().context("failed to access clipboard")?;
  let original_text = clipboard.get_text().ok();
  clipboard
    .set_text(text.to_string())
    .context("failed to write text to clipboard")?;

  if can_auto_paste {
    paste_via_os_shortcut()?;
    sleep(Duration::from_millis(500)).await;
    let message = if let Some(original) = original_text {
      let _ = clipboard.set_text(original);
      "Text inserted automatically (clipboard restored).".to_string()
    } else {
      "Text inserted automatically (clipboard may be partially restored).".to_string()
    };
    Ok(TypeTextResponse {
      success: true,
      method: Some("clipboard_textinsert".into()),
      message: Some(message),
      skipped_no_text: false,
    })
  } else {
    Ok(TypeTextResponse {
      success: true,
      method: Some("clipboard".into()),
      message: Some("Text copied to clipboard. Press Cmd+V to paste.".into()),
      skipped_no_text: false,
    })
  }
}

fn paste_via_os_shortcut() -> Result<()> {
  #[cfg(target_os = "macos")]
  {
    let status = Command::new("osascript")
      .args([
        "-e",
        "tell application \"System Events\" to keystroke \"v\" using command down",
      ])
      .status()
      .context("failed to run osascript")?;
    if !status.success() {
      return Err(anyhow::anyhow!("osascript exited with status {status}"));
    }
  }

  #[cfg(not(target_os = "macos"))]
  {
    return Err(anyhow::anyhow!("automatic paste is only implemented on macOS"));
  }

  Ok(())
}

#[cfg(target_os = "macos")]
fn accessibility_status(prompt: bool) -> AccessibilityStatus {
  let granted = macos_accessibility_granted(prompt);
  AccessibilityStatus {
    granted,
    status: if granted { "granted".into() } else { "denied".into() },
  }
}

#[cfg(not(target_os = "macos"))]
fn accessibility_status(_prompt: bool) -> AccessibilityStatus {
  AccessibilityStatus {
    granted: true,
    status: "not_required".into(),
  }
}

#[cfg(target_os = "macos")]
fn macos_accessibility_granted(prompt: bool) -> bool {
  let key = CFString::new("AXTrustedCheckOptionPrompt");
  let value = if prompt {
    CFBoolean::true_value()
  } else {
    CFBoolean::false_value()
  };
  let dict = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);

  unsafe { AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as *const c_void) }
}

#[cfg(target_os = "macos")]
fn insert_text_via_cgevent(text: &str) -> Result<()> {
  const K_CG_HID_EVENT_TAP: u32 = 0;
  const MAX_CHARS_PER_EVENT: usize = 20;
  let utf16: Vec<u16> = text.encode_utf16().collect();

  for chunk in utf16.chunks(MAX_CHARS_PER_EVENT) {
    let key_down = unsafe { CGEventCreateKeyboardEvent(std::ptr::null_mut(), 0, true) };
    if key_down.is_null() {
      return Err(anyhow::anyhow!("failed to create keyboard event"));
    }
    unsafe {
      CGEventKeyboardSetUnicodeString(key_down, chunk.len(), chunk.as_ptr());
      CGEventPost(K_CG_HID_EVENT_TAP, key_down);
      CFRelease(key_down as *const c_void);
    }
    std::thread::sleep(Duration::from_millis(5));
  }

  Ok(())
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
  fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
  fn CGEventCreateKeyboardEvent(source: *mut c_void, virtualKey: u16, keyDown: bool) -> *mut c_void;
  fn CGEventKeyboardSetUnicodeString(event: *mut c_void, stringLength: usize, unicodeString: *const u16);
  fn CGEventPost(tap: u32, event: *mut c_void);
}

#[cfg(target_os = "macos")]
#[link(name = "AVFoundation", kind = "framework")]
extern "C" {}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
  fn CFRelease(cf: *const c_void);
}