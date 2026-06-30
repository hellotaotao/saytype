//! Stub platform implementation for non-macOS targets (Windows, Linux).
//!
//! These preserve the app's current pre-cross-platform behavior:
//! * permissions report "not required" / "granted" (no OS gate today),
//! * synthetic insertion is unsupported (the prompt falls back to History),
//! * clipboard writes and autostart are not wired up yet.
//!
//! Each capability gets a real implementation in a later per-platform phase, at
//! which point this single `fallback` module splits into `windows` / `linux`.

use super::InsertResult;
use anyhow::{anyhow, Result};

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

pub fn insert_text(_text: &str) -> InsertResult {
  InsertResult::Unsupported
}

pub fn set_auto_launch(_enabled: bool) -> Result<()> {
  Ok(())
}
