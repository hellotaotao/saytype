//! Process-local observations of WebView microphone capture, not an OS grant.

#[cfg_attr(not(windows), allow(dead_code))]
pub struct CaptureMicrophoneState {
  status: &'static str,
}

impl Default for CaptureMicrophoneState {
  fn default() -> Self {
    Self { status: "unknown" }
  }
}

#[cfg_attr(not(windows), allow(dead_code))]
impl CaptureMicrophoneState {
  pub fn status(&self) -> &'static str {
    self.status
  }

  pub fn report(&mut self, outcome: &str) -> Result<bool, String> {
    let status = match outcome {
      "ok" => "granted",
      "denied" => "denied",
      "no-device" => "unavailable",
      "error" => "error",
      "unknown" => "unknown",
      _ => return Err("Invalid microphone capture outcome".into()),
    };
    let changed = self.status != status;
    self.status = status;
    Ok(changed)
  }

  pub fn reset(&mut self) -> bool {
    let changed = self.status != "unknown";
    self.status = "unknown";
    changed
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_new_process_starts_unknown() {
    assert_eq!(CaptureMicrophoneState::default().status(), "unknown");
  }

  #[test]
  fn capture_outcomes_map_to_distinct_statuses() {
    for (outcome, expected) in [
      ("ok", "granted"),
      ("denied", "denied"),
      ("no-device", "unavailable"),
      ("error", "error"),
      ("unknown", "unknown"),
    ] {
      let mut state = CaptureMicrophoneState::default();
      state.report(outcome).unwrap();
      assert_eq!(state.status(), expected, "outcome={outcome}");
    }
  }

  #[test]
  fn repeated_observations_do_not_emit_duplicate_changes() {
    let mut state = CaptureMicrophoneState::default();
    assert!(!state.report("unknown").unwrap());
    assert!(state.report("denied").unwrap());
    assert!(!state.report("denied").unwrap());
  }

  #[test]
  fn successful_capture_recovers_every_failure() {
    for outcome in ["denied", "no-device", "error"] {
      let mut state = CaptureMicrophoneState::default();
      state.report(outcome).unwrap();
      assert!(state.report("ok").unwrap());
      assert_eq!(state.status(), "granted");
    }
  }

  #[test]
  fn invalid_observation_is_rejected_without_changing_state() {
    let mut state = CaptureMicrophoneState::default();
    state.report("denied").unwrap();
    for invalid in ["", "granted", "OK", "ok ", "NotAllowedError"] {
      assert!(state.report(invalid).is_err());
      assert_eq!(state.status(), "denied");
    }
  }

  #[test]
  fn opening_settings_invalidates_observation_and_allows_retry() {
    let mut state = CaptureMicrophoneState::default();
    state.report("denied").unwrap();
    assert!(state.reset());
    assert_eq!(state.status(), "unknown");
    assert!(!state.reset());
    assert!(state.report("ok").unwrap());
    assert_eq!(state.status(), "granted");
  }
}
