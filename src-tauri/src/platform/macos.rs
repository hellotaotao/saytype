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

pub fn open_microphone_settings() {
  let _ = Command::new("open")
    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
    .status();
}

/// 上溯三级找 `.app` bundle(exe = SayType.app/Contents/MacOS/x)。
/// 裸二进制(dev 构建)返回 None。
fn app_bundle_of(exe: &std::path::Path) -> Option<&std::path::Path> {
  exe
    .ancestors()
    .nth(3)
    .filter(|path| path.extension().is_some_and(|ext| ext == "app"))
}

/// What to reveal in Finder for "drag SayType into the Accessibility list":
/// the .app bundle when running installed, else the bare executable.
fn finder_reveal_target(exe: &std::path::Path) -> &std::path::Path {
  app_bundle_of(exe).unwrap_or(exe)
}

/// 拖拽云朵的负载路径。**只有真正的 bundle 才有意义**——裸二进制拖进辅助功能
/// 列表不会让 SayType 获得权限,所以此时返回 None,调用方据此不显示云朵。
pub fn app_bundle_path() -> Option<std::path::PathBuf> {
  let exe = std::env::current_exe().ok()?;
  app_bundle_of(&exe).map(std::path::Path::to_path_buf)
}

/// Bring the "app was activated" signal (Cmd+Tab, app switcher) to the caller.
/// Tauri's `RunEvent::Reopen` only covers Launch Services opens — Dock click,
/// Spotlight, `open -a` — so activation needs AppKit's own notification; see
/// `platform::activation`.
pub fn watch_app_activation(on_activate: super::ActivationCallback) {
  super::activation::watch(on_activate);
}

/// Attach the drag layer on the cloud window's NSView. Not attached (returns
/// false) when there is no .app bundle (a dev bare binary).
pub fn attach_app_drag_source(ns_view: *mut c_void) -> bool {
  match app_bundle_path() {
    Some(bundle) => super::drag_cloud::attach(ns_view, &bundle),
    None => false,
  }
}

