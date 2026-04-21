use crate::settings::{DEFAULT_RECORD_SHORTCUT, TRANSLATE_SHORTCUT};
use rdev::Key;
#[cfg(target_os = "macos")]
use std::ffi::c_void;
use std::sync::mpsc::{self, Receiver, Sender};
#[cfg(target_os = "macos")]
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

pub const START_DEBOUNCE: Duration = Duration::from_millis(120);
pub const STOP_DEBOUNCE: Duration = Duration::from_millis(250);

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
  start_deadline: Option<Instant>,
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
      start_deadline: None,
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
        self.start_deadline = None;
        if self.is_recording && self.active_mode().is_some() {
          self.stop_deadline = None;
        }
      }
      KeyEvent::Press(key) => {
        if key == Key::Escape {
          if self.is_recording {
            self.is_recording = false;
            self.pending.push(Action::Cancel);
          }
          self.start_deadline = None;
          self.stop_deadline = None;
          return;
        }

        let is_modifier = self.modifiers.press(key);
        if !is_modifier {
          self.start_deadline = None;
          if self.is_recording && self.active_mode().is_some() {
            self.stop_deadline = None;
          }
          return;
        }

        if self.is_recording && self.active_mode().is_some() {
          self.stop_deadline = None;
        }

        if !self.is_recording && self.active_mode().is_some() && self.start_deadline.is_none() {
          self.start_deadline = Some(now + START_DEBOUNCE);
        }
      }
      KeyEvent::Release(key) => {
        let is_modifier = self.modifiers.release(key);
        if !is_modifier {
          return;
        }

        if self.active_mode().is_some() {
          self.stop_deadline = None;
        } else {
          if self.is_recording && self.stop_deadline.is_none() {
            self.stop_deadline = Some(now + STOP_DEBOUNCE);
          }
          self.start_deadline = None;
        }
      }
    }
  }

  pub fn handle_tick(&mut self, now: Instant) {
    if let Some(deadline) = self.start_deadline {
      if now >= deadline {
        self.start_deadline = None;
        if !self.is_recording {
          if let Some(translate_mode) = self.active_mode() {
            self.is_recording = true;
            self.pending.push(Action::Start { translate_mode });
          }
        }
      }
    }

    if let Some(deadline) = self.stop_deadline {
      if now >= deadline {
        self.stop_deadline = None;
        if self.is_recording && self.active_mode().is_none() {
          self.is_recording = false;
          self.pending.push(Action::Stop);
        }
      }
    }
  }

  pub fn next_deadline(&self) -> Option<Instant> {
    match (self.start_deadline, self.stop_deadline) {
      (Some(a), Some(b)) => Some(a.min(b)),
      (Some(a), None) => Some(a),
      (None, Some(b)) => Some(b),
      (None, None) => None,
    }
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
  if !macos_hotkey_permission_granted() {
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
fn macos_hotkey_permission_granted() -> bool {
  unsafe { AXIsProcessTrusted() }
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
  fn AXIsProcessTrusted() -> bool;
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
      log::info!("hotkey:dispatch start translate_mode={translate_mode}");
      if let Some(window) = app.get_webview_window("input-prompt") {
        position_input_prompt(&window);
        let _ = window.show();
      }
      let _ = app.emit("start-recording", translate_mode);
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

fn position_input_prompt(window: &tauri::WebviewWindow) {
  let monitor = match window.primary_monitor() {
    Ok(Some(monitor)) => monitor,
    _ => return,
  };

  let monitor_position = monitor.position();
  let monitor_size = monitor.size();
  let window_size = window.outer_size().ok();
  let width = window_size.map(|size| size.width as i32).unwrap_or(400);
  let height = window_size.map(|size| size.height as i32).unwrap_or(100);
  let x = monitor_position.x + ((monitor_size.width as i32 - width) / 2);
  let y = monitor_position.y + monitor_size.height as i32 - height - 100;
  let _ = window.set_position(PhysicalPosition::new(x, y));
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
  fn start_emits_after_debounce() {
    let mut state = fresh_state();
    let start = Instant::now();
    state.handle_event(KeyEvent::Press(Key::ControlLeft), start);
    state.handle_event(KeyEvent::Press(Key::ShiftLeft), start);
    state.handle_tick(start + START_DEBOUNCE + Duration::from_millis(1));
    assert_eq!(state.drain_actions(), vec![Action::Start { translate_mode: false }]);
  }

  #[test]
  fn stop_emits_after_release() {
    let mut state = fresh_state();
    let start = Instant::now();
    state.handle_event(KeyEvent::Press(Key::ControlLeft), start);
    state.handle_event(KeyEvent::Press(Key::ShiftLeft), start);
    state.handle_tick(start + START_DEBOUNCE + Duration::from_millis(1));
    let _ = state.drain_actions();
    state.handle_event(KeyEvent::Release(Key::ShiftLeft), start + Duration::from_millis(200));
    state.handle_tick(start + Duration::from_millis(200) + STOP_DEBOUNCE + Duration::from_millis(1));
    assert_eq!(state.drain_actions(), vec![Action::Stop]);
  }

  #[test]
  fn escape_cancels_recording() {
    let mut state = fresh_state();
    let start = Instant::now();
    state.handle_event(KeyEvent::Press(Key::ControlLeft), start);
    state.handle_event(KeyEvent::Press(Key::ShiftLeft), start);
    state.handle_tick(start + START_DEBOUNCE + Duration::from_millis(1));
    let _ = state.drain_actions();
    state.handle_event(KeyEvent::Press(Key::Escape), start + Duration::from_millis(400));
    assert_eq!(state.drain_actions(), vec![Action::Cancel]);
  }
}