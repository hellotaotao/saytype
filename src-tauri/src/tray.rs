use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

pub fn create(app: &AppHandle) -> tauri::Result<()> {
  let menu = build_menu(app, None)?;

  // 菜单栏托盘用单色模板图标（随明暗自动反色），而非彩色 app 图标。
  let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

  TrayIconBuilder::with_id("main-tray")
    .icon(tray_icon)
    .icon_as_template(true)
    .menu(&menu)
    .tooltip("SayType")
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "show" => show_main_window(app),
      "settings" => show_settings_window(app),
      "install-update" => {
        if let Err(error) = crate::updater::install_pending_and_restart(app) {
          log::error!("tray:install-update-failed error={error}");
        }
      }
      "quit" => app.exit(0),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        show_main_window(&tray.app_handle());
      }
    })
    .build(app)?;

  Ok(())
}

pub fn show_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
}

fn show_settings_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("settings") {
    let _ = window.show();
    let _ = window.set_focus();
  }
}

/// Build the tray menu; with `update_version` set, a "Restart to update"
/// entry is prepended (tray labels are English-only, like the rest of the menu).
fn build_menu(
  app: &AppHandle,
  update_version: Option<&str>,
) -> tauri::Result<Menu<tauri::Wry>> {
  let menu = Menu::new(app)?;
  if let Some(version) = update_version {
    let install = MenuItem::with_id(
      app,
      "install-update",
      format!("Restart to update to v{version}"),
      true,
      None::<&str>,
    )?;
    menu.append(&install)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
  }
  menu.append(&MenuItem::with_id(app, "show", "Show Main Window", true, None::<&str>)?)?;
  menu.append(&MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?)?;
  menu.append(&PredefinedMenuItem::separator(app)?)?;
  menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
  Ok(menu)
}

/// Swap in a tray menu carrying the "Restart to update to vX.Y.Z" entry.
/// Called by the updater once a download is ready; idempotent.
pub fn set_update_ready(app: &AppHandle, version: &str) {
  let Some(tray) = app.tray_by_id("main-tray") else {
    log::warn!("tray:set-update-ready no tray icon");
    return;
  };
  match build_menu(app, Some(version)) {
    Ok(menu) => {
      if let Err(error) = tray.set_menu(Some(menu)) {
        log::error!("tray:set-update-menu-failed error={error}");
      }
    }
    Err(error) => log::error!("tray:build-update-menu-failed error={error}"),
  }
}