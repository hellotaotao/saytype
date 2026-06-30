//! Platform abstraction layer.
//!
//! Every OS-specific capability the app needs — synthetic text insertion,
//! permission checks, clipboard writes, and the login-item autostart — lives
//! behind this module so the command/handler layer (`commands.rs`,
//! `settings.rs`) stays platform-agnostic. The right implementation is selected
//! at compile time:
//!
//! * `macos`    — the real macOS implementation (CGEvent insertion, AX /
//!                AVFoundation permission checks, pbcopy, LaunchAgent).
//! * `fallback` — every other target (Windows, Linux). For now these are the
//!                app's pre-cross-platform stubs ("not yet supported"); when we
//!                fill a platform in, `fallback` splits into `windows`/`linux`.
//!
//! ## Contract
//!
//! Each backing module MUST provide these free functions with identical
//! signatures (the compiler enforces it via the call sites below when built for
//! that target):
//!
//! ```ignore
//! fn accessibility_required() -> bool;
//! fn accessibility_granted(prompt: bool) -> bool;
//! fn microphone_status() -> String;
//! fn open_accessibility_settings();
//! fn copy_to_clipboard(text: &str) -> anyhow::Result<()>;
//! fn insert_text(text: &str) -> InsertResult;
//! fn set_auto_launch(enabled: bool) -> anyhow::Result<()>;
//! ```

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(target_os = "macos"))]
mod fallback;
#[cfg(not(target_os = "macos"))]
pub use fallback::*;

/// Outcome of a synthetic text-insertion attempt.
///
/// Platforms report *what happened*; the caller (`commands::type_text`) maps
/// each variant to the user-facing message, so all the copy stays in one place.
#[derive(Debug)]
pub enum InsertResult {
  /// Text was injected directly. `method` names the mechanism (e.g.
  /// `"cgevent_unicode"`) for the frontend / diagnostics.
  Inserted { method: &'static str },
  /// The mechanism is available, but nothing editable is focused — the
  /// keystrokes would land nowhere, so the prompt should offer "copy" instead.
  NoEditableTarget,
  /// Insertion was attempted and failed, or the permission it needs is not
  /// granted. The transcription is still saved to History.
  Failed,
  /// This platform has no insertion implementation yet. Constructed only by the
  /// non-macOS `fallback` impl, so it reads as dead code on a macOS-only build.
  #[cfg_attr(target_os = "macos", allow(dead_code))]
  Unsupported,
}
