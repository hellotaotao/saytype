use crate::settings;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryKind {
  Incomplete,
  InsertFailed,
}

impl RecoveryKind {
  fn as_str(self) -> &'static str {
    match self {
      Self::Incomplete => "incomplete",
      Self::InsertFailed => "insert-failed",
    }
  }
}

pub struct RecoveryWrite {
  pub entry_id: String,
  pub dropped_audio_ids: Vec<String>,
}

pub fn save_recovered_entry(
  recovery_id: &str,
  text: &str,
  kind: RecoveryKind,
  cap: usize,
) -> Result<RecoveryWrite> {
  save_recovered_entry_in(&settings::history_path()?, recovery_id, text, kind, cap)
}

// A successful return is an acknowledgement that this exact text is on disk.
// Unlike best-effort activity appends, recovery must not repair an unreadable
// log or acknowledge a failed write: the renderer still owns the only copy.
pub fn save_recovered_entry_in(
  path: &Path,
  recovery_id: &str,
  text: &str,
  kind: RecoveryKind,
  cap: usize,
) -> Result<RecoveryWrite> {
  anyhow::ensure!(cap > 0, "recovery history capacity must be positive");
  let _guard = history_lock();
  let mut entries = read_history_entries_from(path)?;
  for entry in &entries {
    let matches_id = entry.get("id").and_then(Value::as_str) == Some(recovery_id)
      || entry.get("recoveryIds").and_then(Value::as_array).is_some_and(|ids| {
        ids.iter().any(|id| id.as_str() == Some(recovery_id))
      });
    if matches_id {
      let matches_kind = match entry.get("recoveryKind").and_then(Value::as_str) {
        Some(saved_kind) => saved_kind == kind.as_str(),
        None => kind == RecoveryKind::InsertFailed && entry["success"] == true,
      };
      anyhow::ensure!(
        entry.get("text").and_then(Value::as_str) == Some(text)
          && matches_kind && entry["pending"] != true,
        "recovery id already belongs to different content"
      );
      return Ok(RecoveryWrite {
        entry_id: entry.get("id").and_then(Value::as_str)
          .context("recovered history entry has no id")?.to_owned(),
        dropped_audio_ids: Vec::new(),
      });
    }
  }

  // Complete text normally already has a successful History row. Reuse the
  // most recent exact match, retaining its audio and position. Persist the
  // stable recovery id too, so a retry cannot later create a second row.
  if kind == RecoveryKind::InsertFailed {
    if let Some(entry) = entries.iter_mut().find(|entry| {
      entry.get("id").and_then(Value::as_str).is_some()
        && entry.get("text").and_then(Value::as_str) == Some(text)
        && entry["success"] == true
        && entry["pending"] != true
        && entry["recoveryKind"] != "incomplete"
    }) {
      let entry_id = entry["id"].as_str().unwrap().to_owned();
      let mut ids = entry.get("recoveryIds").and_then(Value::as_array)
        .cloned().unwrap_or_default();
      ids.push(json!(recovery_id));
      entry["recoveryIds"] = json!(ids);
      write_history_entries_to(path, &entries)?;
      return Ok(RecoveryWrite { entry_id, dropped_audio_ids: Vec::new() });
    }
  }

  entries.insert(0, json!({
    "id": recovery_id,
    "text": text,
    "timestamp": chrono::Utc::now().to_rfc3339(),
    "success": kind == RecoveryKind::InsertFailed,
    "error": if kind == RecoveryKind::Incomplete { Some("Transcription incomplete") } else { None },
    "recovered": true,
    "recoveryKind": kind,
  }));
  let dropped_audio_ids = entries.iter().skip(cap)
    .filter_map(|entry| entry.get("audioId").and_then(Value::as_str).map(String::from))
    .collect();
  entries.truncate(cap);
  write_history_entries_to(path, &entries)?;
  Ok(RecoveryWrite { entry_id: recovery_id.to_owned(), dropped_audio_ids })
}

pub fn save_pending_audio(
  recovery_id: &str,
  bytes: &[u8],
  mime: &str,
  cap: usize,
) -> Result<RecoveryWrite> {
  save_pending_audio_in(
    &settings::history_path()?, &settings::debug_audio_dir()?, recovery_id, bytes, mime, cap,
  )
}

