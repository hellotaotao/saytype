use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

/// The tray exposes cloud providers and concrete local engines. Labels are
/// English-only like the rest of the tray menu.
const ENGINES: [(&str, &str, &str, Option<&str>); 4] = [
  ("engine-groq", "Groq (cloud)", "groq", None),
  ("engine-openai", "OpenAI (cloud)", "openai", None),
  (
    "engine-local-nemotron",
    "Local · Nemotron 3.5 ASR",
    "local",
    Some(crate::local_asr::NEMOTRON_MODEL_ID),
  ),
  (
    "engine-local-qwen",
    "Local · Qwen3-ASR",
    "local",
    Some(crate::local_asr::QWEN_MODEL_ID),
  ),
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
      "settings" => show_settings_page(app),
      "install-update" => {
        if let Err(error) = crate::updater::install_pending_and_restart(app) {
          log::error!("tray:install-update-failed error={error}");
        }
      }
      "engine-groq" => switch_engine(app, "groq", None),
      "engine-openai" => switch_engine(app, "openai", None),
      "engine-local-nemotron" => switch_engine(
        app,
        crate::local_asr::LOCAL_PROVIDER,
        Some(crate::local_asr::NEMOTRON_MODEL_ID),
      ),
      "engine-local-qwen" => switch_engine(
        app,
        crate::local_asr::LOCAL_PROVIDER,
        Some(crate::local_asr::QWEN_MODEL_ID),
      ),
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

fn show_settings_page(app: &AppHandle) {
  if let Err(error) = crate::commands::open_settings(app.clone()) {
    log::error!("tray:open-settings error={error}");
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

  // Engine quick-switch: local checkmarks include the selected model. Kept
  // fresh by refresh_menu(), which every settings write triggers.
  let config = crate::settings::read_config().unwrap_or_default();
  let engine = Submenu::with_id(app, "engine", "Engine", true)?;
  for (id, label, provider, model) in ENGINES {
    engine.append(&CheckMenuItem::with_id(
      app,
      id,
      label,
      true,
      engine_selected(&config, provider, model),
      None::<&str>,
    )?)?;
  }
  menu.append(&engine)?;
  menu.append(&PredefinedMenuItem::separator(app)?)?;

  menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
  Ok(menu)
}

fn engine_selected(
  config: &crate::settings::AppConfig,
  provider: &str,
  model: Option<&str>,
) -> bool {
  if config.provider != provider {
    return false;
  }
  model.is_none_or(|model| crate::local_asr::normalize_local_model_id(&config.model) == model)
}

/// Handle an Engine submenu click. A missing local model opens its matching
/// download panel instead of switching to an unusable backend.
fn switch_engine(app: &AppHandle, provider: &str, local_model: Option<&str>) {
  if let Some(model) = local_model {
    if !crate::local_asr::assets_ready_for(model) {
      if let Err(error) = crate::commands::show_local_model_panel(app, model) {
        log::error!("tray:open-local-model-panel error={error}");
      }
      refresh_menu(app);
      return;
    }
    if let Err(error) = crate::commands::apply_local_model_change(app, model) {
      log::error!("tray:engine-switch-failed provider={provider} model={model} error={error}");
      refresh_menu(app);
    }
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

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn local_engine_checkmark_includes_the_model() {
    let mut config = crate::settings::AppConfig::default();
    config.provider = crate::local_asr::LOCAL_PROVIDER.into();
    config.model = crate::local_asr::NEMOTRON_MODEL_ID.into();

    assert!(engine_selected(
      &config,
      crate::local_asr::LOCAL_PROVIDER,
      Some(crate::local_asr::NEMOTRON_MODEL_ID)
    ));
    assert!(!engine_selected(
      &config,
      crate::local_asr::LOCAL_PROVIDER,
      Some(crate::local_asr::QWEN_MODEL_ID)
    ));
    assert!(!engine_selected(&config, "groq", None));
  }
}
