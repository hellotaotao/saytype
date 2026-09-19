use crate::retry_error::RetryError;
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

// Every History writer enforces this row limit. Rows past it fall off, and the
// writers return their audioIds so the caller can delete the clips too.
const HISTORY_CAP: usize = 200;

pub fn append_entry(entry: Value) -> Result<Vec<String>> {
  append_entry_in(&settings::history_path()?, entry, HISTORY_CAP)
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
  let dropped = collect_dropped_audio(&mut entries, cap);
  write_history_entries_to(path, &entries)?;
  Ok(dropped)
}

fn collect_dropped_audio(entries: &mut Vec<Value>, cap: usize) -> Vec<String> {
  let dropped = entries.iter().skip(cap)
    .filter_map(|entry| entry.get("audioId").and_then(Value::as_str).map(String::from))
    .collect();
  entries.truncate(cap);
  dropped
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
) -> Result<RecoveryWrite> {
  save_recovered_entry_in(&settings::history_path()?, recovery_id, text, kind, HISTORY_CAP)
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
  let dropped_audio_ids = collect_dropped_audio(&mut entries, cap);
  write_history_entries_to(path, &entries)?;
  Ok(RecoveryWrite { entry_id: recovery_id.to_owned(), dropped_audio_ids })
}

pub fn save_pending_audio(
  recovery_id: &str,
  bytes: &[u8],
  mime: &str,
) -> Result<RecoveryWrite> {
  save_pending_audio_in(
    &settings::history_path()?, &settings::debug_audio_dir()?, recovery_id, bytes, mime,
    HISTORY_CAP,
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
  let dropped_audio_ids = collect_dropped_audio(&mut entries, cap);
  if let Err(error) = write_history_entries_to(path, &entries) {
    if let Err(cleanup_error) = fs::remove_file(&audio_path) {
      return Err(error.context(format!("recovery audio cleanup also failed: {cleanup_error}")));
    }
    return Err(error);
  }
  Ok(RecoveryWrite { entry_id: recovery_id.into(), dropped_audio_ids })
}

// A failed transcription keeps the exact clip it could not transcribe, on the
// same row that reports why it failed — so History shows one entry, not a
// text-only failure beside an audio-only placeholder. `pending` marks it
// re-transcribable; `translate` records the mode so a retry keeps the user's
// original intent. The audio write MUST succeed (a pending row with no audio is
// useless), so its error propagates and the caller falls back to a plain row.
//
// `failure_id` makes a re-attempted upload idempotent — see the function body.
#[allow(clippy::too_many_arguments)]
pub fn append_failed_audio(
  failure_id: Option<&str>,
  message: &str,
  error: &str,
  bytes: &[u8],
  mime: &str,
  translate: bool,
) -> Result<RecoveryWrite> {
  append_failed_audio_in(
    &settings::history_path()?, &settings::debug_audio_dir()?, failure_id, message, error, bytes,
    mime, translate, HISTORY_CAP,
  )
}

#[allow(clippy::too_many_arguments)]
pub fn append_failed_audio_in(
  path: &Path,
  audio_dir: &Path,
  failure_id: Option<&str>,
  message: &str,
  error: &str,
  bytes: &[u8],
  mime: &str,
  translate: bool,
  cap: usize,
) -> Result<RecoveryWrite> {
  anyhow::ensure!(cap > 0, "history capacity must be positive");
  // Held across the whole read-modify-write, so the insert below is inlined
  // rather than delegated to append_entry_in — that would re-enter this lock.
  let _guard = history_lock();
  let mut entries = read_history_entries_from(path).unwrap_or_else(|err| {
    log::warn!("history unreadable, starting a fresh log: {err:#}");
    Vec::new()
  });

  // The frontend auto-retries a timed-out upload, and that retry is the SAME
  // recording: without a stable id each attempt logs its own row and stores its
  // own clip, and a retry that finally succeeds leaves the first row orphaned.
  // Only a still-pending row is reused — one that has moved on (re-transcribed
  // into text, or replaced) keeps whatever it became.
  if let Some(id) = failure_id {
    if let Some(entry) = entries.iter_mut().find(|entry| {
      entry.get("id").and_then(Value::as_str) == Some(id) && entry["pending"] == true
    }) {
      // Same clip, already on disk — only the reason it failed has changed.
      entry["text"] = json!(message);
      entry["error"] = json!(error);
      entry["timestamp"] = json!(chrono::Utc::now().to_rfc3339());
      write_history_entries_to(path, &entries)?;
      return Ok(RecoveryWrite { entry_id: id.to_owned(), dropped_audio_ids: Vec::new() });
    }
  }

  let id = match failure_id {
    Some(id)
      if !entries.iter().any(|e| e.get("id").and_then(Value::as_str) == Some(id)) =>
    {
      id.to_owned()
    }
    _ => next_entry_id(),
  };
  let audio_path = audio_dir.join(format!("{id}.{}", ext_for_mime(mime)));
  if let Err(error) = write_debug_audio_in(audio_dir, &id, bytes, mime) {
    let _ = fs::remove_file(&audio_path);
    return Err(error);
  }
  entries.insert(0, json!({
    "id": id,
    "text": message,
    "timestamp": chrono::Utc::now().to_rfc3339(),
    "success": false,
    "error": error,
    "pending": true,
    "translate": translate,
    "audioId": id,
    "audioMime": mime,
  }));
  let dropped_audio_ids = collect_dropped_audio(&mut entries, cap);
  if let Err(write_error) = write_history_entries_to(path, &entries) {
    // Never leave a clip on disk that no history row points at.
    if let Err(cleanup_error) = fs::remove_file(&audio_path) {
      return Err(write_error
        .context(format!("failed-transcription audio cleanup also failed: {cleanup_error}")));
    }
    return Err(write_error);
  }
  Ok(RecoveryWrite { entry_id: id, dropped_audio_ids })
}

// Empty automatic retries and all manual retry results use this transition.
// Keep the row pending on empty text; release the clip only after nonempty text
// is persisted. A competing result can only claim a still-pending row.
pub fn finish_pending_transcription(id: &str, text: &str) -> Result<bool> {
  finish_pending_transcription_in(&settings::history_path()?, &settings::debug_audio_dir()?, id, text)
}

// Partial text is preserved by the frontend; retain this clip but retire the
// earlier upload error once retry succeeds. Never overwrite a settled row.
pub fn refresh_incomplete_retry(id: &str, text: &str) -> Result<bool> {
  refresh_incomplete_retry_in(&settings::history_path()?, id, text)
}

fn refresh_incomplete_retry_in(path: &Path, id: &str, text: &str) -> Result<bool> {
  let reason = if text.trim().is_empty() { RetryError::NoSpeech } else { RetryError::CaptureIncomplete };
  refresh_pending_failure_in(path, id, reason.code(), reason.code(), true)
}

pub fn finish_pending_transcription_in(path: &Path, audio_dir: &Path, id: &str, text: &str) -> Result<bool> {
  if text.trim().is_empty() {
    return refresh_pending_failure_in(path, id, RetryError::NoSpeech.code(), RetryError::NoSpeech.code(), true);
  }
  let resolved = resolve_failed_audio_in(path, id, text)?;
  if resolved {
    if let Err(error) = delete_debug_audio_in(audio_dir, id) {
      log::warn!("failed to release resolved recording: {error:#}");
    }
  }
  Ok(resolved)
}

pub fn resolve_failed_audio_in(path: &Path, failure_id: &str, text: &str) -> Result<bool> {
  anyhow::ensure!(!text.trim().is_empty(), "cannot resolve a recording without text");
  let _guard = history_lock();
  let mut entries = read_history_entries_from(path)?;
  let Some(entry) = entries.iter_mut().find(|entry| {
    entry.get("id").and_then(Value::as_str) == Some(failure_id) && entry["pending"] == true
  }) else {
    return Ok(false);
  };
  settle_pending_entry(entry, failure_id, text);
  write_history_entries_to(path, &entries)?;
  Ok(true)
}

fn settle_pending_entry(entry: &mut Value, failure_id: &str, text: &str) {
  let timestamp = entry
    .get("timestamp")
    .cloned()
    .unwrap_or_else(|| json!(chrono::Utc::now().to_rfc3339()));
  *entry = json!({
    "id": failure_id,
    "text": text,
    "timestamp": timestamp,
    "success": true,
    "error": null,
  });
}

// Build a fresh entry lazily: a retry resolving an existing row needs neither a
// second History read nor a new debug-audio copy.
pub fn record_transcription(
  text: &str, failure_id: Option<&str>, make_entry: impl FnOnce() -> Value,
) -> Result<Vec<String>> {
  record_transcription_in(&settings::history_path()?, text, failure_id, HISTORY_CAP, make_entry)
}

fn record_transcription_in(
  path: &Path, text: &str, failure_id: Option<&str>, cap: usize, make_entry: impl FnOnce() -> Value,
) -> Result<Vec<String>> {
  anyhow::ensure!(!text.trim().is_empty(), "cannot record empty transcription");
  anyhow::ensure!(cap > 0, "history capacity must be positive");
  let _guard = history_lock();
  let mut entries = read_history_entries_from(path).unwrap_or_else(|error| {
    log::warn!("history unreadable, starting a fresh log: {error:#}");
    Vec::new()
  });
  if let Some(id) = failure_id {
    if let Some(entry) = entries.iter_mut().find(|entry| entry["id"] == id && entry["pending"] == true) {
      let audio_id = entry["audioId"].as_str().map(str::to_owned);
      settle_pending_entry(entry, id, text);
      write_history_entries_to(path, &entries)?;
      return Ok(audio_id.into_iter().collect());
    }
  }
  entries.insert(0, make_entry());
  let dropped = collect_dropped_audio(&mut entries, cap);
  write_history_entries_to(path, &entries)?;
  Ok(dropped)
}

// Audio I/O happens before acquiring the History lock. If deletion/cap eviction
// wins while writing, remove the unreferenced clip instead of resurrecting a row.
pub fn attach_debug_audio(id: &str, bytes: &[u8], mime: &str) -> Result<()> {
  attach_debug_audio_in(&settings::history_path()?, &settings::debug_audio_dir()?, id, bytes, mime)
}

fn attach_debug_audio_in(path: &Path, audio_dir: &Path, id: &str, bytes: &[u8], mime: &str) -> Result<()> {
  if let Err(error) = write_debug_audio_in(audio_dir, id, bytes, mime) {
    let _ = delete_debug_audio_in(audio_dir, id);
    return Err(error);
  }
  let attached = (|| -> Result<bool> {
    let _guard = history_lock();
    let mut entries = read_history_entries_from(path)?;
    let Some(entry) = entries.iter_mut().find(|entry| entry["id"] == id && entry["success"] == true) else {
      return Ok(false);
    };
    entry["audioId"] = json!(id);
    entry["audioMime"] = json!(mime);
    write_history_entries_to(path, &entries)?;
    Ok(true)
  })();
  if !matches!(attached, Ok(true)) {
    let _ = delete_debug_audio_in(audio_dir, id);
  }
  attached.map(|_| ())
}

pub fn read_history_entry(id: &str) -> Result<Option<Value>> {
  read_history_entry_in(&settings::history_path()?, id)
}

pub fn refresh_pending_failure(id: &str, message: &str, error: &str, retryable: bool) -> Result<bool> {
  refresh_pending_failure_in(&settings::history_path()?, id, message, error, retryable)
}

// Read the current row under the same lock as the write: a late failure must
// never restore a pending snapshot over another request's successful result.
pub fn refresh_pending_failure_in(
  path: &Path, id: &str, message: &str, error: &str, retryable: bool,
) -> Result<bool> {
  let _guard = history_lock();
  let mut entries = read_history_entries_from(path)?;
  let Some(entry) = entries.iter_mut().find(|entry| {
    entry.get("id").and_then(Value::as_str) == Some(id) && entry["pending"] == true
  }) else {
    return Ok(false);
  };
  entry["text"] = json!(message);
  entry["error"] = json!(error);
  if !retryable {
    entry["pending"] = json!(false);
    entry["audioId"] = Value::Null;
    entry["audioMime"] = Value::Null;
  }
  write_history_entries_to(path, &entries)?;
  Ok(true)
}

pub fn read_history_entry_in(path: &Path, id: &str) -> Result<Option<Value>> {
  Ok(read_history_entries_from(path)?
    .into_iter()
    .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id)))
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

