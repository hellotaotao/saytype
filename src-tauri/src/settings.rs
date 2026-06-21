use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

pub const APP_IDENTIFIER: &str = "com.tao.saytype";
pub const CONFIG_FILE_NAME: &str = "config.json";
pub const HISTORY_FILE_NAME: &str = "transcription-history.json";
pub const DEFAULT_RECORD_SHORTCUT: &str = "Ctrl+Shift";
pub const TRANSLATE_SHORTCUT: &str = "Shift+Alt";

fn default_language() -> String {
  "auto".into()
}

fn default_ui_language() -> String {
  "auto".into()
}

fn default_ui_theme() -> String {
  "elegant".into()
}

fn default_model() -> String {
  "gpt-4o-mini-transcribe".into()
}

fn default_microphone() -> String {
  "default".into()
}

fn default_provider() -> String {
  "openai".into()
}

fn default_shortcut() -> String {
  DEFAULT_RECORD_SHORTCUT.into()
}

fn default_translate_shortcut() -> String {
  TRANSLATE_SHORTCUT.into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
  #[serde(default)]
  pub api_key: String,
  #[serde(default)]
  pub api_key_groq: String,
  #[serde(default, rename = "apiKeyOpenAI")]
  pub api_key_openai: String,
  #[serde(default = "default_shortcut")]
  pub shortcut: String,
  #[serde(default = "default_translate_shortcut")]
  pub translate_shortcut: String,
  #[serde(default = "default_language")]
  pub language: String,
  #[serde(default = "default_ui_language")]
  pub ui_language: String,
  #[serde(default = "default_ui_theme")]
  pub ui_theme: String,
  #[serde(default = "default_model")]
  pub model: String,
  #[serde(default = "default_microphone")]
  pub microphone: String,
  #[serde(default)]
  pub auto_launch: bool,
  #[serde(default)]
  pub start_minimized: bool,
  #[serde(default = "default_provider")]
  pub provider: String,
  #[serde(default)]
  pub dictionary: String,
}

