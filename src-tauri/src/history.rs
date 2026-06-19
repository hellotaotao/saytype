use crate::settings;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

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

pub fn delete_history_entry(id: &str) -> Result<()> {
  delete_history_entry_in(&settings::history_path()?, id)
}

pub fn delete_history_entry_in(path: &Path, id: &str) -> Result<()> {
  let entries = read_history_entries_from(path)?;
  let filtered: Vec<Value> = entries
    .into_iter()
    .filter(|entry| entry.get("id").and_then(Value::as_str) != Some(id))
    .collect();
  write_history_entries_to(path, &filtered)
}

pub fn clear_history_entries() -> Result<()> {
  write_history_entries(&[])
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::TempDir;

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

  #[test]
  fn deletes_one_entry_by_id() {
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

    delete_history_entry_in(&path, "1").unwrap();

    let entries = read_history_entries_from(&path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["id"], "2");
  }

  #[test]
  fn delete_missing_id_is_noop() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("transcription-history.json");
    fs::write(
      &path,
      r#"{"activities":[{"id":"1","text":"hello","timestamp":"2026-01-01T00:00:00Z","success":true,"error":null}]}"#,
    )
    .unwrap();

    delete_history_entry_in(&path, "does-not-exist").unwrap();

    let entries = read_history_entries_from(&path).unwrap();
    assert_eq!(entries.len(), 1);
  }
}
