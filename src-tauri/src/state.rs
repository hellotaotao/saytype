use crate::hotkey::HotkeyHandle;
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub struct AppState {
  pub hotkey: Mutex<Option<HotkeyHandle>>,
  pub active_transcriptions: Mutex<HashMap<u64, CancellationToken>>,
  pub next_transcription_id: AtomicU64,
  pub accessibility: Mutex<Option<bool>>,
  /// Shared HTTP client for transcription requests. Reused across calls so we
  /// keep connection/TLS pooling instead of re-handshaking on every utterance,
  /// and carries the request timeouts so a hung network can't wedge the UI.
  pub http_client: reqwest::Client,
}

impl Default for AppState {
  fn default() -> Self {
    Self {
      hotkey: Mutex::new(None),
      active_transcriptions: Mutex::new(HashMap::new()),
      next_transcription_id: AtomicU64::new(0),
      accessibility: Mutex::new(None),
      http_client: reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .expect("failed to build transcription HTTP client"),
    }
  }
}
