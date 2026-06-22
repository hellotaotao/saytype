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

// ---- Debug-only: original-audio capture so history can play back the exact
// bytes sent to the transcription API. Gated by cfg!(debug_assertions) at the
// call sites; these helpers themselves are storage-only. ----

pub fn ext_for_mime(mime: &str) -> &'static str {
  if mime.contains("mp4") {
    "m4a"
  } else {
    "webm"
  }
}

fn mime_for_ext(ext: &str) -> String {
  if ext == "m4a" {
    "audio/mp4".into()
  } else {
    "audio/webm".into()
  }
}

pub fn write_debug_audio_in(dir: &Path, id: &str, bytes: &[u8], mime: &str) -> Result<()> {
  fs::create_dir_all(dir).with_context(|| format!("failed to create {}", dir.display()))?;
  let path = dir.join(format!("{id}.{}", ext_for_mime(mime)));
  fs::write(&path, bytes).with_context(|| format!("failed to write {}", path.display()))?;
  Ok(())
}

pub fn read_debug_audio_in(dir: &Path, id: &str) -> Result<(Vec<u8>, String)> {
  for ext in ["m4a", "webm"] {
    let path = dir.join(format!("{id}.{ext}"));
    if path.exists() {
      let bytes =
        fs::read(&path).with_context(|| format!("failed to read {}", path.display()))?;
      return Ok((bytes, mime_for_ext(ext)));
    }
  }
  anyhow::bail!("no debug audio for id {id}")
}

pub fn delete_debug_audio_in(dir: &Path, id: &str) -> Result<()> {
  for ext in ["m4a", "webm"] {
    let path = dir.join(format!("{id}.{ext}"));
    if path.exists() {
      let _ = fs::remove_file(&path);
    }
  }
  Ok(())
}

pub fn clear_debug_audio_in(dir: &Path) -> Result<()> {
  if dir.exists() {
    let _ = fs::remove_dir_all(dir);
  }
  Ok(())
}

pub fn write_debug_audio(id: &str, bytes: &[u8], mime: &str) -> Result<()> {
  write_debug_audio_in(&settings::debug_audio_dir()?, id, bytes, mime)
}

pub fn read_debug_audio(id: &str) -> Result<(Vec<u8>, String)> {
  read_debug_audio_in(&settings::debug_audio_dir()?, id)
}

pub fn delete_debug_audio(id: &str) -> Result<()> {
  delete_debug_audio_in(&settings::debug_audio_dir()?, id)
}

pub fn clear_debug_audio() -> Result<()> {
  clear_debug_audio_in(&settings::debug_audio_dir()?)
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::TempDir;

  #[test]
  fn debug_audio_roundtrip_and_cleanup() {
    let temp = TempDir::new().unwrap();
    let dir = temp.path();
    write_debug_audio_in(dir, "100", &[1, 2, 3], "audio/mp4").unwrap();
    let (bytes, mime) = read_debug_audio_in(dir, "100").unwrap();
    assert_eq!(bytes, vec![1, 2, 3]);
    assert_eq!(mime, "audio/mp4"); // m4a -> audio/mp4
    assert!(dir.join("100.m4a").exists());

    delete_debug_audio_in(dir, "100").unwrap();
    assert!(read_debug_audio_in(dir, "100").is_err());
    delete_debug_audio_in(dir, "missing").unwrap(); // best-effort, no error

    write_debug_audio_in(dir, "1", &[9], "audio/webm").unwrap();
    clear_debug_audio_in(dir).unwrap();
    assert!(read_debug_audio_in(dir, "1").is_err());
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
