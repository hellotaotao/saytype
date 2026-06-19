mod commands;
mod history;
mod hotkey;
mod settings;
mod state;
mod tray;

use tauri::{webview::PageLoadEvent, Manager, WindowEvent};

const MAIN_ENTRY_SCRIPT: &str = include_str!("../../src/views/main.js");
const SETTINGS_ENTRY_SCRIPT: &str = include_str!("../../src/views/settings.js");
const INPUT_PROMPT_ENTRY_SCRIPT: &str = include_str!("../../src/views/input-prompt.js");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(state::AppState::default())
    .on_page_load(|webview, payload| {
      let label = webview.label().to_string();
      let event = payload.event();
      if cfg!(debug_assertions) {
        let url = payload.url().to_string();
        log::info!(
          "webview:page-load label={} event={:?} url={}",
          label,
          event,
          url
        );
      }

      if event != PageLoadEvent::Finished {
        return;
      }

      let entry_injection = match label.as_str() {
        "main" => Some(("data-main-js-ran", MAIN_ENTRY_SCRIPT)),
        "settings" => Some(("data-settings-js-ran", SETTINGS_ENTRY_SCRIPT)),
        "input-prompt" => Some(("data-input-prompt-js-ran", INPUT_PROMPT_ENTRY_SCRIPT)),
        _ => None,
      };

      if let Some((marker, script)) = entry_injection {
        let injection = format!(
          r#"
(() => {{
  const html = document.documentElement;
  if (html?.getAttribute('{marker}')) {{
    return;
  }}

  {script}
}})()
"#,
          marker = marker,
          script = script
        );

        if let Err(error) = webview.eval(&injection) {
          log::error!(
            "webview:page-entry-injection-failed label={} marker={} error={}",
            label,
            marker,
            error
          );
        }
      }
    })
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        let label = window.label();
        if label == "main" || label == "settings" {
          api.prevent_close();
          let _ = window.hide();
        }
      }
    })
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      tray::create(&app.handle())?;

      let config = settings::read_config().unwrap_or_default();
      let accessibility = commands::current_accessibility_granted();
      *app.state::<state::AppState>().accessibility.lock().unwrap() = Some(accessibility);

      let hotkey_handle = hotkey::start_listener(&app.handle(), config.shortcut.clone());
      *app.state::<state::AppState>().hotkey.lock().unwrap() = Some(hotkey_handle);

      if !config.start_minimized {
        if let Some(window) = app.get_webview_window("main") {
          let _ = window.show();
          let _ = window.set_focus();
        }
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::get_settings,
      commands::save_settings,
      commands::get_app_version,
      commands::open_settings,
      commands::close_settings,
      commands::hide_input_prompt,
      commands::cleanup_microphone,
      commands::cancel_transcription,
      commands::transcribe_audio,
      commands::type_text,
      commands::show_permission_dialog,
      commands::check_microphone_permission,
      commands::check_accessibility_permission,
      commands::request_accessibility_permission,
      commands::recheck_accessibility_permission,
      commands::get_recent_activities,
      commands::delete_history_item,
      commands::clear_history,
      commands::get_dictionary,
      commands::save_dictionary,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|_app_handle, _event| {
      // macOS: clicking the Dock icon (or relaunching the app) when no window
      // is visible — e.g. after starting minimized — should bring the main
      // window back, matching standard macOS behavior.
      #[cfg(target_os = "macos")]
      if let tauri::RunEvent::Reopen { .. } = _event {
        tray::show_main_window(_app_handle);
      }
    });
}