// Recovery path for the one case the prompt+deep-link flow can't fix: after
// the user removes SayType from the Accessibility list, TCC's re-registration
// via the prompt is unreliable, so the row may never reappear. Dropping the
// app file onto the list (same as clicking "+") always works — this reveals
// the bundle in Finder so the user can drag it in.
pub fn reveal_app_in_finder() {
  if let Ok(exe) = std::env::current_exe() {
    let _ = Command::new("open")
      .arg("-R")
      .arg(finder_reveal_target(&exe))
      .status();
  }
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
  // pbcopy decodes its stdin using the process locale. A GUI/LaunchAgent-
  // launched app inherits no LANG/LC_*, so pbcopy falls back to MacRoman and
  // reads our UTF-8 bytes as Latin garbage — Chinese "我" (E6 88 91) lands on
  // the pasteboard as "Êàë". Force a UTF-8 locale so multibyte text round-trips.
  let mut child = Command::new("pbcopy")
    .env("LC_ALL", "en_US.UTF-8")
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
    // Best-effort: unload fails whenever the agent isn't currently loaded.
    let _ = Command::new("launchctl")
      .args(["unload", plist_path.to_string_lossy().as_ref()])
      .status();
    // The load must be checked, though — swallowing its failure made the
    // settings UI report success while login-launch silently never happened.
    let load = Command::new("launchctl")
      .args(["load", plist_path.to_string_lossy().as_ref()])
      .output()
      .context("failed to run launchctl load")?;
    if !load.status.success() {
      anyhow::bail!(
        "launchctl load failed ({}): {}",
        load.status,
        String::from_utf8_lossy(&load.stderr).trim()
      );
    }
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

pub fn supports_local_first() -> bool {
  // Local-first is the product policy on both slices of the universal app.
  // Engine-specific availability remains gated separately by each backend.
  true
}

fn insert_text_via_cgevent(text: &str) -> Result<()> {
  const K_CG_HID_EVENT_TAP: u32 = 0;
  const MAX_CHARS_PER_EVENT: usize = 20;
  let utf16: Vec<u16> = text.encode_utf16().collect();

  let mut chunks = utf16.chunks(MAX_CHARS_PER_EVENT).peekable();
  while let Some(chunk) = chunks.next() {
    let key_down = unsafe { CGEventCreateKeyboardEvent(std::ptr::null_mut(), 0, true) };
    if key_down.is_null() {
      return Err(anyhow!("failed to create keyboard event"));
    }
    unsafe {
      CGEventKeyboardSetUnicodeString(key_down, chunk.len(), chunk.as_ptr());
      CGEventPost(K_CG_HID_EVENT_TAP, key_down);
      CFRelease(key_down as *const c_void);
    }
    // Paces the target app so it consumes each event before the next lands —
    // without it some apps drop characters. Nothing follows the final chunk,
    // so pausing after it would tax every insertion 5ms for nothing.
    if chunks.peek().is_some() {
      std::thread::sleep(Duration::from_millis(5));
    }
  }

  Ok(())
}

/// How the system-wide `AXFocusedUIElement` query resolved.
#[derive(Debug, PartialEq)]
enum FocusQuery {
  /// The query succeeded and explicitly handed back no element — the system
  /// affirmatively says nothing is focused, so keys would land nowhere.
  NothingFocused,
  /// The query errored out. Chromium-shell apps whose web content is not
  /// bridged into the AX tree make this path routine — ChatGPT Atlas returns
  /// kAXErrorCannotComplete (-25204) or kAXErrorNoValue (-25212) even while
  /// an editable field is visibly focused (both observed live, 2026-07-02/03),
  /// and Claude Desktop behaves the same until its a11y tree wakes. An error —
  /// ANY error — is uncertainty, not a "nothing is focused" verdict, so the
  /// guard must not block on it.
  Unanswerable,
  /// A focused element came back and can be inspected.
  Element,
}

fn classify_focus_query(err: i32, has_element: bool) -> FocusQuery {
  match (err, has_element) {
    (0, true) => FocusQuery::Element,
    (0, false) => FocusQuery::NothingFocused,
    _ => FocusQuery::Unanswerable,
  }
}

// Best-effort guard: returns false ONLY when we're confident there is no
// editable text target for the keystrokes (no focused UI element, or a focused
// element that is neither value-settable nor a known text role — e.g. the
// desktop, a button, window chrome). On ANY uncertainty it returns true, so we
// never block a valid insertion in an app with imperfect Accessibility data —
// including apps whose AX tree is opaque and can't be queried at all.
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
    // Blocks and AX-opaque uncertainty stay warn-level so shipped builds keep
    // a trace of the decisions that can go wrong — the guard has misfired on
    // AX-opaque apps (ChatGPT Atlas) before. The routine allow path logs at
    // info (dev-visible only; the log file filters at Warn).
    match classify_focus_query(err, !focused.is_null()) {
      FocusQuery::NothingFocused => {
        log::warn!("insert-guard: focus query err={err} -> block (nothing focused)");
        return false;
      }
      FocusQuery::Unanswerable => {
        log::warn!("insert-guard: focus query err={err} -> allow (app doesn't answer AX)");
        return true;
      }
      FocusQuery::Element => {}
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
    let mut role_name: Option<String> = None;
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
      role_name = Some(role);
    }

    CFRelease(focused);
    let accepts = value_settable || text_role;
    let role = role_name.as_deref().unwrap_or("<unavailable>");
    if accepts {
      log::info!("insert-guard: focused role={role} settable={value_settable} -> allow");
    } else {
      log::warn!(
        "insert-guard: focused role={role} settable={value_settable} -> block (no editable target)"
      );
    }
    accepts
  }
}

#[repr(C)]
struct CGPoint {
  x: f64,
  y: f64,
}

#[repr(C)]
struct CGSize {
  width: f64,
  height: f64,
}

const K_AX_VALUE_CGPOINT: u32 = 1;
const K_AX_VALUE_CGSIZE: u32 = 2;

/// AX calls are synchronous round-trips to the target app's run loop, so a
/// wedged app would otherwise stall the caller for the 6s default — on the
/// hotkey thread that delay lands *before* the recording window appears. The
/// focused-window lookup can make four round-trips, so keep each one short and
/// fall back to the cursor screen rather than spending about a second here.
///
/// NOTE: setting this on the *system-wide* element sets it *process-globally*
/// (Apple's documented behavior), so it also caps the `focused_element_accepts_text`
/// insert guard below. That is deliberate and fails safe: a timeout there reads
/// as `Unanswerable`, which the guard already treats as "allow", so a slow app
/// can never cause a valid insertion to be blocked — it only stops a wedged app
/// from freezing the insert path for six seconds.
const AX_QUERY_TIMEOUT_SECONDS: f32 = 0.05;