impl Default for AppConfig {
  fn default() -> Self {
    Self {
      api_key: String::new(),
      api_key_groq: String::new(),
      api_key_openai: String::new(),
      shortcut: default_shortcut(),
      translate_shortcut: default_translate_shortcut(),
      language: default_language(),
      ui_language: default_ui_language(),
      ui_theme: default_ui_theme(),
      model: default_model(),
      microphone: default_microphone(),
      auto_launch: false,
      start_minimized: false,
      provider: default_provider(),
      dictionary: String::new(),
    }
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPayload {
  pub api_key: String,
  pub api_key_groq: String,
  #[serde(rename = "apiKeyOpenAI")]
  pub api_key_openai: String,
  pub shortcut: String,
  pub translate_shortcut: String,
  pub language: String,
  pub ui_language: String,
  pub ui_theme: String,
  pub model: String,
  pub microphone: String,
  pub auto_launch: bool,
  pub start_minimized: bool,
  pub provider: String,
  #[serde(rename = "isDev")]
  pub is_dev: bool,
}

impl SettingsPayload {
  pub fn from_config(config: &AppConfig) -> Self {
    Self {
      api_key: config.api_key.clone(),
      api_key_groq: config.api_key_groq.clone(),
      api_key_openai: config.api_key_openai.clone(),
      shortcut: config.shortcut.clone(),
      translate_shortcut: config.translate_shortcut.clone(),
      language: config.language.clone(),
      ui_language: config.ui_language.clone(),
      ui_theme: config.ui_theme.clone(),
      model: config.model.clone(),
      microphone: config.microphone.clone(),
      auto_launch: config.auto_launch,
      start_minimized: config.start_minimized,
      provider: config.provider.clone(),
      is_dev: cfg!(debug_assertions),
    }
  }
}

pub fn app_data_dir() -> Result<PathBuf> {
  let base = dirs::data_local_dir()
    .or_else(dirs::data_dir)
    .context("failed to resolve application data directory")?;
  let dir = base.join(APP_IDENTIFIER);
  fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
  Ok(dir)
}

pub fn config_path() -> Result<PathBuf> {
  Ok(app_data_dir()?.join(CONFIG_FILE_NAME))
}

pub fn history_path() -> Result<PathBuf> {
  Ok(app_data_dir()?.join(HISTORY_FILE_NAME))
}

pub fn read_config() -> Result<AppConfig> {
  read_config_from_path(&config_path()?)
}

pub fn read_config_from_path(path: &Path) -> Result<AppConfig> {
  if !path.exists() {
    return Ok(AppConfig::default());
  }

  let text = fs::read_to_string(path)
    .with_context(|| format!("failed to read {}", path.display()))?;
  let config = serde_json::from_str::<AppConfig>(&text)
    .with_context(|| format!("failed to parse {}", path.display()))?;
  Ok(config)
}

pub fn write_config(config: &AppConfig) -> Result<()> {
  write_config_to_path(&config_path()?, config)
}

pub fn write_config_to_path(path: &Path, config: &AppConfig) -> Result<()> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)
      .with_context(|| format!("failed to create {}", parent.display()))?;
  }
  let text = serde_json::to_string_pretty(config)?;
  // Atomic write: serialize to a sibling temp file, then rename over the target.
  // rename is atomic on the same filesystem, so a crash/power loss mid-write
  // leaves either the old complete config or the new one — never a truncated,
  // unparseable file (which would silently reset settings, including API keys).
  let file_name = path
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or(CONFIG_FILE_NAME);
  let tmp_path = path.with_file_name(format!("{file_name}.tmp"));
  fs::write(&tmp_path, text)
    .with_context(|| format!("failed to write {}", tmp_path.display()))?;
  fs::rename(&tmp_path, path)
    .with_context(|| format!("failed to replace {}", path.display()))?;
  Ok(())
}

pub fn selected_api_key(config: &AppConfig) -> String {
  if config.provider == "openai" {
    if !config.api_key_openai.trim().is_empty() {
      return config.api_key_openai.clone();
    }
  } else if !config.api_key_groq.trim().is_empty() {
    return config.api_key_groq.clone();
  }

  config.api_key.clone()
}

pub fn normalize_record_shortcut(value: &str) -> String {
  let mut modifiers = BTreeSet::new();
  for token in value.split('+').map(|token| token.trim().to_ascii_lowercase()) {
    let normalized = match token.as_str() {
      "ctrl" | "control" => Some("Ctrl"),
      "shift" => Some("Shift"),
      "alt" | "option" => Some("Alt"),
      "meta" | "command" | "cmd" | "super" | "win" | "windows" => Some("Meta"),
      _ => None,
    };
    if let Some(modifier) = normalized {
      modifiers.insert(modifier);
    }
  }

  let ordered = ["Ctrl", "Shift", "Alt", "Meta"]
    .into_iter()
    .filter(|modifier| modifiers.contains(modifier))
    .collect::<Vec<_>>();

  if ordered.len() < 2 {
    return DEFAULT_RECORD_SHORTCUT.into();
  }

  // The translate combo is Shift+Alt. Any record shortcut containing BOTH Shift
  // and Alt collides with it: you can't physically form a superset like
  // Ctrl+Shift+Alt without passing through Shift+Alt first, which fires the
  // translate trigger mid-press. So reject the whole family (exact match OR
  // superset), not just the exact match, and fall back to the safe default.
  if modifiers.contains("Shift") && modifiers.contains("Alt") {
    return DEFAULT_RECORD_SHORTCUT.into();
  }
  ordered.join("+")
}

/// Whether the macOS login-item registration must be re-applied.
///
/// Re-registering runs `launchctl load` on a `RunAtLoad` LaunchAgent, which
/// immediately spawns a fresh process. Doing that on every settings save would
/// launch a duplicate app instance, so callers must only re-apply when the
/// value actually changed.
pub fn auto_launch_needs_update(previous: bool, next: bool) -> bool {
  previous != next
}

