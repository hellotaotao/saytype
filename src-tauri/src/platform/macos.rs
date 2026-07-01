//! macOS platform implementation.
//!
//! Accessibility + Microphone permission checks, direct CGEvent Unicode
//! insertion (guarded by a focused-field check), an explicit clipboard write via
//! `pbcopy`, opening the Accessibility settings pane, and the LaunchAgent login
//! item. This code was moved verbatim out of `commands.rs` / `settings.rs`
//! during the platform-abstraction refactor — behavior is unchanged.

use super::InsertResult;
use crate::settings::APP_IDENTIFIER;
use anyhow::{anyhow, Context, Result};
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};
use objc::runtime::Object;
use objc::{class, msg_send, sel, sel_impl};
use std::ffi::c_void;
use std::fs;
use std::process::Command;
use std::time::Duration;

pub fn accessibility_required() -> bool {
  true
}

pub fn accessibility_granted(prompt: bool) -> bool {
  let key = CFString::new("AXTrustedCheckOptionPrompt");
  let value = if prompt {
    CFBoolean::true_value()
  } else {
    CFBoolean::false_value()
  };
  let dict = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);

  unsafe { AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as *const c_void) }
}

#[allow(unexpected_cfgs)]
pub fn microphone_status() -> String {
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

pub fn open_accessibility_settings() {
  let _ = Command::new("open")
    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    .status();
}

// Explicit, user-initiated clipboard write — used ONLY by the input-prompt's
// "insertion failed → click Copy" affordance. We go through pbcopy (not the
// webview's navigator.clipboard) because that window is created focus:false so
// the target app keeps keyboard focus for CGEvent insertion, and clipboard
// writes from an unfocused WebKit document are unreliable. There is still no
// AUTOMATIC clipboard touch anywhere — this only fires on a real button click.
pub fn copy_to_clipboard(text: &str) -> Result<()> {
  use std::io::Write;
  use std::process::Stdio;
  let mut child = Command::new("pbcopy")
    .stdin(Stdio::piped())
    .spawn()
    .context("failed to spawn pbcopy")?;
  child
    .stdin
    .as_mut()
    .ok_or_else(|| anyhow!("failed to open pbcopy stdin"))?
    .write_all(text.as_bytes())
    .context("failed to write to pbcopy")?;
  let status = child.wait().context("failed to wait for pbcopy")?;
  if !status.success() {
    return Err(anyhow!("pbcopy exited with a non-zero status"));
  }
  Ok(())
}

pub fn insert_text(text: &str) -> InsertResult {
  if !accessibility_granted(false) {
    // Without Accessibility we can neither synthesize keystrokes nor introspect
    // focus; the text is in History, so report failure and let the prompt offer
    // the "copy" affordance.
    return InsertResult::Failed;
  }

  if !focused_element_accepts_text() {
    // Nothing editable is focused (desktop, a button, window chrome) — the
    // keystrokes would land nowhere.
    return InsertResult::NoEditableTarget;
  }

  match insert_text_via_cgevent(text) {
    Ok(()) => InsertResult::Inserted {
      method: "cgevent_unicode",
    },
    Err(error) => {
      log::warn!("direct text insertion failed: {error:#}");
      InsertResult::Failed
    }
  }
}

pub fn set_auto_launch(enabled: bool) -> Result<()> {
  let agent_dir = dirs::home_dir()
    .context("failed to resolve home directory")?
    .join("Library")
    .join("LaunchAgents");
  fs::create_dir_all(&agent_dir)
    .with_context(|| format!("failed to create {}", agent_dir.display()))?;
  let plist_path = agent_dir.join(format!("{}.plist", APP_IDENTIFIER));

  if enabled {
    let executable = std::env::current_exe().context("failed to resolve executable path")?;
    let plist = format!(
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>{label}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>{executable}</string>\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <false/>\n</dict>\n</plist>\n",
      label = APP_IDENTIFIER,
      executable = executable.display(),
    );
    fs::write(&plist_path, plist)
      .with_context(|| format!("failed to write {}", plist_path.display()))?;
    let _ = Command::new("launchctl")
      .args(["unload", plist_path.to_string_lossy().as_ref()])
      .status();
    let _ = Command::new("launchctl")
      .args(["load", plist_path.to_string_lossy().as_ref()])
      .status();
  } else {
    let _ = Command::new("launchctl")
      .args(["unload", plist_path.to_string_lossy().as_ref()])
      .status();
    if plist_path.exists() {
      let _ = fs::remove_file(&plist_path);
    }
  }

  Ok(())
}

fn insert_text_via_cgevent(text: &str) -> Result<()> {
  const K_CG_HID_EVENT_TAP: u32 = 0;
  const MAX_CHARS_PER_EVENT: usize = 20;
  let utf16: Vec<u16> = text.encode_utf16().collect();

  for chunk in utf16.chunks(MAX_CHARS_PER_EVENT) {
    let key_down = unsafe { CGEventCreateKeyboardEvent(std::ptr::null_mut(), 0, true) };
    if key_down.is_null() {
      return Err(anyhow!("failed to create keyboard event"));
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

// Best-effort guard: returns false ONLY when we're confident there is no
// editable text target for the keystrokes (no focused UI element, or a focused
// element that is neither value-settable nor a known text role — e.g. the
// desktop, a button, window chrome). On ANY uncertainty it returns true, so we
// never block a valid insertion in an app with imperfect Accessibility data.
// Without this, CGEvent insertion silently "succeeds" into the void when no
// field is focused (CGEventPost cannot report whether the keystrokes landed).
fn focused_element_accepts_text() -> bool {
  unsafe {
    let system_wide = AXUIElementCreateSystemWide();
    if system_wide.is_null() {
      return true; // can't introspect — don't block insertion
    }

    let focused_attr = CFString::new("AXFocusedUIElement");
    let mut focused: *const c_void = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(
      system_wide,
      focused_attr.as_concrete_TypeRef() as *const c_void,
      &mut focused,
    );
    CFRelease(system_wide as *const c_void);
    if err != 0 || focused.is_null() {
      return false; // nothing is focused — the keys would land nowhere
    }

    // Signal 1: AXValue is settable — true for text fields / text areas.
    let value_attr = CFString::new("AXValue");
    let mut settable: u8 = 0;
    let settable_err = AXUIElementIsAttributeSettable(
      focused,
      value_attr.as_concrete_TypeRef() as *const c_void,
      &mut settable,
    );
    let value_settable = settable_err == 0 && settable != 0;

    // Signal 2: a known text-bearing role (e.g. Terminal's AXTextArea, whose
    // value isn't "settable" in the AX sense but still accepts keystrokes).
    let mut text_role = false;
    let role_attr = CFString::new("AXRole");
    let mut role_ref: *const c_void = std::ptr::null();
    let role_err = AXUIElementCopyAttributeValue(
      focused,
      role_attr.as_concrete_TypeRef() as *const c_void,
      &mut role_ref,
    );
    if role_err == 0 && !role_ref.is_null() {
      let role = CFString::wrap_under_create_rule(role_ref as CFStringRef).to_string();
      text_role = matches!(
        role.as_str(),
        "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField"
      );
    }

    CFRelease(focused);
    value_settable || text_role
  }
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
  fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
  fn CGEventCreateKeyboardEvent(source: *mut c_void, virtualKey: u16, keyDown: bool) -> *mut c_void;
  fn CGEventKeyboardSetUnicodeString(event: *mut c_void, stringLength: usize, unicodeString: *const u16);
  fn CGEventPost(tap: u32, event: *mut c_void);
  fn AXUIElementCreateSystemWide() -> *const c_void;
  fn AXUIElementCopyAttributeValue(element: *const c_void, attribute: *const c_void, value: *mut *const c_void) -> i32;
  fn AXUIElementIsAttributeSettable(element: *const c_void, attribute: *const c_void, settable: *mut u8) -> i32;
}

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
  fn CFRelease(cf: *const c_void);
}
