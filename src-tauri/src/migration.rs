use crate::settings;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

pub fn run_if_needed() -> Result<()> {
  let config_path = settings::config_path()?;
  let history_path = settings::history_path()?;

  if config_path.exists() || history_path.exists() {
    return Ok(());
  }

  for legacy_dir in legacy_data_dirs() {
    let legacy_config = legacy_dir.join(settings::CONFIG_FILE_NAME);
    let legacy_history = legacy_dir.join(settings::HISTORY_FILE_NAME);

    let mut migrated = false;

    if legacy_config.exists() {
      let config = settings::read_config_from_path(&legacy_config)
        .with_context(|| format!("failed to migrate {}", legacy_config.display()))?;
      settings::write_config(&config)?;
      migrated = true;
    }

    if legacy_history.exists() {
      let entries = read_history_entries_from(&legacy_history)
        .with_context(|| format!("failed to migrate {}", legacy_history.display()))?;
      write_history_entries_to(&history_path, &entries)?;
      migrated = true;
    }

    if migrated {
      return Ok(());
    }
  }

  Ok(())
}

pub fn read_history_entries() -> Result<Vec<Value>> {
  read_history_entries_from(&settings::history_path()?)
}

pub fn read_history_entries_from(path: &Path) -> Result<Vec<Value>> {
  if !path.exists() {
    return Ok(vec![]);
  }

  let text = fs::read_to_string(path)
    .with_context(|| format!("failed to read {}", path.display()))?;
  let root = serde_json::from_str::<Value>(&text)
    .with_context(|| format!("failed to parse {}", path.display()))?;
  Ok(root
    .get("activities")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default())
}

pub fn write_history_entries(entries: &[Value]) -> Result<()> {
  write_history_entries_to(&settings::history_path()?, entries)
}

pub fn write_history_entries_to(path: &Path, entries: &[Value]) -> Result<()> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)
      .with_context(|| format!("failed to create {}", parent.display()))?;
  }

  let text = serde_json::to_string_pretty(&json!({ "activities": entries }))?;
  fs::write(path, text).with_context(|| format!("failed to write {}", path.display()))?;
  Ok(())
}

fn legacy_data_dirs() -> Vec<PathBuf> {
  let mut candidates = BTreeSet::new();

  if let Some(base) = dirs::data_local_dir().or_else(dirs::data_dir) {
    candidates.insert(base.join("WhispLine"));
    candidates.insert(base.join("whisp-line"));
  }

  if let Some(home) = dirs::home_dir() {
    candidates.insert(home.join("Library/Application Support/WhispLine"));
    candidates.insert(home.join("Library/Application Support/whisp-line"));
  }

  candidates.into_iter().collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::TempDir;

  #[test]
  fn parses_legacy_config() {
    let temp = TempDir::new().unwrap();
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

    let config = settings::read_config_from_path(&path).unwrap();
    assert_eq!(config.api_key, "legacy");
    assert_eq!(config.api_key_groq, "gsk");
    assert_eq!(config.api_key_openai, "osk");
    assert_eq!(config.provider, "groq");
    assert_eq!(config.language, "en");
  }

  #[test]
  fn parses_history_entries() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("transcription-history.json");
    fs::write(
      &path,
      r#"{
        "activities":[
          {"id":"1","text":"hello","timestamp":"2026-01-01T00:00:00Z","success":true,"error":null},
          {"id":"2","text":"world","timestamp":"2026-01-02T00:00:00Z","success":false,"error":"oops"}
        ]
      }"#,
    )
    .unwrap();

    let entries = read_history_entries_from(&path).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["text"], "hello");
    assert_eq!(entries[1]["error"], "oops");
  }
}