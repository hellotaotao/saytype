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

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use tauri::ipc::{Channel, InvokeResponseBody};

pub const TARGET_RATE: u32 = 16_000;
const RESAMPLE_HALF_WINDOW: i64 = 32;
const CHANNEL_BLOCK_SAMPLES: usize = 640; // 40 ms at 16 kHz

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCaptureInfo {
  pub session_id: u64,
  pub device: String,
  pub input_rate: u32,
  pub output_rate: u32,
  pub channels: u16,
  pub sample_format: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCaptureStats {
  pub session_id: u64,
  pub input_samples: u64,
  pub output_samples: u64,
  pub peak: f32,
  pub clipped_samples: u64,
  pub channel_send_failures: u64,
}

enum CaptureControl {
  Stop,
  Error(String),
}

struct CaptureHandle {
  session_id: u64,
  control: mpsc::Sender<CaptureControl>,
  thread: JoinHandle<Result<NativeCaptureStats>>,
}

/// One native input stream at a time. Transcription may overlap, but the UI
/// intentionally permits only one active recording, so a second stream would
/// mean a stale session leaked rather than legitimate concurrency.
#[derive(Clone, Default)]
pub struct NativeCaptureState {
  active: Arc<Mutex<Option<CaptureHandle>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureChannelEvent<'a> {
  event: &'a str,
  #[serde(skip_serializing_if = "Option::is_none")]
  message: Option<&'a str>,
  #[serde(skip_serializing_if = "Option::is_none")]
  stats: Option<&'a NativeCaptureStats>,
}

fn send_channel_event(
  channel: &Channel<InvokeResponseBody>,
  event: &str,
  message: Option<&str>,
  stats: Option<&NativeCaptureStats>,
) {
  let payload = CaptureChannelEvent {
    event,
    message,
    stats,
  };
  if let Ok(json) = serde_json::to_string(&payload) {
    let _ = channel.send(InvokeResponseBody::Json(json));
  }
}

/// Streaming counterpart of `resample_to_target`. It waits for the right half
/// of the sinc window before emitting a sample, carries the window across CPAL
/// callbacks, and only retains the small amount of input still needed by a
/// future output sample.
struct StreamingResampler {
  input_rate: f64,
  ratio: f64,
  cutoff: f64,
  input: VecDeque<f32>,
  base_index: i64,
  received: i64,
  next_output: u64,
}

impl StreamingResampler {
  fn new(input_rate: f64) -> Self {
    let output_rate = TARGET_RATE as f64;
    Self {
      input_rate,
      ratio: input_rate / output_rate,
      cutoff: 0.45 * output_rate.min(input_rate) / input_rate,
      input: VecDeque::new(),
      base_index: 0,
      received: 0,
      next_output: 0,
    }
  }

  fn push(&mut self, samples: &[f32]) -> Vec<f32> {
    if (self.input_rate - TARGET_RATE as f64).abs() < f64::EPSILON {
      return samples.to_vec();
    }
    self.input.extend(samples.iter().copied());
    self.received += samples.len() as i64;
    self.render(false)
  }

  fn finish(&mut self) -> Vec<f32> {
    if (self.input_rate - TARGET_RATE as f64).abs() < f64::EPSILON {
      return Vec::new();
    }
    self.render(true)
  }

  fn render(&mut self, final_block: bool) -> Vec<f32> {
    if self.input_rate <= 0.0 {
      return Vec::new();
    }
    let final_length = ((self.received as f64) / self.ratio).floor() as u64;
    let mut output = Vec::new();
    loop {
      if final_block && self.next_output >= final_length {
        break;
      }
      let center = self.next_output as f64 * self.ratio;
      let center_index = center.floor() as i64;
      if !final_block && center_index + RESAMPLE_HALF_WINDOW >= self.received {
        break;
      }

      let mut acc = 0.0f64;
      let mut norm = 0.0f64;
      for offset in -RESAMPLE_HALF_WINDOW..=RESAMPLE_HALF_WINDOW {
        let index = center_index + offset;
        if index < 0 || index >= self.received || index < self.base_index {
          continue;
        }
        let local_index = (index - self.base_index) as usize;
        let Some(sample) = self.input.get(local_index) else {
          continue;
        };
        let distance = center - index as f64;
        let x = 2.0 * self.cutoff * distance;
        let sinc = if x.abs() < 1e-9 {
          1.0
        } else {
          (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
        };
        let window = 0.5
          + 0.5
            * (std::f64::consts::PI * distance / (RESAMPLE_HALF_WINDOW as f64 + 1.0))
              .cos();
        let weight = sinc * window;
        acc += *sample as f64 * weight;
        norm += weight;
      }
      output.push(if norm.abs() > 1e-12 {
        (acc / norm) as f32
      } else {
        0.0
      });
      self.next_output += 1;

      let next_center = (self.next_output as f64 * self.ratio).floor() as i64;
      let retain_from = (next_center - RESAMPLE_HALF_WINDOW - 1).max(0);
      while self.base_index < retain_from && !self.input.is_empty() {
        self.input.pop_front();
        self.base_index += 1;
      }
    }
    output
  }
}

fn pcm16_bytes(samples: &[i16]) -> Vec<u8> {
  let mut bytes = Vec::with_capacity(samples.len() * 2);
  for sample in samples {
    bytes.extend_from_slice(&sample.to_le_bytes());
  }
  bytes
}

fn capture_processor(
  session_id: u64,
  input_rate: f64,
  samples: mpsc::Receiver<Vec<f32>>,
  channel: Channel<InvokeResponseBody>,
) -> NativeCaptureStats {
  let mut resampler = StreamingResampler::new(input_rate);
  let mut pending = Vec::<i16>::with_capacity(CHANNEL_BLOCK_SAMPLES * 2);
  let mut stats = NativeCaptureStats {
    session_id,
    ..NativeCaptureStats::default()
  };

  let consume = |block: &[f32], pending: &mut Vec<i16>, stats: &mut NativeCaptureStats| {
    for sample in block {
      stats.peak = stats.peak.max(sample.abs());
      if sample.abs() > 1.0 {
        stats.clipped_samples += 1;
      }
      let clamped = sample.clamp(-1.0, 1.0);
      pending.push(if clamped < 0.0 {
        (clamped * 32768.0).round() as i16
      } else {
        (clamped * 32767.0).round() as i16
      });
    }
  };

  for block in samples {
    stats.input_samples += block.len() as u64;
    let output = resampler.push(&block);
    stats.output_samples += output.len() as u64;
    consume(&output, &mut pending, &mut stats);
    while pending.len() >= CHANNEL_BLOCK_SAMPLES {
      let remainder = pending.split_off(CHANNEL_BLOCK_SAMPLES);
      let bytes = pcm16_bytes(&pending);
      if channel.send(InvokeResponseBody::Raw(bytes)).is_err() {
        stats.channel_send_failures += 1;
      }
      pending = remainder;
    }
  }

  let tail = resampler.finish();
  stats.output_samples += tail.len() as u64;
  consume(&tail, &mut pending, &mut stats);
  if !pending.is_empty()
    && channel
      .send(InvokeResponseBody::Raw(pcm16_bytes(&pending)))
      .is_err()
  {
    stats.channel_send_failures += 1;
  }
  send_channel_event(&channel, "stopped", None, Some(&stats));
  stats
}

#[cfg(target_os = "macos")]
fn build_input_stream<T>(
  device: &cpal::Device,
  config: &cpal::StreamConfig,
  channels: usize,
  samples: mpsc::Sender<Vec<f32>>,
  control: mpsc::Sender<CaptureControl>,
) -> Result<cpal::Stream>
where
  T: cpal::Sample + cpal::SizedSample + Copy,
  f32: cpal::FromSample<T>,
{
  use cpal::traits::DeviceTrait;

  let sample_sender = samples.clone();
  let error_control = control.clone();
  device
    .build_input_stream(
      config,
      move |data: &[T], _: &cpal::InputCallbackInfo| {
        let mono = data
          .chunks(channels)
          .filter_map(|frame| frame.first().copied())
          .map(<f32 as cpal::Sample>::from_sample)
          .collect::<Vec<_>>();
        if !mono.is_empty() {
          let _ = sample_sender.send(mono);
        }
      },
      move |error| {
        let _ = error_control.send(CaptureControl::Error(error.to_string()));
      },
      None,
    )
    .context("failed to build native input stream")
}

#[cfg(target_os = "macos")]
fn select_input_device(preferred: &str) -> Result<cpal::Device> {
  use cpal::traits::{DeviceTrait, HostTrait};

  let host = cpal::default_host();
  if preferred.trim().is_empty() || preferred == "default" {
    return host
      .default_input_device()
      .ok_or_else(|| anyhow!("no default input device"));
  }

  host
    .input_devices()
    .context("failed to enumerate input devices")?
    .find(|device| device.name().map(|name| name == preferred).unwrap_or(false))
    .ok_or_else(|| anyhow!("configured input device is unavailable: {preferred}"))
}

#[cfg(target_os = "macos")]
fn capture_thread(
  session_id: u64,
  preferred_device: String,
  channel: Channel<InvokeResponseBody>,
  control_tx: mpsc::Sender<CaptureControl>,
  control_rx: mpsc::Receiver<CaptureControl>,
  ready: mpsc::SyncSender<Result<NativeCaptureInfo, String>>,
) -> Result<NativeCaptureStats> {
  use cpal::traits::{DeviceTrait, StreamTrait};

  let setup = (|| -> Result<(cpal::Stream, NativeCaptureInfo, mpsc::Sender<Vec<f32>>, JoinHandle<NativeCaptureStats>)> {
    let device = select_input_device(&preferred_device)?;
    let device_name = device.name().unwrap_or_else(|_| "unknown".into());
    let supported = device
      .default_input_config()
      .context("failed to read the native input format")?;
    let input_rate = supported.sample_rate().0;
    let channels = supported.channels();
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let (sample_tx, sample_rx) = mpsc::channel::<Vec<f32>>();
    let processor_channel = channel.clone();
    let processor = std::thread::Builder::new()
      .name("saytype-audio-resampler".into())
      .spawn(move || capture_processor(session_id, input_rate as f64, sample_rx, processor_channel))
      .context("failed to start the native audio resampler")?;

    macro_rules! stream_for {
      ($sample:ty) => {
        build_input_stream::<$sample>(
          &device,
          &config,
          channels as usize,
          sample_tx.clone(),
          control_tx.clone(),
        )
      };
    }
    let stream = match sample_format {
      cpal::SampleFormat::I8 => stream_for!(i8),
      cpal::SampleFormat::I16 => stream_for!(i16),
      cpal::SampleFormat::I32 => stream_for!(i32),
      cpal::SampleFormat::I64 => stream_for!(i64),
      cpal::SampleFormat::U8 => stream_for!(u8),
      cpal::SampleFormat::U16 => stream_for!(u16),
      cpal::SampleFormat::U32 => stream_for!(u32),
      cpal::SampleFormat::U64 => stream_for!(u64),
      cpal::SampleFormat::F32 => stream_for!(f32),
      cpal::SampleFormat::F64 => stream_for!(f64),
      other => Err(anyhow!("unsupported native input sample format: {other}")),
    }?;
    stream.play().context("failed to start native input capture")?;

    Ok((
      stream,
      NativeCaptureInfo {
        session_id,
        device: device_name,
        input_rate,
        output_rate: TARGET_RATE,
        channels,
        sample_format: sample_format.to_string(),
      },
      sample_tx,
      processor,
    ))
  })();

  let (stream, info, sample_tx, processor) = match setup {
    Ok(parts) => parts,
    Err(error) => {
      let message = format!("{error:#}");
      let _ = ready.send(Err(message.clone()));
      return Err(anyhow!(message));
    }
  };
  let _ = ready.send(Ok(info));

  if let Ok(CaptureControl::Error(message)) = control_rx.recv() {
    log::warn!(
      target: "saytype_lifecycle",
      "native-capture stream error session_id={session_id}: {message}"
    );
    send_channel_event(&channel, "error", Some(&message), None);
  }
  drop(stream);
  drop(sample_tx);
  processor
    .join()
    .map_err(|_| anyhow!("native audio resampler thread panicked"))
}

#[cfg(target_os = "macos")]
pub fn start_capture(
  state: &NativeCaptureState,
  session_id: u64,
  preferred_device: String,
  channel: Channel<InvokeResponseBody>,
) -> Result<NativeCaptureInfo> {
  let mut active = state.active.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  if let Some(existing) = active.as_ref() {
    return Err(anyhow!(
      "native capture session {} is still active",
      existing.session_id
    ));
  }

  let (control_tx, control_rx) = mpsc::channel();
  let (ready_tx, ready_rx) = mpsc::sync_channel(1);
  let thread_control = control_tx.clone();
  let thread = std::thread::Builder::new()
    .name("saytype-native-capture".into())
    .spawn(move || {
      capture_thread(
        session_id,
        preferred_device,
        channel,
        thread_control,
        control_rx,
        ready_tx,
      )
    })
    .context("failed to start native capture thread")?;

  match ready_rx.recv_timeout(std::time::Duration::from_secs(10)) {
    Ok(Ok(info)) => {
      *active = Some(CaptureHandle {
        session_id,
        control: control_tx,
        thread,
      });
      Ok(info)
    }
    Ok(Err(message)) => {
      let _ = thread.join();
      Err(anyhow!(message))
    }
    Err(_) => {
      let _ = control_tx.send(CaptureControl::Stop);
      let _ = thread.join();
      Err(anyhow!("native capture startup timed out"))
    }
  }
}

#[cfg(not(target_os = "macos"))]
pub fn start_capture(
  _state: &NativeCaptureState,
  _session_id: u64,
  _preferred_device: String,
  _channel: Channel<InvokeResponseBody>,
) -> Result<NativeCaptureInfo> {
  Err(anyhow!("native capture is macOS-only"))
}

pub fn stop_capture(state: &NativeCaptureState, session_id: u64) -> Result<NativeCaptureStats> {
  let handle = {
    let mut active = state.active.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(current) = active.as_ref() else {
      return Err(anyhow!("no native capture session is active"));
    };
    if current.session_id != session_id {
      return Err(anyhow!(
        "native capture session {} is active, not {session_id}",
        current.session_id
      ));
    }
    active.take().expect("active capture disappeared while locked")
  };

  let _ = handle.control.send(CaptureControl::Stop);
  handle
    .thread
    .join()
    .map_err(|_| anyhow!("native capture thread panicked"))?
}

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

  #[test]
  fn streaming_resampler_matches_the_batch_result_across_callback_boundaries() {
    let rate = 48_000.0;
    let input = (0..48_137)
      .map(|index| {
        let time = index as f64 / rate;
        (0.7 * (2.0 * std::f64::consts::PI * 440.0 * time).sin()
          + 0.2 * (2.0 * std::f64::consts::PI * 3_100.0 * time).sin()) as f32
      })
      .collect::<Vec<_>>();
    let expected = resample_to_target(&input, rate);
    let mut streaming = StreamingResampler::new(rate);
    let mut actual = Vec::new();
    for chunk in input.chunks(317) {
      actual.extend(streaming.push(chunk));
    }
    actual.extend(streaming.finish());

    assert_eq!(actual.len(), expected.len());
    let largest_error = actual
      .iter()
      .zip(expected.iter())
      .map(|(left, right)| (left - right).abs())
      .fold(0.0f32, f32::max);
    assert!(largest_error < 1e-5, "largest sample error was {largest_error}");
  }

  #[test]
  fn streaming_resampler_is_identity_at_the_target_rate() {
    let input = vec![0.1, -0.2, 0.3];
    let mut streaming = StreamingResampler::new(TARGET_RATE as f64);
    assert_eq!(streaming.push(&input), input);
    assert!(streaming.finish().is_empty());
  }

  #[test]
  fn pcm16_channel_bytes_are_little_endian() {
    assert_eq!(pcm16_bytes(&[0x1234, -2]), vec![0x34, 0x12, 0xfe, 0xff]);
  }
}
