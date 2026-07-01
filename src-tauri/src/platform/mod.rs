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
  /// `"cgevent_unicode"` on macOS, `"enigo_text"` on Windows/Linux) for the
  /// frontend / diagnostics.
  Inserted { method: &'static str },
  /// The mechanism is available, but nothing editable is focused — the
  /// keystrokes would land nowhere, so the prompt should offer "copy" instead.
  /// Only macOS detects this (Accessibility focus check), so it reads as dead
  /// code on non-macOS builds.
  #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
  NoEditableTarget,
  /// Insertion was attempted and failed, or the permission it needs is not
  /// granted. The transcription is still saved to History.
  Failed,
}
