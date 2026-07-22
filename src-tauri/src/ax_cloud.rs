//! Window lifecycle for the Accessibility-permission drag cloud. The native
//! drag source itself lives in `platform::attach_app_drag_source`; this module
//! only shows, hides, and positions the window.

use std::sync::Once;

use tauri::{AppHandle, Manager, PhysicalPosition};

const WINDOW_LABEL: &str = "ax-cloud";

/// The native drag overlay is attached once, on the first show.
static ATTACH_OVERLAY: Once = Once::new();

/// Show the cloud. Returns false when it was NOT shown — a dev bare binary has
/// no .app bundle, and dragging it into the list would not grant SayType
/// anything, so it is better not to appear at all.
pub fn show(app: &AppHandle) -> bool {
  if crate::platform::app_bundle_path().is_none() {
    log::info!("ax-cloud: no .app bundle (dev build?), not showing the drag cloud");
    return false;
  }

  let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
    log::error!("ax-cloud: window '{WINDOW_LABEL}' is missing from tauri.conf.json");
    return false;
  };

  position_left_of_center(&window);

  // Attach the native drag overlay once; later shows reuse the one layer.
  ATTACH_OVERLAY.call_once(|| match window.ns_view() {
    Ok(view) => {
      if !crate::platform::attach_app_drag_source(view) {
        log::error!("ax-cloud: failed to attach the drag overlay");
      }
    }
    Err(error) => log::error!("ax-cloud: ns_view() unavailable: {error}"),
  });

  if let Err(error) = window.show() {
    log::error!("ax-cloud: failed to show: {error}");
    return false;
  }
  // focus:false only takes effect at creation; re-assert always-on-top after
  // show so the cloud stays above the System Settings window.
  let _ = window.set_always_on_top(true);
  true
}

pub fn hide(app: &AppHandle) {
  if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
    let _ = window.hide();
  }
}

/// System Settings usually opens centered-to-right, so the cloud sits in the
/// left third of the screen, vertically centered, to avoid covering the list
/// the user needs to reach. Computed from the actual monitor size, not
/// hardcoded pixels.
fn position_left_of_center(window: &tauri::WebviewWindow) {
  let Ok(Some(monitor)) = window.current_monitor() else {
    return;
  };
  let screen = monitor.size();
  let Ok(size) = window.outer_size() else {
    return;
  };
  let x = (screen.width as i32) / 6 - (size.width as i32) / 2;
  let y = (screen.height as i32) / 2 - (size.height as i32) / 2;
  let _ = window.set_position(PhysicalPosition::new(x.max(20), y.max(20)));
}