// Test utility for exercising basic replacement; retries use guarded transitions.
#[cfg(test)]
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
    match fs::read(&path) {
      Ok(bytes) => return Ok((bytes, mime_for_ext(ext))),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
      Err(error) => return Err(error).with_context(|| format!("failed to read {}", path.display())),
    }
  }
  Err(std::io::Error::new(std::io::ErrorKind::NotFound, format!("no debug audio for id {id}")).into())
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
  fn failed_audio_entry_keeps_the_clip_error_and_translate_flag_on_one_row() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    let audio_dir = temp.path().join("audio");
    let saved = append_failed_audio_in(
      &path, &audio_dir, None, "Transcription failed: 401 unauthorized",
      "401 unauthorized", &[1, 2, 3], "audio/wav", true, 100,
    ).unwrap();
    assert!(saved.dropped_audio_ids.is_empty());

    let entries = read_history_entries_from(&path).unwrap();
    assert_eq!(entries.len(), 1, "a failure must not log a second text-only row");
    let entry = &entries[0];
    assert_eq!(entry["id"], saved.entry_id.as_str());
    assert_eq!(entry["text"], "Transcription failed: 401 unauthorized");
    assert_eq!(entry["error"], "401 unauthorized");
    assert_eq!(entry["success"], false);
    assert_eq!(entry["pending"], true);
    assert_eq!(entry["translate"], true);
    assert_eq!(entry["audioId"], saved.entry_id.as_str());
    assert_eq!(entry["audioMime"], "audio/wav");
    assert_eq!(read_debug_audio_in(&audio_dir, &saved.entry_id).unwrap().0, vec![1, 2, 3]);
  }

  #[test]
  fn failed_audio_entry_reports_dropped_audio_for_cleanup() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    let audio_dir = temp.path().join("audio");
    append_entry_in(&path, json!({"id": "old", "text": "old", "audioId": "old-audio"}), 100)
      .unwrap();
    let saved = append_failed_audio_in(
      &path, &audio_dir, None, "Transcription failed: offline", "offline", &[9], "audio/wav",
      false, 1,
    ).unwrap();
    assert_eq!(saved.dropped_audio_ids, vec!["old-audio"]);
    assert_eq!(read_history_entries_from(&path).unwrap().len(), 1);
  }

  #[test]
  fn failed_audio_entry_cleans_its_audio_when_the_history_write_fails() {
    let temp = TempDir::new().unwrap();
    let blocked_parent = temp.path().join("regular-file");
    fs::write(&blocked_parent, "not a directory").unwrap();
    let audio_dir = temp.path().join("audio");
    assert!(append_failed_audio_in(
      &blocked_parent.join("history.json"), &audio_dir, None, "failed", "boom", &[1], "audio/wav",
      false, 100,
    ).is_err());
    assert_eq!(fs::read_dir(&audio_dir).unwrap().count(), 0,
      "an unreferenced clip must not be left behind");
  }

  // The whole point of the feature: a failed clip survives in History until a
  // re-transcription actually produces text, and only then is the audio dropped.
  #[test]
  fn a_failed_clip_outlives_its_failure_and_is_dropped_only_once_text_exists() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    let audio_dir = temp.path().join("audio");
    append_entry_in(&path, json!({"id": "older", "text": "an earlier success"}), 100).unwrap();

    let saved = append_failed_audio_in(
      &path, &audio_dir, None, "Transcription failed: API key not configured",
      "API key not configured", &[7, 7, 7], "audio/wav", false, 100,
    ).unwrap();
    let id = saved.entry_id;

    // A retry that fails again keeps both the row and the clip.
    assert!(refresh_pending_failure_in(&path, &id,
      "Transcription failed: connection reset", "connection reset", true).unwrap());
    let entry = read_history_entry_in(&path, &id).unwrap().unwrap();
    assert_eq!(entry["pending"], true);
    assert_eq!(entry["error"], "connection reset");
    assert_eq!(read_debug_audio_in(&audio_dir, &id).unwrap().0, vec![7, 7, 7]);

    // Empty and scrubbed-to-empty results must preserve the original clip.
    for raw in ["", "   ", "字幕由 Amara.org 社区提供。"] {
      let text = crate::scrub::scrub_transcription(raw);
      assert!(text.trim().is_empty());
      assert!(finish_pending_transcription_in(&path, &audio_dir, &id, &text).unwrap());
      let entry = read_history_entry_in(&path, &id).unwrap().unwrap();
      assert_eq!(entry["pending"], true);
      assert_eq!(entry["error"], "RETRY_NO_SPEECH");
      assert_eq!(read_debug_audio_in(&audio_dir, &id).unwrap().0, vec![7, 7, 7]);
    }
    assert!(finish_pending_transcription_in(&path, &audio_dir, &id,
      "the words that were nearly lost").unwrap());
    let settled = read_history_entry_in(&path, &id).unwrap();
    for text in ["", "late competing text"] {
      assert!(!finish_pending_transcription_in(&path, &audio_dir, &id, text).unwrap());
      assert_eq!(read_history_entry_in(&path, &id).unwrap(), settled);
    }

    let entries = read_history_entries_from(&path).unwrap();
    assert_eq!(entries.len(), 2, "one recording must never occupy two rows");
    assert_eq!(entries[0]["id"], id.as_str(), "the row keeps its position");
    assert_eq!(entries[0]["text"], "the words that were nearly lost");
    assert!(entries[0]["pending"].is_null());
    assert_eq!(entries[1]["id"], "older");
    assert!(read_debug_audio_in(&audio_dir, &id).is_err(), "the clip is dropped only now");
  }

  // The frontend auto-retries a timed-out upload, and the retry is the SAME
  // recording. Without a stable id each attempt logs its own row and stores its
  // own clip, and a retry that finally succeeds leaves the first row orphaned.
  #[test]
  fn a_retried_upload_refreshes_one_row_instead_of_logging_a_second() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    let audio_dir = temp.path().join("audio");
    let retry_id = "failed-1788040000000-7";

    let first = append_failed_audio_in(
      &path, &audio_dir, Some(retry_id), "Transcription failed: operation timed out",
      "operation timed out", &[4, 2], "audio/wav", false, 100,
    ).unwrap();
    assert_eq!(first.entry_id, retry_id);

    let second = append_failed_audio_in(
      &path, &audio_dir, Some(retry_id), "Transcription failed: connection reset",
      "connection reset", &[4, 2], "audio/wav", false, 100,
    ).unwrap();
    assert_eq!(second.entry_id, retry_id, "the retry must land on the first attempt's row");

    let entries = read_history_entries_from(&path).unwrap();
    assert_eq!(entries.len(), 1, "one recording, one row");
    assert_eq!(entries[0]["error"], "connection reset", "the reason is refreshed");
    assert_eq!(entries[0]["pending"], true);
    assert_eq!(entries[0]["audioId"], retry_id);
    assert_eq!(fs::read_dir(&audio_dir).unwrap().count(), 1, "one recording, one clip");
    assert_eq!(read_debug_audio_in(&audio_dir, retry_id).unwrap().0, vec![4, 2]);
  }

  // The other half of the retry story: when the second attempt SUCCEEDS, the row
  // its failed first attempt created must become that success, not sit beside it
  // as a failure row for a recording that transcribed fine.
  #[test]
  fn a_retry_that_succeeds_resolves_the_first_attempts_row_in_place() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    let audio_dir = temp.path().join("audio");
    let retry_id = "failed-1788040000000-11";
    append_entry_in(&path, json!({"id": "older", "text": "an earlier success"}), 100).unwrap();
    append_failed_audio_in(
      &path, &audio_dir, Some(retry_id), "Transcription failed: operation timed out",
      "operation timed out", &[4, 2], "audio/wav", false, 100,
    ).unwrap();
    let failed_at = read_history_entry_in(&path, retry_id).unwrap().unwrap()["timestamp"].clone();

    let dropped = record_transcription_in(&path, "the words that made it", Some(retry_id), 100,
      || panic!("resolving a failure must not create another entry or debug clip")).unwrap();
    assert_eq!(dropped, vec![retry_id]);

    let entries = read_history_entries_from(&path).unwrap();
    assert_eq!(entries.len(), 2, "the failure row became the success, it did not multiply");
    assert_eq!(entries[0]["id"], retry_id, "and kept its position");
    assert_eq!(entries[0]["text"], "the words that made it");
    assert_eq!(entries[0]["success"], true);
    assert!(entries[0]["pending"].is_null());
    assert!(entries[0]["error"].is_null());
    assert_eq!(entries[0]["timestamp"], failed_at, "the recording's own time is kept");
    assert_eq!(entries[1]["id"], "older");

    // Nothing to resolve: an unknown id, and a row that already settled.
    assert!(!resolve_failed_audio_in(&path, retry_id, "again").unwrap());
    assert!(!resolve_failed_audio_in(&path, "failed-1-2", "nobody").unwrap());
    assert_eq!(read_history_entries_from(&path).unwrap()[0]["text"], "the words that made it");
  }

  #[test]
  fn retry_result_preserves_audio_when_history_cannot_be_read() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    let audio_dir = temp.path().join("audio");
    write_debug_audio_in(&audio_dir, "failed-100-1", &[1, 2], "audio/wav").unwrap();
    fs::write(&path, "corrupt history").unwrap();
    for text in ["", "recovered words"] {
      assert!(finish_pending_transcription_in(&path, &audio_dir, "failed-100-1", text).is_err());
      assert_eq!(read_debug_audio_in(&audio_dir, "failed-100-1").unwrap().0, vec![1, 2]);
    }
  }

  #[test]
  fn incomplete_retry_refreshes_reason_without_releasing_audio() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    let audio_dir = temp.path().join("audio");
    let id = "failed-100-1";
    append_failed_audio_in(&path, &audio_dir, Some(id), "timeout", "timeout",
      &[1, 2], "audio/wav", true, 100).unwrap();
    for (text, reason) in [("partial words", RetryError::CaptureIncomplete), ("", RetryError::NoSpeech)] {
      assert!(refresh_incomplete_retry_in(&path, id, text).unwrap());
      let entry = read_history_entry_in(&path, id).unwrap().unwrap();
      assert_eq!(entry["error"], reason.code());
      assert_eq!(entry["text"], reason.code());
      assert_eq!(entry["pending"], true);
      assert_eq!(entry["translate"], true);
      assert_eq!(read_debug_audio_in(&audio_dir, id).unwrap().0, vec![1, 2]);
    }
    finish_pending_transcription_in(&path, &audio_dir, id, "manual result").unwrap();
    assert!(!refresh_incomplete_retry_in(&path, id, "late partial").unwrap());
    assert_eq!(read_history_entry_in(&path, id).unwrap().unwrap()["text"], "manual result");
  }

  #[test]
  fn late_automatic_success_is_saved_beside_the_manual_result() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    let audio_dir = temp.path().join("audio");
    let id = "failed-100-1";
    append_failed_audio_in(&path, &audio_dir, Some(id), "timeout", "timeout",
      &[1], "audio/wav", false, 100).unwrap();
    assert!(finish_pending_transcription_in(&path, &audio_dir, id, "manual words").unwrap());
    assert!(record_transcription_in(&path, "automatic words", Some(id), 100,
      || json!({"id": "automatic", "text": "automatic words", "success": true})).unwrap().is_empty());
    let entries = read_history_entries_from(&path).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["text"], "automatic words");
    assert_eq!(entries[1]["text"], "manual words");
    assert_eq!(entries[1]["id"], id);
    delete_history_entry_in(&path, id).unwrap();
    assert!(!finish_pending_transcription_in(&path, &audio_dir, id, "late manual").unwrap());
    assert_eq!(read_history_entries_from(&path).unwrap().len(), 1);
  }

  #[test]
  fn debug_audio_attachment_cleans_up_if_the_row_has_disappeared() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    let audio_dir = temp.path().join("audio");
    append_entry_in(&path, json!({"id": "success", "text": "words", "success": true}), 100).unwrap();
    attach_debug_audio_in(&path, &audio_dir, "success", &[1, 2], "audio/wav").unwrap();
    assert_eq!(read_history_entry_in(&path, "success").unwrap().unwrap()["audioId"], "success");
    assert_eq!(read_debug_audio_in(&audio_dir, "success").unwrap().0, vec![1, 2]);
    delete_history_entry_in(&path, "success").unwrap();
    attach_debug_audio_in(&path, &audio_dir, "success", &[3], "audio/wav").unwrap();
    assert!(read_debug_audio_in(&audio_dir, "success").is_err());
    assert!(read_history_entries_from(&path).unwrap().is_empty());
  }

  #[test]
  fn successful_transcription_honors_capacity_and_reports_evicted_audio() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    append_entry_in(&path, json!({"id": "old", "audioId": "old-audio"}), 1).unwrap();
    assert_eq!(record_transcription_in(&path, "new", None, 1,
      || json!({"id": "new", "text": "new"})).unwrap(), vec!["old-audio"]);
    assert_eq!(read_history_entries_from(&path).unwrap().len(), 1);
    assert!(record_transcription_in(&path, "new", None, 0,
      || panic!("invalid cap must not build an entry")).is_err());
  }

  // A settled row must never be overwritten by a late failure.
  #[test]
  fn a_retry_id_belonging_to_a_settled_row_starts_a_fresh_one() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    let audio_dir = temp.path().join("audio");
    let retry_id = "failed-1788040000000-9";
    write_history_entries_to(&path, &[
      json!({"id": retry_id, "text": "already recovered", "success": true}),
    ]).unwrap();

    let saved = append_failed_audio_in(
      &path, &audio_dir, Some(retry_id), "Transcription failed: offline", "offline", &[1],
      "audio/wav", false, 100,
    ).unwrap();
    assert_ne!(saved.entry_id, retry_id);

    let entries = read_history_entries_from(&path).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[1]["text"], "already recovered", "the settled row is untouched");
    assert_eq!(entries[1]["success"], true);
  }

  #[test]
  fn read_history_entry_finds_by_id_and_reports_missing() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    append_entry_in(&path, json!({"id": "a", "text": "one"}), 10).unwrap();
    append_entry_in(&path, json!({"id": "b", "text": "two", "translate": true}), 10).unwrap();

    let found = read_history_entry_in(&path, "a").unwrap().expect("entry a must be found");
    assert_eq!(found["text"], "one");
    assert_eq!(read_history_entry_in(&path, "b").unwrap().unwrap()["translate"], true);
    assert!(read_history_entry_in(&path, "missing").unwrap().is_none());
  }

  #[test]
  fn late_failure_cannot_overwrite_a_resolved_or_deleted_recording() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    let audio_dir = temp.path().join("audio");
    let id = "failed-100-1";
    append_failed_audio_in(
      &path, &audio_dir, Some(id), "timeout", "timeout", &[1], "audio/wav", false, 100,
    ).unwrap();
    // A manual request has started; the automatic retry finishes first.
    assert!(resolve_failed_audio_in(&path, id, "recovered words").unwrap());
    delete_debug_audio_in(&audio_dir, id).unwrap();
    let settled = read_history_entry_in(&path, id).unwrap().unwrap();
    for retryable in [true, false] {
      assert!(!refresh_pending_failure_in(&path, id, "late failure", "offline", retryable).unwrap());
      assert_eq!(read_history_entry_in(&path, id).unwrap().unwrap(), settled);
    }
    delete_history_entry_in(&path, id).unwrap();
    assert!(!refresh_pending_failure_in(&path, id, "late failure", "offline", true).unwrap());
    assert!(read_history_entry_in(&path, id).unwrap().is_none());
  }

  #[test]
  fn audio_read_failure_keeps_retry_until_the_clip_is_confirmed_missing() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("history.json");
    let audio_dir = temp.path().join("audio");
    let id = "failed-100-2";
    append_failed_audio_in(
      &path, &audio_dir, Some(id), "timeout", "timeout", &[1], "audio/wav", true, 100,
    ).unwrap();
    // A directory at the audio path deterministically produces a read error
    // even when tests run with privileges that bypass file permissions.
    let clip = audio_dir.join(format!("{id}.wav"));
    fs::remove_file(&clip).unwrap();
    fs::create_dir(&clip).unwrap();
    let error = read_debug_audio_in(&audio_dir, id).unwrap_err();
    assert_ne!(error.downcast_ref::<std::io::Error>().unwrap().kind(), std::io::ErrorKind::NotFound);
    assert!(refresh_pending_failure_in(&path, id, "read failed", &error.to_string(), true).unwrap());
    let entry = read_history_entry_in(&path, id).unwrap().unwrap();
    assert_eq!(entry["pending"], true);
    assert_eq!(entry["audioId"], id);
    assert_eq!(entry["translate"], true);
    fs::remove_dir(&clip).unwrap();
    write_debug_audio_in(&audio_dir, id, &[2], "audio/wav").unwrap();
    assert_eq!(read_debug_audio_in(&audio_dir, id).unwrap().0, vec![2]);
    fs::remove_file(&clip).unwrap();
    let error = read_debug_audio_in(&audio_dir, id).unwrap_err();
    assert_eq!(error.downcast_ref::<std::io::Error>().unwrap().kind(), std::io::ErrorKind::NotFound);
    assert!(refresh_pending_failure_in(&path, id, "missing", "missing", false).unwrap());
    let entry = read_history_entry_in(&path, id).unwrap().unwrap();
    assert_eq!(entry["pending"], false);
    assert!(entry["audioId"].is_null());
    assert!(entry["audioMime"].is_null());
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
