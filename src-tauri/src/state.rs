use crate::hotkey::HotkeyHandle;
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub struct AppState {
  pub hotkey: Mutex<Option<HotkeyHandle>>,
  pub active_transcriptions: Mutex<HashMap<u64, CancellationToken>>,
  pub next_transcription_id: AtomicU64,
  pub accessibility: Mutex<Option<bool>>,
}

impl Default for AppState {
  fn default() -> Self {
    Self {
      hotkey: Mutex::new(None),
      active_transcriptions: Mutex::new(HashMap::new()),
      next_transcription_id: AtomicU64::new(0),
      accessibility: Mutex::new(None),
    }
  }
}