//! How fast the local Qwen models decode on this machine, measured from real
//! dictations. Settings uses it to suggest the 1.7B model where it would still
//! feel quick, instead of guessing from the chip name. Only timings are kept:
//! decode time per second of audio, never audio or text.

use serde::Serialize;
use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Samples kept per model. A new runtime (a GPU pack, a new machine) replaces
/// the old picture within this many dictations.
const SAMPLE_LIMIT: usize = 20;
/// Shorter clips are dominated by fixed per-request overhead, which says
/// little about how a longer dictation would go.
const MIN_AUDIO_MS: u64 = 2_000;
/// 16 kHz mono PCM16 after the 44-byte RIFF header.
const WAV_HEADER_BYTES: usize = 44;
const WAV_BYTES_PER_MS: usize = 32;
const FILE_NAME: &str = "local-speed.json";

static SAMPLES: Mutex<Option<BTreeMap<String, VecDeque<f64>>>> = Mutex::new(None);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpeed {
  pub samples: usize,
  /// Median decode seconds per second of audio.
  pub median_rtf: f64,
}

/// Decode seconds per second of audio, or None for a clip too short to tell.
pub fn rtf_sample(wav_len: usize, decode_ms: u128) -> Option<f64> {
  let audio_ms = (wav_len.saturating_sub(WAV_HEADER_BYTES) / WAV_BYTES_PER_MS) as u64;
  if audio_ms < MIN_AUDIO_MS {
    return None;
  }
  Some(decode_ms as f64 / audio_ms as f64)
}

fn median(values: &VecDeque<f64>) -> Option<f64> {
  let mut sorted: Vec<f64> = values.iter().copied().filter(|value| value.is_finite()).collect();
  if sorted.is_empty() {
    return None;
  }
  sorted.sort_by(f64::total_cmp);
  let middle = sorted.len() / 2;
  Some(if sorted.len() % 2 == 0 { (sorted[middle - 1] + sorted[middle]) / 2.0 } else { sorted[middle] })
}

fn summarize(samples: &BTreeMap<String, VecDeque<f64>>) -> BTreeMap<String, ModelSpeed> {
  samples
    .iter()
    .filter_map(|(model, values)| {
      median(values).map(|median_rtf| (model.clone(), ModelSpeed { samples: values.len(), median_rtf }))
    })
    .collect()
}

fn push_sample(samples: &mut BTreeMap<String, VecDeque<f64>>, model: &str, rtf: f64) {
  let values = samples.entry(model.to_owned()).or_default();
  values.push_back(rtf);
  while values.len() > SAMPLE_LIMIT {
    values.pop_front();
  }
}

fn store_path() -> Option<PathBuf> {
  crate::settings::app_data_dir().ok().map(|dir| dir.join(FILE_NAME))
}

fn load_from(path: &Path) -> BTreeMap<String, VecDeque<f64>> {
  std::fs::read_to_string(path)
    .ok()
    .and_then(|text| serde_json::from_str::<BTreeMap<String, VecDeque<f64>>>(&text).ok())
    .unwrap_or_default()
}

fn with_samples<T>(action: impl FnOnce(&mut BTreeMap<String, VecDeque<f64>>) -> T) -> T {
  let mut guard = SAMPLES.lock().unwrap();
  let samples = guard.get_or_insert_with(|| store_path().map(|path| load_from(&path)).unwrap_or_default());
  action(samples)
}

/// Record one successful decode. A lost write only costs a sample.
pub fn record(model: &str, wav_len: usize, decode_ms: u128) {
  let Some(rtf) = rtf_sample(wav_len, decode_ms) else { return };
  let text = with_samples(|samples| {
    push_sample(samples, model, rtf);
    serde_json::to_string(samples).ok()
  });
  if let (Some(path), Some(text)) = (store_path(), text) {
    if let Err(error) = crate::settings::atomic_write(&path, &text) {
      log::warn!("local-speed: could not save samples: {error:#}");
    }
  }
}

pub fn summary() -> BTreeMap<String, ModelSpeed> {
  with_samples(|samples| summarize(samples))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn wav_len_for_ms(ms: usize) -> usize {
    WAV_HEADER_BYTES + ms * WAV_BYTES_PER_MS
  }

  #[test]
  fn short_clips_are_not_samples() {
    assert_eq!(rtf_sample(wav_len_for_ms(1_999), 100), None);
    assert_eq!(rtf_sample(10, 100), None);
    assert_eq!(rtf_sample(wav_len_for_ms(10_000), 310), Some(0.031));
  }

  #[test]
  fn keeps_the_latest_samples_and_reports_their_median() {
    let mut samples = BTreeMap::new();
    for index in 0..(SAMPLE_LIMIT + 5) {
      push_sample(&mut samples, "small", if index < 5 { 9.0 } else { 0.05 });
    }
    push_sample(&mut samples, "large", 0.1);
    push_sample(&mut samples, "large", 0.3);
    let summary = summarize(&samples);
    assert_eq!(summary["small"], ModelSpeed { samples: SAMPLE_LIMIT, median_rtf: 0.05 });
    assert!((summary["large"].median_rtf - 0.2).abs() < 1e-9);
  }

  #[test]
  fn a_missing_or_corrupt_store_starts_empty() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join(FILE_NAME);
    assert!(load_from(&path).is_empty());
    std::fs::write(&path, "not json").unwrap();
    assert!(load_from(&path).is_empty());
    std::fs::write(&path, r#"{"small":[0.03,0.04]}"#).unwrap();
    assert_eq!(load_from(&path)["small"].len(), 2);
  }
}
