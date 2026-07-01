//! Platform implementation for non-macOS targets (Windows, Linux).
//!
//! * text insertion: synthetic Unicode typing via `enigo` (SendInput on Windows,
//!   XTEST/libxdo on Linux/X11) — layout-independent, no special permission,
//!   works with CJK/emoji.
//! * permissions: report "not required" / "granted" (Windows/X11 have no gate;
//!   the mic prompt is handled by the webview at capture time).
//! * clipboard write and autostart are not wired up yet.
//!
//! Shared by Windows and Linux while their behavior is identical; splits into
//! `windows` / `linux` when Linux needs Wayland-specific handling.

use super::InsertResult;
use anyhow::{anyhow, Result};
use enigo::{Enigo, Keyboard, Settings};

pub fn accessibility_required() -> bool {
  false
}

pub fn accessibility_granted(_prompt: bool) -> bool {
  true
}

pub fn microphone_status() -> String {
  "granted".into()
}

pub fn open_accessibility_settings() {}

pub fn copy_to_clipboard(_text: &str) -> Result<()> {
  Err(anyhow!("Clipboard write is not supported on this platform"))
}

pub fn insert_text(text: &str) -> InsertResult {
  // enigo drives SendInput (KEYEVENTF_UNICODE) on Windows and XTEST/libxdo on
  // Linux/X11 — layout-independent Unicode, so CJK/emoji go through. No special
  // permission needed. On any failure the transcription is still in History, so
  // report Failed and let the prompt offer the manual "Copy" affordance.
  let mut enigo = match Enigo::new(&Settings::default()) {
    Ok(enigo) => enigo,
    Err(error) => {
      log::warn!("failed to initialize enigo for text insertion: {error}");
      return InsertResult::Failed;
    }
  };
  match enigo.text(text) {
    Ok(()) => InsertResult::Inserted {
      method: "enigo_text",
    },
    Err(error) => {
      log::warn!("enigo text insertion failed: {error}");
      InsertResult::Failed
    }
  }
}

pub fn set_auto_launch(_enabled: bool) -> Result<()> {
  Ok(())
}