pub fn update_auto_launch(enabled: bool) -> Result<()> {
  #[cfg(target_os = "macos")]
  {
    let agent_dir = dirs::home_dir()
      .context("failed to resolve home directory")?
      .join("Library")
      .join("LaunchAgents");
    fs::create_dir_all(&agent_dir)
      .with_context(|| format!("failed to create {}", agent_dir.display()))?;
    let plist_path = agent_dir.join(format!("{}.plist", APP_IDENTIFIER));

    if enabled {
      let executable = std::env::current_exe().context("failed to resolve executable path")?;
      let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>{label}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>{executable}</string>\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <false/>\n</dict>\n</plist>\n",
        label = APP_IDENTIFIER,
        executable = executable.display(),
      );
      fs::write(&plist_path, plist)
        .with_context(|| format!("failed to write {}", plist_path.display()))?;
      let _ = std::process::Command::new("launchctl")
        .args(["unload", plist_path.to_string_lossy().as_ref()])
        .status();
      let _ = std::process::Command::new("launchctl")
        .args(["load", plist_path.to_string_lossy().as_ref()])
        .status();
    } else {
      let _ = std::process::Command::new("launchctl")
        .args(["unload", plist_path.to_string_lossy().as_ref()])
        .status();
      if plist_path.exists() {
        let _ = fs::remove_file(&plist_path);
      }
    }
  }

  #[cfg(not(target_os = "macos"))]
  {
    let _ = enabled;
  }

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn defaults_match_current_app_behavior() {
    let config = AppConfig::default();
    assert_eq!(config.provider, "openai");
    assert_eq!(config.model, "gpt-4o-mini-transcribe");
    assert_eq!(config.shortcut, DEFAULT_RECORD_SHORTCUT);
    assert_eq!(config.translate_shortcut, TRANSLATE_SHORTCUT);
  }

  #[test]
  fn normalize_invalid_shortcuts_falls_back() {
    assert_eq!(normalize_record_shortcut("Ctrl"), DEFAULT_RECORD_SHORTCUT);
    assert_eq!(normalize_record_shortcut("Shift+Alt"), DEFAULT_RECORD_SHORTCUT);
    // Superset of the translate combo (Shift+Alt) must also fall back — it would
    // otherwise mis-fire into translate mode mid-keypress.
    assert_eq!(normalize_record_shortcut("Ctrl+Shift+Alt"), DEFAULT_RECORD_SHORTCUT);
    assert_eq!(normalize_record_shortcut("control + option"), "Ctrl+Alt");
  }

  #[test]
  fn parses_config_from_path() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("config.json");
    fs::write(
      &path,
      r#"{
        "apiKey":"legacy",
        "apiKeyGroq":"gsk",
        "apiKeyOpenAI":"osk",
        "provider":"groq",
        "language":"en",
        "uiTheme":"midnight"
      }"#,
    )
    .unwrap();

    let config = read_config_from_path(&path).unwrap();
    assert_eq!(config.api_key, "legacy");
    assert_eq!(config.api_key_groq, "gsk");
    assert_eq!(config.api_key_openai, "osk");
    assert_eq!(config.provider, "groq");
    assert_eq!(config.language, "en");
  }

  #[test]
  fn auto_launch_reapplies_only_when_value_changes() {
    // Unchanged → must NOT re-register: re-registering runs `launchctl load`
    // on a RunAtLoad agent, spawning a duplicate instance on every save.
    assert!(!auto_launch_needs_update(true, true));
    assert!(!auto_launch_needs_update(false, false));
    // Changed → must re-register (enable installs+loads, disable removes).
    assert!(auto_launch_needs_update(false, true));
    assert!(auto_launch_needs_update(true, false));
  }
}