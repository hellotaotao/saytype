use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

pub fn create(app: &AppHandle) -> tauri::Result<()> {
  let show = MenuItem::with_id(app, "show", "Show Main Window", true, None::<&str>)?;
  let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
  let separator = PredefinedMenuItem::separator(app)?;
  let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&show, &settings, &separator, &quit])?;

  TrayIconBuilder::with_id("main-tray")
    .icon(app.default_window_icon().unwrap().clone())
    .menu(&menu)
    .tooltip("WhispLine")
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "show" => show_main_window(app),
      "settings" => show_settings_window(app),
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

fn show_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.set_focus();
  }
}

fn show_settings_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("settings") {
    let _ = window.show();
    let _ = window.set_focus();
  }
}