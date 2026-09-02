use crate::settings::{DEFAULT_RECORD_SHORTCUT, TRANSLATE_SHORTCUT};
use rdev::Key;
use serde::Serialize;
#[cfg(target_os = "macos")]
use std::ffi::c_void;
use std::sync::mpsc::{self, Receiver, Sender};
#[cfg(target_os = "macos")]
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager};

// Recording starts the instant the modifier combo is down — there is no startup
// gate. A press shorter than this is treated as a mis-trigger and discarded
// (see handle_event Release / NonModifierPress). Anchored on the key-down time,
// so it's unaffected by the frontend's getUserMedia cold-start.
pub const CANCEL_THRESHOLD: Duration = Duration::from_millis(500);
// After the combo is released we still wait briefly before stopping, so a small
// stagger between the two modifier keys lifting doesn't clip the audio tail.
pub const STOP_DEBOUNCE: Duration = Duration::from_millis(250);
const SLOW_NATIVE_STARTUP: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingStartEvent {
  translate_mode: bool,
  dispatched_at_unix_ms: u64,
  native_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shortcut {
  pub ctrl: bool,
  pub shift: bool,
  pub alt: bool,
  pub meta: bool,
}

impl Shortcut {
  pub fn parse(value: &str) -> Option<Self> {
    let mut shortcut = Shortcut {
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
    };
    let mut count = 0;

    for token in value.split('+') {
      match token.trim().to_ascii_lowercase().as_str() {
        "ctrl" | "control" => {
          if !shortcut.ctrl {
            count += 1;
          }
          shortcut.ctrl = true;
        }
        "shift" => {
          if !shortcut.shift {
            count += 1;
          }
          shortcut.shift = true;
        }
        "alt" | "option" => {
          if !shortcut.alt {
            count += 1;
          }
          shortcut.alt = true;
        }
        "meta" | "command" | "cmd" | "super" | "win" | "windows" => {
          if !shortcut.meta {
            count += 1;
          }
          shortcut.meta = true;
        }
        "" => {}
        _ => return None,
      }
    }

    if count >= 2 {
      Some(shortcut)
    } else {
      None
    }
  }

}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ModifierState {
  pub ctrl: bool,
  pub shift: bool,
  pub alt: bool,
  pub meta: bool,
}

impl ModifierState {
  pub fn press(&mut self, key: Key) -> bool {
    match key {
      Key::ControlLeft | Key::ControlRight => {
        self.ctrl = true;
        true
      }
      Key::ShiftLeft | Key::ShiftRight => {
        self.shift = true;
        true
      }
      Key::Alt | Key::AltGr => {
        self.alt = true;
        true
      }
      Key::MetaLeft | Key::MetaRight => {
        self.meta = true;
        true
      }
      _ => false,
    }
  }

  pub fn release(&mut self, key: Key) -> bool {
    match key {
      Key::ControlLeft | Key::ControlRight => {
        self.ctrl = false;
        true
      }
      Key::ShiftLeft | Key::ShiftRight => {
        self.shift = false;
        true
      }
      Key::Alt | Key::AltGr => {
        self.alt = false;
        true
      }
      Key::MetaLeft | Key::MetaRight => {
        self.meta = false;
        true
      }
      _ => false,
    }
  }

  pub fn matches(&self, shortcut: &Shortcut) -> bool {
    self.ctrl == shortcut.ctrl
      && self.shift == shortcut.shift
      && self.alt == shortcut.alt
      && self.meta == shortcut.meta
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
  Start { translate_mode: bool },
  Stop,
  Cancel,
}

#[derive(Debug, Clone, Copy)]
pub enum KeyEvent {
  Press(Key),
  Release(Key),
  NonModifierPress,
}

#[derive(Debug)]
pub enum HotkeyMsg {
  KeyEvent(KeyEvent),
  UpdateShortcut(String),
}

#[derive(Clone)]
pub struct HotkeyHandle {
  tx: Sender<HotkeyMsg>,
}

impl HotkeyHandle {
  pub fn update_shortcut(&self, shortcut: String) {
    let _ = self.tx.send(HotkeyMsg::UpdateShortcut(shortcut));
  }
}

#[derive(Debug)]
pub struct HotkeyState {
  modifiers: ModifierState,
  record_shortcut: Shortcut,
  translate_shortcut: Shortcut,
  is_recording: bool,
  record_started_at: Option<Instant>,
  stop_deadline: Option<Instant>,
  pending: Vec<Action>,
}

impl HotkeyState {
  pub fn new(record_shortcut: Shortcut, translate_shortcut: Shortcut) -> Self {
    Self {
      modifiers: ModifierState::default(),
      record_shortcut,
      translate_shortcut,
      is_recording: false,
      record_started_at: None,
      stop_deadline: None,
      pending: Vec::new(),
    }
  }

  fn active_mode(&self) -> Option<bool> {
    if self.modifiers.matches(&self.record_shortcut) {
      Some(false)
    } else if self.modifiers.matches(&self.translate_shortcut) {
      Some(true)
    } else {
      None
    }
  }

  pub fn handle_event(&mut self, event: KeyEvent, now: Instant) {
    match event {
      KeyEvent::NonModifierPress => {
        // A non-modifier pressed right after the combo (e.g. Ctrl+Shift+Arrow)
        // means the user wanted a shortcut, not to record — discard the
        // just-started recording. Only during probation, so an accidental
        // keypress deep into a real recording doesn't nuke it.
        if self.is_recording && self.in_probation(now) {
          self.cancel_recording();
        }
      }
      KeyEvent::Press(key) => {
        if key == Key::Escape {
          if self.is_recording {
            self.cancel_recording();
          }
          self.stop_deadline = None;
          return;
        }

        let is_modifier = self.modifiers.press(key);
        if !is_modifier {
          // Non-modifier (rdev path) — same combo-key discard as above.
          if self.is_recording && self.in_probation(now) {
            self.cancel_recording();
          }
          return;
        }

        if self.is_recording && self.active_mode().is_some() {
          // Combo re-formed (e.g. a modifier re-pressed) — keep recording.
          self.stop_deadline = None;
          return;
        }

        // Combo just completed: start recording immediately — no startup gate.
        // Mis-triggers are handled after the fact (short release / combo key).
        if !self.is_recording && self.active_mode().is_some() {
          if let Some(translate_mode) = self.active_mode() {
            self.is_recording = true;
            self.record_started_at = Some(now);
            self.stop_deadline = None;
            self.pending.push(Action::Start { translate_mode });
          }
        }
      }
      KeyEvent::Release(key) => {
        let is_modifier = self.modifiers.release(key);
        if !is_modifier {
          return;
        }

        if self.active_mode().is_some() {
          // Still a valid combo (an unrelated modifier lifted) — keep recording.
          self.stop_deadline = None;
        } else if self.is_recording && self.stop_deadline.is_none() {
          // Combo broken. Too short → mis-trigger, discard. Otherwise stop after
          // STOP_DEBOUNCE so a stagger between the keys lifting doesn't clip the
          // tail. Held time is measured from key-down, independent of the
          // frontend's mic cold-start.
          let held = self
            .record_started_at
            .map(|started| now.saturating_duration_since(started))
            .unwrap_or_default();
          if held < CANCEL_THRESHOLD {
            self.cancel_recording();
          } else {
            self.stop_deadline = Some(now + STOP_DEBOUNCE);
          }
        }
      }
    }
  }

  fn in_probation(&self, now: Instant) -> bool {
    self
      .record_started_at
      .map(|started| now.saturating_duration_since(started) < CANCEL_THRESHOLD)
      .unwrap_or(false)
  }

  fn cancel_recording(&mut self) {
    self.is_recording = false;
    self.record_started_at = None;
    self.stop_deadline = None;
    self.pending.push(Action::Cancel);
  }

  pub fn handle_tick(&mut self, now: Instant) {
    if let Some(deadline) = self.stop_deadline {
      if now >= deadline {
        self.stop_deadline = None;
        if self.is_recording && self.active_mode().is_none() {
          self.is_recording = false;
          self.record_started_at = None;
          self.pending.push(Action::Stop);
        }
      }
    }
  }

  pub fn next_deadline(&self) -> Option<Instant> {
    self.stop_deadline
  }

  pub fn drain_actions(&mut self) -> Vec<Action> {
    std::mem::take(&mut self.pending)
  }
}

pub fn start_listener(app: &AppHandle, initial_shortcut: String) -> HotkeyHandle {
  let (tx, rx) = mpsc::channel::<HotkeyMsg>();
  let handle = HotkeyHandle { tx: tx.clone() };
  spawn_os_listener(handle.clone());

  let app_handle = app.clone();
  thread::Builder::new()
    .name("hotkey-state".into())
    .spawn(move || run_state_thread(app_handle, rx, initial_shortcut))
    .expect("failed to spawn hotkey state thread");

  handle
}

pub fn restart_os_listener(handle: HotkeyHandle) {
  spawn_os_listener(handle);
}

#[cfg(target_os = "macos")]
fn spawn_os_listener(handle: HotkeyHandle) {
  if !crate::platform::accessibility_granted(false) {
    log::info!("skipping macOS hotkey listener startup until Accessibility permission is granted");
    return;
  }

  thread::Builder::new()
    .name("hotkey-eventtap".into())
    .spawn(move || {
      if let Err(error) = run_macos_event_tap(handle.tx.clone()) {
        log::error!("global hotkey listener exited: {error}");
      }
    })
    .expect("failed to spawn hotkey listener thread");
}

#[cfg(not(target_os = "macos"))]
fn spawn_os_listener(handle: HotkeyHandle) {
  thread::Builder::new()
    .name("hotkey-rdev".into())
    .spawn(move || {
      if let Err(error) = rdev::listen(move |event| {
        let key_event = match event.event_type {
          rdev::EventType::KeyPress(key) => Some(KeyEvent::Press(key)),
          rdev::EventType::KeyRelease(key) => Some(KeyEvent::Release(key)),
          _ => None,
        };

        if let Some(key_event) = key_event {
          let _ = handle.tx.send(HotkeyMsg::KeyEvent(key_event));
        }
      }) {
        log::error!("global hotkey listener exited: {error:?}");
      }
    })
    .expect("failed to spawn hotkey listener thread");
}

#[cfg(target_os = "macos")]
struct MacEventTapContext {
  tx: Sender<HotkeyMsg>,
  modifiers: Mutex<ModifierState>,
}

#[cfg(target_os = "macos")]
fn run_macos_event_tap(tx: Sender<HotkeyMsg>) -> Result<(), String> {
  let context = Box::into_raw(Box::new(MacEventTapContext {
    tx,
    modifiers: Mutex::new(ModifierState::default()),
  }));

  let event_mask = (1_u64 << KCG_EVENT_KEY_DOWN) | (1_u64 << KCG_EVENT_FLAGS_CHANGED);
  let tap = unsafe {
    CGEventTapCreate(
      KCG_SESSION_EVENT_TAP,
      KCG_HEAD_INSERT_EVENT_TAP,
      KCG_EVENT_TAP_OPTION_LISTEN_ONLY,
      event_mask,
      macos_event_tap_callback,
      context.cast(),
    )
  };

  if tap.is_null() {
    unsafe {
      let _ = Box::from_raw(context);
    }
    return Err("failed to create macOS event tap; verify Accessibility permission".into());
  }

  let source = unsafe { CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0) };
  if source.is_null() {
    unsafe {
      let _ = Box::from_raw(context);
    }
    return Err("failed to create macOS run loop source for hotkeys".into());
  }

  unsafe {
    let run_loop = CFRunLoopGetCurrent();
    CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
    CFRunLoopRun();
  }

  Ok(())
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn macos_event_tap_callback(
  _proxy: CGEventTapProxy,
  event_type: CGEventType,
  event: CGEventRef,
  user_info: *mut c_void,
) -> CGEventRef {
  if user_info.is_null() {
    return event;
  }

  let context = &*(user_info as *const MacEventTapContext);

  match event_type {
    KCG_EVENT_FLAGS_CHANGED => {
      let next = modifier_state_from_flags(CGEventGetFlags(event));
      if let Ok(mut current) = context.modifiers.lock() {
        emit_modifier_transition(&context.tx, current.ctrl, next.ctrl, Key::ControlLeft);
        emit_modifier_transition(&context.tx, current.shift, next.shift, Key::ShiftLeft);
        emit_modifier_transition(&context.tx, current.alt, next.alt, Key::Alt);
        emit_modifier_transition(&context.tx, current.meta, next.meta, Key::MetaLeft);
        *current = next;
      }
    }
    KCG_EVENT_KEY_DOWN => {
      let key_code = CGEventGetIntegerValueField(event, KCG_KEYBOARD_EVENT_KEYCODE);
      let key_event = if key_code == KVK_ESCAPE {
        KeyEvent::Press(Key::Escape)
      } else {
        KeyEvent::NonModifierPress
      };
      let _ = context.tx.send(HotkeyMsg::KeyEvent(key_event));
    }
    _ => {}
  }

  event
}

#[cfg(target_os = "macos")]
fn emit_modifier_transition(tx: &Sender<HotkeyMsg>, previous: bool, next: bool, key: Key) {
  let key_event = match (previous, next) {
    (false, true) => Some(KeyEvent::Press(key)),
    (true, false) => Some(KeyEvent::Release(key)),
    _ => None,
  };

  if let Some(key_event) = key_event {
    let _ = tx.send(HotkeyMsg::KeyEvent(key_event));
  }
}

#[cfg(target_os = "macos")]
fn modifier_state_from_flags(flags: u64) -> ModifierState {
  ModifierState {
    ctrl: flags & KCG_EVENT_FLAG_MASK_CONTROL != 0,
    shift: flags & KCG_EVENT_FLAG_MASK_SHIFT != 0,
    alt: flags & KCG_EVENT_FLAG_MASK_ALTERNATE != 0,
    meta: flags & KCG_EVENT_FLAG_MASK_COMMAND != 0,
  }
}

#[cfg(target_os = "macos")]
type CGEventTapProxy = *mut c_void;
#[cfg(target_os = "macos")]
type CGEventType = u32;
#[cfg(target_os = "macos")]
type CGEventRef = *mut c_void;
#[cfg(target_os = "macos")]
type CFMachPortRef = *mut c_void;
#[cfg(target_os = "macos")]
type CFRunLoopRef = *mut c_void;
#[cfg(target_os = "macos")]
type CFRunLoopSourceRef = *mut c_void;

#[cfg(target_os = "macos")]
const KCG_SESSION_EVENT_TAP: u32 = 1;
#[cfg(target_os = "macos")]
const KCG_HEAD_INSERT_EVENT_TAP: u32 = 0;
#[cfg(target_os = "macos")]
const KCG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;
#[cfg(target_os = "macos")]
const KCG_EVENT_KEY_DOWN: u32 = 10;
#[cfg(target_os = "macos")]
const KCG_EVENT_FLAGS_CHANGED: u32 = 12;
#[cfg(target_os = "macos")]
const KCG_KEYBOARD_EVENT_KEYCODE: i32 = 9;
#[cfg(target_os = "macos")]
const KCG_EVENT_FLAG_MASK_SHIFT: u64 = 1 << 17;
#[cfg(target_os = "macos")]
const KCG_EVENT_FLAG_MASK_CONTROL: u64 = 1 << 18;
#[cfg(target_os = "macos")]
const KCG_EVENT_FLAG_MASK_ALTERNATE: u64 = 1 << 19;
#[cfg(target_os = "macos")]
const KCG_EVENT_FLAG_MASK_COMMAND: u64 = 1 << 20;
#[cfg(target_os = "macos")]
const KVK_ESCAPE: i64 = 53;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
  static kCFRunLoopDefaultMode: *const c_void;

  fn CGEventTapCreate(
    tap: u32,
    place: u32,
    options: u32,
    events_of_interest: u64,
    callback: unsafe extern "C" fn(
      proxy: CGEventTapProxy,
      event_type: CGEventType,
      event: CGEventRef,
      user_info: *mut c_void,
    ) -> CGEventRef,
    user_info: *mut c_void,
  ) -> CFMachPortRef;
  fn CFMachPortCreateRunLoopSource(
    allocator: *const c_void,
    port: CFMachPortRef,
    order: isize,
  ) -> CFRunLoopSourceRef;
  fn CFRunLoopGetCurrent() -> CFRunLoopRef;
  fn CFRunLoopAddSource(run_loop: CFRunLoopRef, source: CFRunLoopSourceRef, mode: *const c_void);
  fn CFRunLoopRun();
  fn CGEventGetFlags(event: CGEventRef) -> u64;
  fn CGEventGetIntegerValueField(event: CGEventRef, field: i32) -> i64;
}

fn run_state_thread(app: AppHandle, rx: Receiver<HotkeyMsg>, initial_shortcut: String) {
  let record_shortcut = Shortcut::parse(&initial_shortcut)
    .or_else(|| Shortcut::parse(DEFAULT_RECORD_SHORTCUT))
    .expect("default record shortcut must parse");
  let translate_shortcut = Shortcut::parse(TRANSLATE_SHORTCUT).expect("translate shortcut must parse");
  let mut state = HotkeyState::new(record_shortcut, translate_shortcut);

  loop {
    let timeout = state
      .next_deadline()
      .map(|deadline| deadline.saturating_duration_since(Instant::now()));
    let message = match timeout {
      Some(duration) => rx.recv_timeout(duration),
      None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
    };
    let now = Instant::now();

    match message {
      Ok(HotkeyMsg::KeyEvent(KeyEvent::Press(Key::Escape))) if !state.is_recording && is_input_prompt_visible(&app) => {
        dispatch_action(&app, Action::Cancel);
      }
      Ok(HotkeyMsg::KeyEvent(event)) => state.handle_event(event, now),
      Ok(HotkeyMsg::UpdateShortcut(shortcut)) => {
        if let Some(parsed) = Shortcut::parse(&shortcut) {
          state.record_shortcut = parsed;
        }
      }
      Err(mpsc::RecvTimeoutError::Timeout) => {}
      Err(mpsc::RecvTimeoutError::Disconnected) => return,
    }

    state.handle_tick(now);
    for action in state.drain_actions() {
      dispatch_action(&app, action);
    }
  }
}

fn is_input_prompt_visible(app: &AppHandle) -> bool {
  app
    .get_webview_window("input-prompt")
    .and_then(|window| window.is_visible().ok())
    .unwrap_or(false)
}

fn dispatch_action(app: &AppHandle, action: Action) {
  match action {
    Action::Start { translate_mode } => {
      let startup_started = Instant::now();
      log::info!("hotkey:dispatch start translate_mode={translate_mode}");
      // No worker step here, and so no worker_ms below: Qwen worker ownership
      // begins in the frontend once this recording has a session id, and native
      // hotkey dispatch must not extend a previous session.
      let position_started = Instant::now();
      let mut show_elapsed = Duration::ZERO;
      if let Some(window) = app.get_webview_window("input-prompt") {
        if let Some(target) = position_input_prompt(&window) {
          wait_for_position(&window, target);
        }
        let show_started = Instant::now();
        let _ = window.show();
        show_elapsed = show_started.elapsed();
      }
      let position_elapsed = position_started.elapsed().saturating_sub(show_elapsed);
      let native_elapsed = startup_started.elapsed();
      let payload = RecordingStartEvent {
        translate_mode,
        dispatched_at_unix_ms: SystemTime::now()
          .duration_since(UNIX_EPOCH)
          .unwrap_or_default()
          .as_millis()
          .try_into()
          .unwrap_or(u64::MAX),
        native_ms: native_elapsed.as_millis().try_into().unwrap_or(u64::MAX),
      };
      let emit_started = Instant::now();
      let _ = app.emit("start-recording", payload);
      let emit_elapsed = emit_started.elapsed();
      let total_elapsed = startup_started.elapsed();
      if total_elapsed >= SLOW_NATIVE_STARTUP {
        log::warn!(
          "hotkey:startup-slow position_ms={} show_ms={} emit_ms={} total_ms={}",
          position_elapsed.as_millis(),
          show_elapsed.as_millis(),
          emit_elapsed.as_millis(),
          total_elapsed.as_millis()
        );
      } else {
        log::info!(
          "hotkey:startup-ready position_ms={} show_ms={} emit_ms={} total_ms={}",
          position_elapsed.as_millis(),
          show_elapsed.as_millis(),
          emit_elapsed.as_millis(),
          total_elapsed.as_millis()
        );
      }
    }
    Action::Stop => {
      log::info!("hotkey:dispatch stop");
      let _ = app.emit("stop-recording", ());
    }
    Action::Cancel => {
      log::info!("hotkey:dispatch cancel");
      let _ = app.emit("cancel-recording", ());
    }
  }
}

/// Gap between the prompt's bottom edge and the bottom of the screen, in
/// logical points — so it looks the same distance up on a 1x external display
/// and a 2x Retina one. (It used to be 100 *physical* pixels, which rendered as
/// half the gap on Retina.)
const PROMPT_BOTTOM_MARGIN: f64 = 100.0;

/// Fallback prompt size, used only if the window can't report its own — matches
/// the `input-prompt` dimensions in `tauri.conf.json`.
const PROMPT_FALLBACK_SIZE: (f64, f64) = (460.0, 244.0);

/// Upper bound on how long `wait_for_position` will hold the prompt back. Well
/// past the measured 0.4–4.9ms so it never trips in practice, but small enough
/// that a wedged move can't visibly delay the recording UI.
const POSITION_SETTLE_TIMEOUT: Duration = Duration::from_millis(60);

/// Puts the prompt bottom-center on the screen the user is actually working on.
///
/// ## Everything here is in logical points, deliberately
///
/// tao's macOS coordinate spaces disagree with each other, and mixing them
/// silently picks the wrong screen on any Retina + external-display setup:
///
/// * `monitor_from_point(x, y)` compares against `CGDisplayBounds` — **logical
///   points**, top-left origin.
/// * `Monitor::position()` / `size()` return **physical pixels** (logical x that
///   monitor's scale factor).
/// * `cursor_position()` returns logical points pre-multiplied by the
///   **primary** monitor's scale factor, whichever screen the pointer is on.
/// * `set_position` with a `PhysicalPosition` re-divides by the *window's*
///   current scale factor — which is still the old screen's while we're moving
///   it. A `LogicalPosition` passes through untouched, so we use that.
///
/// So: normalize every input to logical points, and set a logical position.
fn position_input_prompt(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
  let monitor = target_monitor(window)?;
  let screen = logical_rect(
    (monitor.position().x, monitor.position().y),
    (monitor.size().width, monitor.size().height),
    monitor.scale_factor(),
  )?;

  // The window's own size is physical at *its* current scale factor, which is
  // not necessarily the target monitor's.
  let window_scale = window.scale_factor().unwrap_or(monitor.scale_factor());
  let prompt = window
    .outer_size()
    .ok()
    .filter(|_| window_scale > 0.0)
    .map(|size| {
      (
        size.width as f64 / window_scale,
        size.height as f64 / window_scale,
      )
    })
    .unwrap_or(PROMPT_FALLBACK_SIZE);

  let (x, y) = prompt_origin(screen, prompt);
  let _ = window.set_position(LogicalPosition::new(x, y));
  Some((x, y))
}

/// Blocks until the window has actually moved to `target`, so `show()` can't
/// flash it on the screen it is leaving.
///
/// macOS applies the move asynchronously — tao's `set_outer_position` ends in
/// `set_frame_top_left_point_async`, a `dispatch_async` onto the main queue —
/// so an immediate `show()` races it. Measured on a 3-screen desk: without this
/// the prompt appeared at the *previous* screen's coordinates and jumped, on
/// roughly 2 of 9 screen changes. Waiting is nearly free because the move
/// usually lands first: 0.4–4.9ms, 0–1 polls, and 0 polls whenever the prompt
/// is already on the right screen (the common case).
fn wait_for_position(window: &tauri::WebviewWindow, target: (f64, f64)) {
  let deadline = Instant::now() + POSITION_SETTLE_TIMEOUT;
  loop {
    // Treat "can't read the position" as settled — never hold the prompt back
    // over a failed query.
    let landed = window
      .outer_position()
      .ok()
      .zip(window.scale_factor().ok())
      .map(|(position, scale)| {
        (position.x as f64 / scale - target.0).abs() < 1.0
          && (position.y as f64 / scale - target.1).abs() < 1.0
      })
      .unwrap_or(true);
    if landed || Instant::now() >= deadline {
      return;
    }
    thread::sleep(Duration::from_millis(2));
  }
}

/// A rectangle in logical points, top-left origin — the space `CGDisplayBounds`
/// and `monitor_from_point` share.
#[derive(Debug, Clone, Copy, PartialEq)]
struct LogicalRect {
  x: f64,
  y: f64,
  width: f64,
  height: f64,
}

/// `Monitor` reports physical pixels; divide through by its scale factor to get
/// back to logical points. On a 2x display that turns e.g. position (6880, 0) /
/// size 5120x2880 back into (3440, 0) / 2560x1440.
fn logical_rect(position: (i32, i32), size: (u32, u32), scale: f64) -> Option<LogicalRect> {
  if scale <= 0.0 {
    return None;
  }
  Some(LogicalRect {
    x: position.0 as f64 / scale,
    y: position.1 as f64 / scale,
    width: size.0 as f64 / scale,
    height: size.1 as f64 / scale,
  })
}

/// Bottom-center origin for a `prompt`-sized window on `screen`, all logical.
fn prompt_origin(screen: LogicalRect, prompt: (f64, f64)) -> (f64, f64) {
  (
    screen.x + (screen.width - prompt.0) / 2.0,
    screen.y + screen.height - prompt.1 - PROMPT_BOTTOM_MARGIN,
  )
}

/// Which screen the prompt belongs on, best answer first:
///
/// 1. the focused app's window — where the transcription is about to be
///    inserted, so it's the screen the user is looking at;
/// 2. the mouse pointer — a good proxy, and it always answers;
/// 3. the primary monitor — the old unconditional behavior, now only a last
///    resort.
fn target_monitor(window: &tauri::WebviewWindow) -> Option<tauri::Monitor> {
  if let Some((x, y)) = crate::platform::focused_window_center() {
    if let Ok(Some(monitor)) = window.monitor_from_point(x, y) {
      log::info!("input-prompt: screen from focused window at ({x:.0}, {y:.0})");
      return Some(monitor);
    }
  }

  if let Some((x, y)) = cursor_point_logical(window) {
    if let Ok(Some(monitor)) = window.monitor_from_point(x, y) {
      log::info!("input-prompt: screen from cursor at ({x:.0}, {y:.0})");
      return Some(monitor);
    }
  }

  log::warn!("input-prompt: no focused window or cursor screen — using the primary monitor");
  window.primary_monitor().ok().flatten()
}

/// `cursor_position()` hands back logical points already multiplied by the
/// *primary* monitor's scale factor, so undo that to get the plain logical
/// point `monitor_from_point` expects.
fn cursor_point_logical(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
  let cursor = window.cursor_position().ok()?;
  let primary_scale = window
    .primary_monitor()
    .ok()
    .flatten()
    .map(|monitor| monitor.scale_factor())
    .filter(|scale| *scale > 0.0)
    .unwrap_or(1.0);
  Some((cursor.x / primary_scale, cursor.y / primary_scale))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn fresh_state() -> HotkeyState {
    HotkeyState::new(
      Shortcut::parse(DEFAULT_RECORD_SHORTCUT).unwrap(),
      Shortcut::parse(TRANSLATE_SHORTCUT).unwrap(),
    )
  }

  #[test]
  fn recording_start_event_uses_camel_case_wire_fields() {
    let event = RecordingStartEvent {
      translate_mode: true,
      dispatched_at_unix_ms: 1_000,
      native_ms: 80,
    };
    let wire = serde_json::to_value(event).unwrap();

    assert_eq!(wire["translateMode"], true);
    assert_eq!(wire["dispatchedAtUnixMs"], 1_000);
    assert_eq!(wire["nativeMs"], 80);
  }

  // The three displays below are a real, measured setup (mixed 1x/2x), captured
  // from CGDisplayBounds + NSScreen.backingScaleFactor:
  //
  //   DELL S3423DWC  bounds (0, 0) 3440x1440     scale 1  [main]
  //   DELL P2418D    bounds (3440, 0) 2560x1440  scale 2
  //   LS27R75        bounds (-2560, 0) 2560x1440 scale 2
  //
  // `Monitor` hands those back as *physical* pixels, which is what the inputs
  // here are. Getting the scale division wrong is silent and catastrophic: the
  // 2x screens would place the prompt at x≈9210 / x≈-4350, i.e. nowhere.
  // Mirrors PROMPT_FALLBACK_SIZE / the input-prompt window in tauri.conf.json;
  // only the height feeds the y assertions below (x is width-driven).
  const PROMPT_SIZE: (f64, f64) = (460.0, 244.0);

  #[test]
  fn one_x_screen_is_unchanged_by_the_scale_division() {
    let screen = logical_rect((0, 0), (3440, 1440), 1.0).unwrap();
    assert_eq!(
      screen,
      LogicalRect {
        x: 0.0,
        y: 0.0,
        width: 3440.0,
        height: 1440.0
      }
    );
    assert_eq!(prompt_origin(screen, PROMPT_SIZE), (1490.0, 1096.0));
  }

  #[test]
  fn two_x_screen_right_of_main_normalizes_to_logical_points() {
    // Physical position is the logical 3440 pre-multiplied by the scale factor.
    let screen = logical_rect((6880, 0), (5120, 2880), 2.0).unwrap();
    assert_eq!(
      screen,
      LogicalRect {
        x: 3440.0,
        y: 0.0,
        width: 2560.0,
        height: 1440.0
      }
    );
    assert_eq!(prompt_origin(screen, PROMPT_SIZE), (4490.0, 1096.0));
  }

  #[test]
  fn two_x_screen_left_of_main_keeps_its_negative_origin() {
    let screen = logical_rect((-5120, 0), (5120, 2880), 2.0).unwrap();
    assert_eq!(
      screen,
      LogicalRect {
        x: -2560.0,
        y: 0.0,
        width: 2560.0,
        height: 1440.0
      }
    );
    assert_eq!(prompt_origin(screen, PROMPT_SIZE), (-1510.0, 1096.0));
  }

  #[test]
  fn the_bottom_margin_is_the_same_logical_gap_on_every_screen() {
    // Same visual gap regardless of DPI — the old code used physical pixels, so
    // the 2x screens got half the gap.
    for (position, size, scale) in [
      ((0, 0), (3440u32, 1440u32), 1.0),
      ((6880, 0), (5120, 2880), 2.0),
    ] {
      let screen = logical_rect(position, size, scale).unwrap();
      let (_, y) = prompt_origin(screen, PROMPT_SIZE);
      let gap = screen.y + screen.height - (y + PROMPT_SIZE.1);
      assert_eq!(gap, PROMPT_BOTTOM_MARGIN);
    }
  }

  #[test]
  fn a_bogus_scale_factor_is_rejected_rather_than_dividing_by_zero() {
    assert!(logical_rect((0, 0), (3440, 1440), 0.0).is_none());
    assert!(logical_rect((0, 0), (3440, 1440), -1.0).is_none());
  }

  #[test]
  fn parse_shortcut_labels() {
    let shortcut = Shortcut::parse(" ctrl + shift ").unwrap();
    assert!(shortcut.ctrl);
    assert!(shortcut.shift);
    assert!(!shortcut.alt);
    assert!(!shortcut.meta);
    assert!(Shortcut::parse("Ctrl").is_none());
  }

  #[test]
  fn modifier_state_matches_exact_shortcut() {
    let shortcut = Shortcut::parse("Ctrl+Shift").unwrap();
    let mut modifiers = ModifierState::default();
    modifiers.press(Key::ControlLeft);
    modifiers.press(Key::ShiftLeft);
    assert!(modifiers.matches(&shortcut));
    modifiers.press(Key::Alt);
    assert!(!modifiers.matches(&shortcut));
  }

  #[test]
  fn start_emits_immediately_on_combo() {
    let mut state = fresh_state();
    let start = Instant::now();
    state.handle_event(KeyEvent::Press(Key::ControlLeft), start);
    state.handle_event(KeyEvent::Press(Key::ShiftLeft), start);
    // No debounce/tick: recording starts the instant the combo is down.
    assert_eq!(state.drain_actions(), vec![Action::Start { translate_mode: false }]);
  }

  #[test]
  fn long_press_release_emits_stop() {
    let mut state = fresh_state();
    let start = Instant::now();
    state.handle_event(KeyEvent::Press(Key::ControlLeft), start);
    state.handle_event(KeyEvent::Press(Key::ShiftLeft), start);
    let _ = state.drain_actions();
    let release_at = start + CANCEL_THRESHOLD + Duration::from_millis(100);
    state.handle_event(KeyEvent::Release(Key::ShiftLeft), release_at);
    state.handle_tick(release_at + STOP_DEBOUNCE + Duration::from_millis(1));
    assert_eq!(state.drain_actions(), vec![Action::Stop]);
  }

  #[test]
  fn short_press_release_cancels() {
    let mut state = fresh_state();
    let start = Instant::now();
    state.handle_event(KeyEvent::Press(Key::ControlLeft), start);
    state.handle_event(KeyEvent::Press(Key::ShiftLeft), start);
    let _ = state.drain_actions();
    // Released well under the threshold → discarded, never transcribed.
    state.handle_event(KeyEvent::Release(Key::ShiftLeft), start + Duration::from_millis(100));
    assert_eq!(state.drain_actions(), vec![Action::Cancel]);
  }

  #[test]
  fn combo_key_during_probation_cancels() {
    let mut state = fresh_state();
    let start = Instant::now();
    state.handle_event(KeyEvent::Press(Key::ControlLeft), start);
    state.handle_event(KeyEvent::Press(Key::ShiftLeft), start);
    let _ = state.drain_actions();
    // Ctrl+Shift+<key> → user meant a shortcut; discard the recording.
    state.handle_event(KeyEvent::NonModifierPress, start + Duration::from_millis(20));
    assert_eq!(state.drain_actions(), vec![Action::Cancel]);
  }

  #[test]
  fn escape_cancels_recording() {
    let mut state = fresh_state();
    let start = Instant::now();
    state.handle_event(KeyEvent::Press(Key::ControlLeft), start);
    state.handle_event(KeyEvent::Press(Key::ShiftLeft), start);
    let _ = state.drain_actions();
    state.handle_event(KeyEvent::Press(Key::Escape), start + Duration::from_millis(400));
    assert_eq!(state.drain_actions(), vec![Action::Cancel]);
  }
}
