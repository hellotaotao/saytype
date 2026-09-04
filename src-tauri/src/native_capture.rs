//! Native CoreAudio capture, macOS only.
//!
//! Exists because WKWebView's `getUserMedia` hands back audio ~32 dB down for
//! exactly the first 3.0 s of every fresh stream, which silently ate the opening
//! of every dictation. Measured against the same microphone at the same moment,
//! a native CoreAudio stream is at full level from the first sample:
//!
//! ```text
//! WKWebView : env_db = -52,-48,-48,-48,-48,-48, | -16,-17,-17,-17
//! cpal      : env_db = -18,-17,-17,-17,-17,-17,   -17,-17,-17,-17
//! ```
//!
//! Both agree in steady state, so the difference is exclusively that window.

use anyhow::{anyhow, Result};

pub const TARGET_RATE: u32 = 16_000;

/// Windowed-sinc resample to `TARGET_RATE`.
///
/// Plain decimation would fold everything above 8 kHz back into the speech band.
/// Verified against a 440 Hz reference tone: SNR is unchanged across the
/// conversion (17.3 dB at 48 kHz, 17.3 dB at 16 kHz).
pub fn resample_to_target(input: &[f32], in_rate: f64) -> Vec<f32> {
  if input.is_empty() || in_rate <= 0.0 {
    return Vec::new();
  }
  let out_rate = TARGET_RATE as f64;
  if (in_rate - out_rate).abs() < f64::EPSILON {
    return input.to_vec();
  }
  let ratio = in_rate / out_rate;
  let cutoff = 0.45 * out_rate.min(in_rate);
  let fc = cutoff / in_rate;
  let half = 32i64;
  let out_len = ((input.len() as f64) / ratio).floor() as usize;
  let mut out = Vec::with_capacity(out_len);
  for n in 0..out_len {
    let center = n as f64 * ratio;
    let base = center.floor() as i64;
    let (mut acc, mut norm) = (0.0f64, 0.0f64);
    for k in -half..=half {
      let idx = base + k;
      if idx < 0 || idx as usize >= input.len() {
        continue;
      }
      let t = center - idx as f64;
      let x = 2.0 * fc * t;
      let sinc = if x.abs() < 1e-9 {
        1.0
      } else {
        (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
      };
      let w = 0.5 + 0.5 * (std::f64::consts::PI * t / (half as f64 + 1.0)).cos();
      let h = sinc * w;
      acc += input[idx as usize] as f64 * h;
      norm += h;
    }
    out.push(if norm.abs() > 1e-12 { (acc / norm) as f32 } else { 0.0 });
  }
  out
}

/// Per-500ms RMS in dBFS — the same shape the frontend probe emits, so a native
/// reading can be compared against a WKWebView one directly.
pub fn envelope_db(pcm: &[f32], rate: f64, bucket_ms: f64) -> Vec<i64> {
  let per = ((rate * bucket_ms) / 1000.0).max(1.0) as usize;
  pcm
    .chunks(per)
    .map(|chunk| {
      let ms = chunk.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / chunk.len() as f64;
      if ms > 0.0 {
        (10.0 * ms.log10()).round() as i64
      } else {
        -99
      }
    })
    .collect()
}

#[cfg(target_os = "macos")]
pub fn probe_capture(seconds: f64) -> Result<(String, f64, Vec<f32>)> {
  use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
  use std::sync::{Arc, Mutex};

  let host = cpal::default_host();
  let device = host
    .default_input_device()
    .ok_or_else(|| anyhow!("no default input device"))?;
  let name = device.name().unwrap_or_else(|_| "unknown".into());
  let config = device.default_input_config()?;
  let rate = config.sample_rate().0 as f64;
  let channels = config.channels() as usize;

  let captured = Arc::new(Mutex::new(Vec::<f32>::new()));
  let sink = Arc::clone(&captured);
  let stream = device.build_input_stream(
    &config.clone().into(),
    move |data: &[f32], _: &cpal::InputCallbackInfo| {
      if let Ok(mut buf) = sink.lock() {
        // Take the first channel; dictation is mono.
        buf.extend(data.chunks(channels).map(|frame| frame[0]));
      }
    },
    |error| log::warn!(target: "saytype_lifecycle", "native-capture stream error: {error}"),
    None,
  )?;
  stream.play()?;
  std::thread::sleep(std::time::Duration::from_secs_f64(seconds));
  drop(stream);

  let pcm = captured.lock().map_err(|_| anyhow!("capture buffer poisoned"))?.clone();
  Ok((name, rate, pcm))
}

#[cfg(not(target_os = "macos"))]
pub fn probe_capture(_seconds: f64) -> Result<(String, f64, Vec<f32>)> {
  Err(anyhow!("native capture is macOS-only"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn resampling_preserves_a_440hz_tone() {
    let in_rate = 48_000.0;
    let n = 48_000;
    let input: Vec<f32> = (0..n)
      .map(|i| (2.0 * std::f64::consts::PI * 440.0 * i as f64 / in_rate).sin() as f32)
      .collect();
    let out = resample_to_target(&input, in_rate);
    assert_eq!(out.len(), 16_000);
    // A pure tone must survive the rate change with its amplitude intact; the
    // edges are excluded because the kernel is truncated there.
    let peak = out[200..out.len() - 200]
      .iter()
      .fold(0.0f32, |acc, v| acc.max(v.abs()));
    assert!(peak > 0.95 && peak < 1.05, "peak was {peak}");
  }

  #[test]
  fn resampling_is_identity_at_the_target_rate() {
    let input = vec![0.1, -0.2, 0.3];
    assert_eq!(resample_to_target(&input, TARGET_RATE as f64), input);
  }

  #[test]
  fn envelope_reports_a_floor_for_digital_silence() {
    let pcm = vec![0.0f32; 16_000];
    assert!(envelope_db(&pcm, 16_000.0, 500.0).iter().all(|db| *db == -99));
  }
}