/// Center of the frontmost app's focused window, in the global top-left-origin
/// **logical point** space — the same space `CGDisplayBounds` uses, so the
/// caller can hand it straight to `monitor_from_point` to ask which screen the
/// user is actually working on.
///
/// Returns `None` whenever Accessibility can't answer: permission not granted,
/// nothing focused, or an AX-opaque app. Chromium shells make that last case
/// routine (see `classify_focus_query` above — ChatGPT Atlas errors out even
/// with a field visibly focused), which is exactly why the caller keeps a mouse
/// pointer fallback instead of treating `None` as "no screen".
pub fn focused_window_center() -> Option<(f64, f64)> {
  unsafe {
    let system_wide = AXUIElementCreateSystemWide();
    if system_wide.is_null() {
      return None;
    }
    AXUIElementSetMessagingTimeout(system_wide, AX_QUERY_TIMEOUT_SECONDS);

    let app = copy_ax_attribute(system_wide, "AXFocusedApplication");
    CFRelease(system_wide);
    let app = app?;

    let focused = copy_ax_attribute(app, "AXFocusedWindow");
    CFRelease(app);
    let focused = focused?;

    let position = copy_ax_attribute(focused, "AXPosition");
    let size = copy_ax_attribute(focused, "AXSize");
    CFRelease(focused);

    let (position, size) = match (position, size) {
      (Some(position), Some(size)) => (position, size),
      (position, size) => {
        // One of the two came back — release it before bailing.
        if let Some(value) = position {
          CFRelease(value);
        }
        if let Some(value) = size {
          CFRelease(value);
        }
        return None;
      }
    };

    let mut origin = CGPoint { x: 0.0, y: 0.0 };
    let mut extent = CGSize {
      width: 0.0,
      height: 0.0,
    };
    let got_origin = AXValueGetValue(
      position,
      K_AX_VALUE_CGPOINT,
      &mut origin as *mut CGPoint as *mut c_void,
    );
    let got_extent = AXValueGetValue(
      size,
      K_AX_VALUE_CGSIZE,
      &mut extent as *mut CGSize as *mut c_void,
    );
    CFRelease(position);
    CFRelease(size);

    // A zero-sized window is a degenerate answer (some apps report one for
    // off-screen or freshly-created windows); its "center" would be a bogus
    // point, so treat it as unanswered.
    if !got_origin || !got_extent || extent.width <= 0.0 || extent.height <= 0.0 {
      return None;
    }
    Some((
      origin.x + extent.width / 2.0,
      origin.y + extent.height / 2.0,
    ))
  }
}

/// Reads one AX attribute, handing back the retained value on success. The
/// caller owns it and must `CFRelease` it (AX "Copy" follows the create rule).
unsafe fn copy_ax_attribute(element: *const c_void, attribute: &str) -> Option<*const c_void> {
  let name = CFString::new(attribute);
  let mut value: *const c_void = std::ptr::null();
  let err = AXUIElementCopyAttributeValue(
    element,
    name.as_concrete_TypeRef() as *const c_void,
    &mut value,
  );
  if err == 0 && !value.is_null() {
    Some(value)
  } else {
    None
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
  fn AXUIElementSetMessagingTimeout(element: *const c_void, timeoutInSeconds: f32) -> i32;
  fn AXValueGetValue(value: *const c_void, theType: u32, valuePtr: *mut c_void) -> bool;
}

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
  fn CFRelease(cf: *const c_void);
}

#[cfg(test)]
mod tests {
  use super::*;

  const AX_ERROR_CANNOT_COMPLETE: i32 = -25204;
  const AX_ERROR_API_DISABLED: i32 = -25211;
  const AX_ERROR_NO_VALUE: i32 = -25212;

  #[test]
  fn finder_reveal_prefers_the_app_bundle_over_the_binary() {
    use std::path::Path;
    assert_eq!(
      finder_reveal_target(Path::new("/Applications/SayType.app/Contents/MacOS/saytype")),
      Path::new("/Applications/SayType.app")
    );
    // Bare dev binary (no bundle ancestor) → reveal the executable itself.
    assert_eq!(
      finder_reveal_target(Path::new("/Users/tao/code/SayType/target/debug/saytype")),
      Path::new("/Users/tao/code/SayType/target/debug/saytype")
    );
  }

