use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::state::AppState;
use crate::tray;

/// How long after startup the first automatic check runs.
const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(30);
/// Interval between automatic checks while the app stays running.
const PERIODIC_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

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

/// Store the new status and broadcast it to the frontend.
fn set_status(app: &AppHandle, status: UpdateStatus) {
  *app.state::<AppState>().update_status.lock().unwrap() = status.clone();
  let _ = app.emit("update-status", status);
}

pub fn current_status(app: &AppHandle) -> UpdateStatus {
  app.state::<AppState>().update_status.lock().unwrap().clone()
}

/// Check the manifest and, if a newer version exists, download it fully.
/// Returns the final status (also stored + emitted as `update-status`).
pub async fn check_and_download(app: &AppHandle) -> UpdateStatus {
  // Already downloaded and waiting? Don't re-check or re-download.
  // (Clone the version out so the pending_update guard is released before
  // set_status takes the update_status lock.)
  let already_ready = app
    .state::<AppState>()
    .pending_update
    .lock()
    .unwrap()
    .as_ref()
    .map(|pending| pending.update.version.clone());
  if let Some(version) = already_ready {
    let status = UpdateStatus::new("ready", Some(version), None);
    set_status(app, status.clone());
    return status;
  }

  set_status(app, UpdateStatus::new("checking", None, None));

  let checked = match app.updater() {
    Ok(updater) => updater.check().await,
    Err(error) => Err(error),
  };
  let update = match checked {
    Ok(update) => update,
    Err(error) => {
      log::warn!("updater:check-failed error={error}");
      let status = UpdateStatus::new("error", None, Some(error.to_string()));
      set_status(app, status.clone());
      return status;
    }
  };

  let Some(update) = update else {
    let status = UpdateStatus::new("upToDate", None, None);
    set_status(app, status.clone());
    return status;
  };

  let version = update.version.clone();
  log::info!("updater:found version={version}");
  set_status(app, UpdateStatus::new("downloading", Some(version.clone()), None));

  let bytes = match update.download(|_chunk, _total| {}, || {}).await {
    Ok(bytes) => bytes,
    Err(error) => {
      log::warn!("updater:download-failed version={version} error={error}");
      let status = UpdateStatus::new("error", Some(version), Some(error.to_string()));
      set_status(app, status.clone());
      return status;
    }
  };

  *app.state::<AppState>().pending_update.lock().unwrap() =
    Some(PendingUpdate { update, bytes });
  // pending_update is stored above, so the rebuilt menu picks up the entry.
  tray::refresh_menu(app);

  let status = UpdateStatus::new("ready", Some(version), None);
  set_status(app, status.clone());
  status
}

/// Install the downloaded update and relaunch. On Windows the installer kills
/// the process itself; on macOS/Linux we restart explicitly.
pub fn install_pending_and_restart(app: &AppHandle) -> Result<(), String> {
  let pending = app
    .state::<AppState>()
    .pending_update
    .lock()
    .unwrap()
    .take()
    .ok_or_else(|| "no update downloaded".to_string())?;

  log::info!("updater:install version={}", pending.update.version);
  if let Err(error) = pending.update.install(&pending.bytes) {
    let message = error.to_string();
    log::error!("updater:install-failed error={message}");
    // Put it back so the user can retry from the tray/settings.
    *app.state::<AppState>().pending_update.lock().unwrap() = Some(pending);
    set_status(app, UpdateStatus::new("error", None, Some(message.clone())));
    return Err(message);
  }
  app.restart();
}

/// Automatic background checks: once shortly after startup, then daily.
/// Stops once an update is downloaded (the user restarts whenever they like).
/// Dev builds never self-update.
pub fn spawn_periodic_checks(app: AppHandle) {
  if cfg!(debug_assertions) {
    return;
  }
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(STARTUP_CHECK_DELAY).await;
    loop {
      let status = check_and_download(&app).await;
      if status.state == "ready" {
        return;
      }
      tokio::time::sleep(PERIODIC_CHECK_INTERVAL).await;
    }
  });
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

/// The GitHub release page for `version`, or `None` when the string is not a
/// plain release version. The repository comes from Cargo.toml's `repository`
/// field, and the version is checked character by character, so the page the
/// Home update card opens can never be steered to another URL.
pub fn release_page_url(version: &str) -> Option<String> {
  let version = version.trim().trim_start_matches('v');
  let valid = !version.is_empty()
    && version.len() <= 64
    && version.starts_with(|c: char| c.is_ascii_digit())
    && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
  if !valid {
    return None;
  }
  let repository = env!("CARGO_PKG_REPOSITORY").trim_end_matches('/');
  Some(format!("{repository}/releases/tag/v{version}"))
}

#[cfg(test)]
mod release_page_tests {
  use super::release_page_url;

  #[test]
  fn builds_the_tag_page_for_a_release_version() {
    let url = release_page_url("1.15.6").unwrap();
    assert!(url.starts_with("https://github.com/"), "{url}");
    assert!(url.ends_with("/releases/tag/v1.15.6"), "{url}");
    assert_eq!(release_page_url("v1.15.6"), Some(url));
    assert!(release_page_url("1.16.0-beta.1").unwrap().ends_with("/tag/v1.16.0-beta.1"));
  }

  #[test]
  fn refuses_anything_that_could_change_the_url() {
    for bad in ["", "v", "latest", "../evil", "1.2.3/../../x", "1.2.3 && open x", "1.2.3?x=1", "1.2.3#x"] {
      assert_eq!(release_page_url(bad), None, "{bad:?}");
    }
  }
}
