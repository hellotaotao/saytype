use crate::settings;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

// Serializes every read-modify-write of the history file. Without it, two
// transcriptions finishing at once (or an append racing a delete/clear) both
// read the same snapshot and the last writer silently drops the other's entry.
static HISTORY_LOCK: Mutex<()> = Mutex::new(());

fn history_lock() -> MutexGuard<'static, ()> {
  HISTORY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// Entry ids double as debug-audio filenames, so they must be unique even when
// two entries land in the same millisecond — hence the process-wide counter
// suffix on top of the timestamp.
static ID_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn next_entry_id() -> String {
  format!(
    "{}-{}",
    chrono::Utc::now().timestamp_millis(),
    ID_SEQ.fetch_add(1, Ordering::Relaxed)
  )
}

pub fn append_entry(entry: Value, cap: usize) -> Result<Vec<String>> {
  append_entry_in(&settings::history_path()?, entry, cap)
}

// Prepends `entry`, truncates to `cap`, and returns the audioIds of entries
// that fell off so the caller can delete their audio files.
pub fn append_entry_in(path: &Path, entry: Value, cap: usize) -> Result<Vec<String>> {
  let _guard = history_lock();
  let mut entries = read_history_entries_from(path).unwrap_or_else(|err| {
    // Tolerate an unreadable/corrupt history: start a fresh log rather than
    // failing, so the (atomic) write below repairs the file instead of every
    // future append inheriting the same read error.
    log::warn!("history unreadable, starting a fresh log: {err:#}");
    Vec::new()
  });
  entries.insert(0, entry);
  let dropped = if entries.len() > cap {
    let ids = entries[cap..]
      .iter()
      .filter_map(|e| e.get("audioId").and_then(Value::as_str).map(String::from))
      .collect();
    entries.truncate(cap);
    ids
  } else {
    Vec::new()
  };
  write_history_entries_to(path, &entries)?;
  Ok(dropped)
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
  let text = serde_json::to_string_pretty(&json!({ "activities": entries }))?;
  // Atomic write (temp + rename) so a crash mid-write can't leave a truncated,
  // unparseable history.json — which would otherwise fail every later read and,
  // via append_activity, surface as a transcription failure.
  settings::atomic_write(path, &text)
}

pub fn delete_history_entry(id: &str) -> Result<()> {
  delete_history_entry_in(&settings::history_path()?, id)
}

pub fn delete_history_entry_in(path: &Path, id: &str) -> Result<()> {
  let _guard = history_lock();
  let entries = read_history_entries_from(path)?;
  let filtered: Vec<Value> = entries
    .into_iter()
    .filter(|entry| entry.get("id").and_then(Value::as_str) != Some(id))
    .collect();
  write_history_entries_to(path, &filtered)
}

pub fn clear_history_entries() -> Result<()> {
  // Serialized too: a clear racing an in-flight append would otherwise lose to
  // the append's stale pre-clear snapshot, resurrecting the cleared entries.
  let _guard = history_lock();
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
  fn history_write_is_atomic_and_roundtrips() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("transcription-history.json");
    let entries = vec![
      json!({"id": "1", "text": "hello"}),
      json!({"id": "2", "text": "world"}),
    ];
    write_history_entries_to(&path, &entries).unwrap();

    // The temp file must have been renamed away — no ".tmp" left beside the target.
    let stray = fs::read_dir(temp.path())
      .unwrap()
      .filter_map(|e| e.ok())
      .any(|e| e.file_name().to_string_lossy().contains(".tmp"));
    assert!(!stray, "atomic_write must not leave a temp file behind");

    let read = read_history_entries_from(&path).unwrap();
    assert_eq!(read.len(), 2);
    assert_eq!(read[0]["text"], "hello");
    assert_eq!(read[1]["id"], "2");
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
  fn append_entry_prepends_caps_and_reports_dropped_audio() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("transcription-history.json");
    // Oldest entry carries audio so we can see it reported when it falls off.
    append_entry_in(&path, json!({"id": "a", "text": "1", "audioId": "a"}), 3).unwrap();
    append_entry_in(&path, json!({"id": "b", "text": "2"}), 3).unwrap();
    append_entry_in(&path, json!({"id": "c", "text": "3"}), 3).unwrap();
    let dropped = append_entry_in(&path, json!({"id": "d", "text": "4"}), 3).unwrap();

    assert_eq!(dropped, vec!["a".to_string()]);
    let entries = read_history_entries_from(&path).unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0]["id"], "d"); // newest first
    assert_eq!(entries[2]["id"], "b");
  }

  #[test]
  fn concurrent_appends_lose_no_entries() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("transcription-history.json");
    let threads: Vec<_> = (0..8)
      .map(|t| {
        let path = path.clone();
        std::thread::spawn(move || {
          for i in 0..5 {
            append_entry_in(&path, json!({"id": format!("{t}-{i}"), "text": "x"}), 1000)
              .unwrap();
          }
        })
      })
      .collect();
    for t in threads {
      t.join().unwrap();
    }

    let entries = read_history_entries_from(&path).unwrap();
    assert_eq!(entries.len(), 40, "read-modify-write appends must not overwrite each other");
  }

  #[test]
  fn entry_ids_unique_under_burst() {
    let ids: std::collections::HashSet<String> = (0..1000).map(|_| next_entry_id()).collect();
    assert_eq!(ids.len(), 1000, "ids generated in the same millisecond must not collide");
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