  #[test]
  fn app_bundle_is_some_only_inside_a_real_bundle() {
    use std::path::Path;
    // 安装态:exe = SayType.app/Contents/MacOS/saytype,上溯三级即 bundle。
    assert_eq!(
      app_bundle_of(Path::new("/Applications/SayType.app/Contents/MacOS/saytype")),
      Some(Path::new("/Applications/SayType.app"))
    );
    // dev 裸二进制:没有 .app 祖先 → None(云朵据此不显示)。
    assert_eq!(
      app_bundle_of(Path::new("/Users/tao/code/SayType/target/debug/saytype")),
      None
    );
    // 上溯三级存在但不是 .app,同样不算。
    assert_eq!(
      app_bundle_of(Path::new("/a/b/c/d/saytype")),
      None
    );
  }

  #[test]
  fn successful_query_yields_element_to_inspect() {
    assert_eq!(classify_focus_query(0, true), FocusQuery::Element);
  }

  #[test]
  fn each_ax_round_trip_stays_within_the_hotkey_startup_budget() {
    assert!(
      AX_QUERY_TIMEOUT_SECONDS <= 0.05,
      "each AX query may run four times before the prompt is shown"
    );
  }

  #[test]
  fn explicit_no_focus_blocks_insertion() {
    assert_eq!(classify_focus_query(0, false), FocusQuery::NothingFocused);
  }

  // Regression guard for the pbcopy MacRoman-mojibake bug (E6 88 91 -> "Êàë").
  // Self-contained and deterministic regardless of the test runner's own
  // locale: first prove a locale-stripped pbcopy (mimicking a GUI/LaunchAgent
  // launch, which is how the real app runs) DOES mangle multibyte UTF-8, then
  // prove copy_to_clipboard — which forces LC_ALL=en_US.UTF-8 internally —
  // survives that same environment. Reads back via pbpaste forced to UTF-8
  // output so the readback itself is locale-independent. Touches the global
  // pasteboard, so it's the only test here that does.
  fn pbpaste_utf8() -> String {
    let out = Command::new("pbpaste")
      .env("LC_ALL", "en_US.UTF-8")
      .output()
      .expect("pbpaste should run");
    String::from_utf8_lossy(&out.stdout).into_owned()
  }

  fn pbcopy_into(cmd: &mut Command, text: &str) {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = cmd.stdin(Stdio::piped()).spawn().expect("spawn pbcopy");
    child.stdin.as_mut().unwrap().write_all(text.as_bytes()).expect("write pbcopy");
    assert!(child.wait().expect("wait pbcopy").success());
  }

  #[test]
  fn clipboard_round_trips_utf8_chinese_not_macroman() {
    let sample = "我你好，测试 Claude！";

    // Baseline: strip the locale so pbcopy falls back to MacRoman, reproducing
    // the exact condition SayType runs under. This MUST corrupt the text —
    // if it doesn't, the guard below proves nothing on this machine.
    let mut stripped = Command::new("pbcopy");
    stripped
      .env_remove("LANG")
      .env_remove("LC_CTYPE")
      .env_remove("__CF_USER_TEXT_ENCODING")
      .env("LC_ALL", "C");
    pbcopy_into(&mut stripped, sample);
    assert_ne!(pbpaste_utf8(), sample, "expected the C locale to mangle UTF-8");

    // Fixed path: copy_to_clipboard forces LC_ALL=en_US.UTF-8, so it survives.
    copy_to_clipboard(sample).expect("pbcopy write should succeed");
    assert_eq!(pbpaste_utf8(), sample, "clipboard mangled multibyte UTF-8");
  }

  #[test]
  fn unanswerable_query_must_not_block_insertion() {
    // Chromium-shell apps with an unbridged AX tree fail this query while an
    // editable field IS focused. Both errors observed live in ChatGPT Atlas:
    // -25204 (2026-07-02 probe) and -25212 (2026-07-03 shipped-log evidence,
    // the case the first fix missed). Errors are uncertainty — never block.
    assert_eq!(
      classify_focus_query(AX_ERROR_CANNOT_COMPLETE, false),
      FocusQuery::Unanswerable
    );
    assert_eq!(
      classify_focus_query(AX_ERROR_NO_VALUE, false),
      FocusQuery::Unanswerable
    );
    assert_eq!(
      classify_focus_query(AX_ERROR_API_DISABLED, false),
      FocusQuery::Unanswerable
    );
  }
}
