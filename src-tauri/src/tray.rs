use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

/// The tray's engine entries: (menu id, label, provider value). Labels are
/// English-only like the rest of the tray menu.
const ENGINES: [(&str, &str, &str); 3] = [
  ("engine-groq", "Groq (cloud)", "groq"),
  ("engine-openai", "OpenAI (cloud)", "openai"),
  ("engine-local", "Local · Qwen3", "local"),
];

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
      "engine-groq" => switch_engine(app, "groq"),
      "engine-openai" => switch_engine(app, "openai"),
      "engine-local" => switch_engine(app, "local"),
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

  // Engine quick-switch: checkmark mirrors config.provider. Kept fresh by
  // refresh_menu(), which every settings write triggers.
  let provider = crate::settings::read_config()
    .map(|config| config.provider)
    .unwrap_or_default();
  let engine = Submenu::with_id(app, "engine", "Engine", true)?;
  for (id, label, value) in ENGINES {
    engine.append(&CheckMenuItem::with_id(
      app,
      id,
      label,
      true,
      provider == value,
      None::<&str>,
    )?)?;
  }
  menu.append(&engine)?;
  menu.append(&PredefinedMenuItem::separator(app)?)?;

  menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
  Ok(menu)
}

/// Handle an Engine submenu click. Selecting "local" before its assets are
/// downloaded must not switch to an unusable backend: open Settings on the
/// model download panel instead (settings.js listens for the event).
fn switch_engine(app: &AppHandle, provider: &str) {
  if provider == crate::local_asr::LOCAL_PROVIDER && !crate::local_asr::assets_ready() {
    if let Err(error) = crate::commands::open_local_model_panel(app.clone()) {
      log::error!("tray:open-local-model-panel error={error}");
    }
    refresh_menu(app); // undo the CheckMenuItem's optimistic toggle
    return;
  }
  if let Err(error) = crate::commands::apply_provider_change(app, provider) {
    log::error!("tray:engine-switch-failed provider={provider} error={error}");
    refresh_menu(app);
  }
}

/// Rebuild the tray menu from current state — provider checkmark and, when an
/// update download is waiting, the "Restart to update to vX.Y.Z" entry (read
/// from AppState.pending_update, which the updater stores before calling
/// here). Idempotent; called on every settings write and by the updater.
pub fn refresh_menu(app: &AppHandle) {
  let Some(tray) = app.tray_by_id("main-tray") else {
    log::warn!("tray:refresh no tray icon");
    return;
  };
  let update_version = app
    .state::<crate::state::AppState>()
    .pending_update
    .lock()
    .unwrap()
    .as_ref()
    .map(|pending| pending.update.version.clone());
  match build_menu(app, update_version.as_deref()) {
    Ok(menu) => {
      if let Err(error) = tray.set_menu(Some(menu)) {
        log::error!("tray:set-menu-failed error={error}");
      }
    }
    Err(error) => log::error!("tray:build-menu-failed error={error}"),
  }
}