// The stable-id path is for late recorder audio. An IPC acknowledgement can
// time out after native persistence succeeds, so retries must compare the
// actual stored audio and must never overwrite a different clip with that id.
pub fn save_pending_audio_in(
  path: &Path,
  audio_dir: &Path,
  recovery_id: &str,
  bytes: &[u8],
  mime: &str,
  cap: usize,
) -> Result<RecoveryWrite> {
  anyhow::ensure!(cap > 0, "recovery history capacity must be positive");
  let _guard = history_lock();
  let mut entries = read_history_entries_from(path)?;
  if let Some(entry) = entries.iter().find(|entry| entry["id"] == recovery_id) {
    anyhow::ensure!(
      entry["pending"] == true && entry["audioId"] == recovery_id && entry["audioMime"] == mime,
      "pending recovery id already belongs to different content"
    );
    let (stored, _) = read_debug_audio_in(audio_dir, recovery_id)?;
    anyhow::ensure!(stored == bytes, "pending recovery id already belongs to different audio");
    return Ok(RecoveryWrite { entry_id: recovery_id.into(), dropped_audio_ids: Vec::new() });
  }

  let audio_path = audio_dir.join(format!("{recovery_id}.{}", ext_for_mime(mime)));
  let existing_audio: Vec<_> = AUDIO_EXTS.iter()
    .map(|ext| audio_dir.join(format!("{recovery_id}.{ext}")))
    .filter(|path| path.exists())
    .collect();
  if !existing_audio.is_empty() {
    anyhow::ensure!(
      existing_audio.len() == 1 && existing_audio[0] == audio_path
        && fs::read(&audio_path)? == bytes,
      "pending recovery id already belongs to different audio"
    );
  } else {
    // With the History lock held, no other recovery writer can create this id.
    // Remove a partial write on failure rather than leaving unreferenced audio.
    if let Err(error) = write_debug_audio_in(audio_dir, recovery_id, bytes, mime) {
      let _ = fs::remove_file(&audio_path);
      return Err(error);
    }
  }
  entries.insert(0, json!({
    "id": recovery_id,
    "text": "",
    "timestamp": chrono::Utc::now().to_rfc3339(),
    "success": false,
    "error": null,
    "pending": true,
    "audioId": recovery_id,
    "audioMime": mime,
  }));
  let dropped_audio_ids = entries.iter().skip(cap)
    .filter_map(|entry| entry.get("audioId").and_then(Value::as_str).map(String::from))
    .collect();
  entries.truncate(cap);
  if let Err(error) = write_history_entries_to(path, &entries) {
    if let Err(cleanup_error) = fs::remove_file(&audio_path) {
      return Err(error.context(format!("recovery audio cleanup also failed: {cleanup_error}")));
    }
    return Err(error);
  }
  Ok(RecoveryWrite { entry_id: recovery_id.into(), dropped_audio_ids })
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

pub fn update_history_entry(id: &str, new_entry: Value) -> Result<bool> {
  update_history_entry_in(&settings::history_path()?, id, new_entry)
}

// Replaces the entry whose "id" matches, in place (keeping its list position),
// with `new_entry`. Returns whether a match was found. Used by re-transcribe to
// turn a "pending audio" placeholder back into a normal text entry without
// reordering history.
pub fn update_history_entry_in(path: &Path, id: &str, new_entry: Value) -> Result<bool> {
  let _guard = history_lock();
  let mut entries = read_history_entries_from(path)?;
  let mut found = false;
  for entry in entries.iter_mut() {
    if entry.get("id").and_then(Value::as_str) == Some(id) {
      *entry = new_entry;
      found = true;
      break;
    }
  }
  if found {
    write_history_entries_to(path, &entries)?;
  }
  Ok(found)
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
  if mime.contains("wav") {
    "wav"
  } else if mime.contains("mp4") {
    "m4a"
  } else {
    "webm"
  }
}

fn mime_for_ext(ext: &str) -> String {
  match ext {
    "wav" => "audio/wav".into(),
    "m4a" => "audio/mp4".into(),
    _ => "audio/webm".into(),
  }
}

// Extensions the audio store may have written, newest formats first. Read/delete
// probe each since the entry only records the id, not the extension.
const AUDIO_EXTS: [&str; 3] = ["wav", "m4a", "webm"];

pub fn write_debug_audio_in(dir: &Path, id: &str, bytes: &[u8], mime: &str) -> Result<()> {
  fs::create_dir_all(dir).with_context(|| format!("failed to create {}", dir.display()))?;
  let path = dir.join(format!("{id}.{}", ext_for_mime(mime)));
  fs::write(&path, bytes).with_context(|| format!("failed to write {}", path.display()))?;
  Ok(())
}

pub fn read_debug_audio_in(dir: &Path, id: &str) -> Result<(Vec<u8>, String)> {
  for ext in AUDIO_EXTS {
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
  for ext in AUDIO_EXTS {
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
  fn recovered_entry_retries_are_idempotent_and_preserve_raw_text() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    let id = "recovery-100-1";
    let text = "  Raw recovered words.\n";
    for _ in 0..2 {
      let saved = save_recovered_entry_in(&path, id, text, RecoveryKind::InsertFailed, 100)
        .unwrap();
      assert_eq!(saved.entry_id, id);
      assert!(saved.dropped_audio_ids.is_empty());
    }
    let entries = read_history_entries_from(&path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["text"], text);
    assert_eq!(entries[0]["recovered"], true);
    assert_eq!(entries[0]["recoveryKind"], "insert-failed");
    assert_eq!(entries[0]["success"], true);
    assert!(save_recovered_entry_in(&path, id, "different", RecoveryKind::InsertFailed, 100)
      .is_err());
    assert!(save_recovered_entry_in(&path, id, text, RecoveryKind::Incomplete, 100).is_err());
  }

  #[test]
  fn complete_recovery_reuses_most_recent_successful_history_entry() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    write_history_entries_to(&path, &[
      json!({"id": "new", "text": "same words", "success": true, "audioId": "clip"}),
      json!({"id": "old", "text": "same words", "success": true}),
    ]).unwrap();
    for _ in 0..2 {
      let saved = save_recovered_entry_in(
        &path, "recovery-100-2", "same words", RecoveryKind::InsertFailed, 100,
      ).unwrap();
      assert_eq!(saved.entry_id, "new");
    }
    let entries = read_history_entries_from(&path).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["audioId"], "clip");
    assert_eq!(entries[0]["recoveryIds"], json!(["recovery-100-2"]));
    assert!(save_recovered_entry_in(
      &path, "recovery-100-2", "different", RecoveryKind::InsertFailed, 100,
    ).is_err());
  }

  #[test]
  fn incomplete_recovery_keeps_a_separate_failed_entry_even_when_text_matches() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    append_entry_in(&path, json!({"id": "complete", "text": "some words", "success": true}), 100)
      .unwrap();
    save_recovered_entry_in(
      &path, "recovery-100-3", "some words", RecoveryKind::Incomplete, 100,
    ).unwrap();
    let entries = read_history_entries_from(&path).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["id"], "recovery-100-3");
    assert_eq!(entries[0]["text"], "some words");
    assert_eq!(entries[0]["success"], false);
    assert_eq!(entries[0]["recovered"], true);
    assert_eq!(entries[0]["recoveryKind"], "incomplete");
    assert!(entries[0]["pending"].is_null());
  }

  #[test]
  fn complete_recovery_does_not_reuse_failed_incomplete_or_pending_rows() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    write_history_entries_to(&path, &[
      json!({"id": "failed", "text": "same words", "success": false}),
      json!({"id": "pending", "text": "same words", "success": true, "pending": true}),
      json!({"id": "partial", "text": "same words", "success": true, "recoveryKind": "incomplete"}),
    ]).unwrap();
    let saved = save_recovered_entry_in(
      &path, "recovery-100-7", "same words", RecoveryKind::InsertFailed, 100,
    ).unwrap();
    assert_eq!(saved.entry_id, "recovery-100-7");
    assert_eq!(read_history_entries_from(&path).unwrap().len(), 4);
  }

  #[test]
  fn concurrent_recovery_retries_save_one_entry() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    let threads: Vec<_> = (0..8).map(|_| {
      let path = path.clone();
      std::thread::spawn(move || {
        save_recovered_entry_in(
          &path, "recovery-100-8", "same words", RecoveryKind::Incomplete, 100,
        ).unwrap().entry_id
      })
    }).collect();
    for thread in threads {
      assert_eq!(thread.join().unwrap(), "recovery-100-8");
    }
    assert_eq!(read_history_entries_from(&path).unwrap().len(), 1);
  }

  #[test]
  fn recovered_entry_cap_returns_dropped_audio_for_cleanup() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    append_entry_in(&path, json!({"id": "old", "text": "old", "audioId": "old-audio"}), 100)
      .unwrap();
    let saved = save_recovered_entry_in(
      &path, "recovery-100-4", "new", RecoveryKind::Incomplete, 1,
    ).unwrap();
    assert_eq!(saved.dropped_audio_ids, vec!["old-audio"]);
    assert_eq!(read_history_entries_from(&path).unwrap().len(), 1);
  }

  #[test]
  fn recovered_entry_disk_failure_returns_error_without_false_ack() {
    let temp = TempDir::new().unwrap();
    let blocked_parent = temp.path().join("regular-file");
    fs::write(&blocked_parent, "not a directory").unwrap();
    assert!(save_recovered_entry_in(
      &blocked_parent.join("history.json"), "recovery-100-5", "unsaved words",
      RecoveryKind::InsertFailed, 100,
    ).is_err());
    assert_eq!(fs::read_to_string(&blocked_parent).unwrap(), "not a directory");
  }

  #[test]
  fn recovered_entry_preserves_unreadable_history_instead_of_repairing_it() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    fs::write(&path, "unparseable history").unwrap();
    assert!(save_recovered_entry_in(
      &path, "recovery-100-6", "unsaved words", RecoveryKind::Incomplete, 100,
    ).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "unparseable history");
  }

  #[test]
  fn pending_audio_recovery_ack_retry_reuses_one_history_row_and_audio_file() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    let audio_dir = temp.path().join("audio");
    for _ in 0..2 {
      let saved = save_pending_audio_in(
        &path, &audio_dir, "pending-100-1", &[1, 2, 3], "audio/mp4", 100,
      ).unwrap();
      assert_eq!(saved.entry_id, "pending-100-1");
    }
    let entries = read_history_entries_from(&path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["pending"], true);
    assert_eq!(entries[0]["audioId"], "pending-100-1");
    assert_eq!(fs::read_dir(&audio_dir).unwrap().count(), 1);
    assert_eq!(read_debug_audio_in(&audio_dir, "pending-100-1").unwrap().0, vec![1, 2, 3]);
  }

  #[test]
  fn pending_audio_recovery_rejects_different_bytes_and_mime_for_the_same_id() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    let audio_dir = temp.path().join("audio");
    save_pending_audio_in(&path, &audio_dir, "pending-100-2", &[1], "audio/wav", 100)
      .unwrap();
    assert!(save_pending_audio_in(
      &path, &audio_dir, "pending-100-2", &[2], "audio/wav", 100,
    ).is_err());
    assert!(save_pending_audio_in(
      &path, &audio_dir, "pending-100-2", &[1], "audio/mp4", 100,
    ).is_err());
    assert_eq!(read_debug_audio_in(&audio_dir, "pending-100-2").unwrap().0, vec![1]);
    assert_eq!(read_history_entries_from(&path).unwrap().len(), 1);
    assert_eq!(fs::read_dir(&audio_dir).unwrap().count(), 1);
  }

  #[test]
  fn pending_audio_recovery_cleans_audio_when_history_write_fails() {
    let temp = TempDir::new().unwrap();
    let blocked_parent = temp.path().join("regular-file");
    fs::write(&blocked_parent, "not a directory").unwrap();
    let audio_dir = temp.path().join("audio");
    assert!(save_pending_audio_in(
      &blocked_parent.join("history.json"), &audio_dir, "pending-100-3", &[1], "audio/wav", 100,
    ).is_err());
    assert_eq!(fs::read_dir(&audio_dir).unwrap().count(), 0);
  }

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
  fn audio_roundtrip_supports_wav() {
    // Local-mode failed clips are 16 kHz WAV; the pending-audio store must keep
    // them as .wav and report audio/wav, not fall through to the webm branch.
    let temp = TempDir::new().unwrap();
    let dir = temp.path();
    write_debug_audio_in(dir, "w", &[1, 2, 3], "audio/wav").unwrap();
    assert!(dir.join("w.wav").exists(), "wav must be stored with a .wav extension");
    let (bytes, mime) = read_debug_audio_in(dir, "w").unwrap();
    assert_eq!(bytes, vec![1, 2, 3]);
    assert_eq!(mime, "audio/wav");
    delete_debug_audio_in(dir, "w").unwrap();
    assert!(read_debug_audio_in(dir, "w").is_err());
  }

  #[test]
  fn update_history_entry_replaces_matching_entry_in_place() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("transcription-history.json");
    append_entry_in(&path, json!({"id": "1", "text": "a"}), 10).unwrap();
    append_entry_in(&path, json!({"id": "2", "text": "b", "pending": true}), 10).unwrap();

    let updated = update_history_entry_in(
      &path,
      "2",
      json!({"id": "2", "text": "fixed", "pending": false, "success": true}),
    )
    .unwrap();
    assert!(updated);

    let entries = read_history_entries_from(&path).unwrap();
    assert_eq!(entries.len(), 2);
    // Position preserved (newest-first: id 2 was appended last, so it's index 0).
    assert_eq!(entries[0]["id"], "2");
    assert_eq!(entries[0]["text"], "fixed");
    assert_eq!(entries[0]["pending"], false);
    assert_eq!(entries[1]["id"], "1"); // untouched

    // A missing id changes nothing and reports not-found.
    assert!(!update_history_entry_in(&path, "nope", json!({"id": "nope"})).unwrap());
    assert_eq!(read_history_entries_from(&path).unwrap().len(), 2);
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
