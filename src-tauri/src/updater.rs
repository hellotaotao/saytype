use serde::Serialize;

/// A fully-downloaded update waiting for the user to restart.
pub struct PendingUpdate {
  pub update: tauri_plugin_updater::Update,
  pub bytes: Vec<u8>,
}

/// Status payload shared with the settings page via the `update-status` event
/// and the `get_update_status` command.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
  /// idle | checking | downloading | ready | upToDate | error
  pub state: String,
  /// Version of the available/downloaded update, when known.
  pub version: Option<String>,
  /// Human-readable error message when state == "error".
  pub message: Option<String>,
}

impl UpdateStatus {
  pub fn new(state: &str, version: Option<String>, message: Option<String>) -> Self {
    Self {
      state: state.into(),
      version,
      message,
    }
  }
}

impl Default for UpdateStatus {
  fn default() -> Self {
    Self::new("idle", None, None)
  }
}

#[cfg(test)]
mod tests {
  use super::UpdateStatus;

  // The settings page reads these exact JSON keys over IPC — the shape is a
  // wire contract, not an implementation detail.
  #[test]
  fn update_status_serializes_expected_keys() {
    let status = UpdateStatus::new("ready", Some("1.4.0".into()), None);
    let json = serde_json::to_value(&status).unwrap();
    assert_eq!(json["state"], "ready");
    assert_eq!(json["version"], "1.4.0");
    assert_eq!(json["message"], serde_json::Value::Null);
  }

  #[test]
  fn update_status_default_is_idle() {
    let status = UpdateStatus::default();
    assert_eq!(status.state, "idle");
    assert!(status.version.is_none());
  }
}
