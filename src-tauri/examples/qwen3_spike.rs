// Spike: sherpa-onnx + Qwen3-ASR-0.6B int8. Usage:
//   cargo run --release --example qwen3_spike -- <model-dir> <wav-file> [max_new_tokens]
// Prints the transcription, load time, decode time, and RTF.
use std::time::Instant;

fn main() {
  let mut args = std::env::args().skip(1);
  let model_dir = std::path::PathBuf::from(args.next().expect("model dir"));
  let wav_path = args.next().expect("wav file");
  let max_new_tokens: i32 = args.next().map(|s| s.parse().unwrap()).unwrap_or(512);

  let mut config = sherpa_onnx::OfflineRecognizerConfig::default();
  config.model_config.qwen3_asr = sherpa_onnx::OfflineQwen3ASRModelConfig {
    conv_frontend: Some(model_dir.join("conv_frontend.onnx").to_string_lossy().into_owned()),
    encoder: Some(model_dir.join("encoder.int8.onnx").to_string_lossy().into_owned()),
    decoder: Some(model_dir.join("decoder.int8.onnx").to_string_lossy().into_owned()),
    tokenizer: Some(model_dir.join("tokenizer").to_string_lossy().into_owned()),
    max_total_len: 2048,
    max_new_tokens,
    ..Default::default()
  };
  config.model_config.tokens = Some(String::new());
  config.model_config.num_threads = 2;
  config.model_config.provider = Some("cpu".into());

  let t0 = Instant::now();
  let recognizer = sherpa_onnx::OfflineRecognizer::create(&config).expect("load model");
  println!("load: {:?}", t0.elapsed());

  let mut reader = hound::WavReader::open(&wav_path).expect("open wav");
  let spec = reader.spec();
  let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
  let samples: Vec<f32> = reader.samples::<i32>().map(|s| s.unwrap() as f32 / max).collect();
  let audio_secs = samples.len() as f32 / spec.sample_rate as f32;

  let t1 = Instant::now();
  let stream = recognizer.create_stream();
  stream.accept_waveform(spec.sample_rate as i32, &samples);
  recognizer.decode(&stream);
  let result = stream.get_result().expect("result");
  let decode = t1.elapsed();
  println!("text: {}", result.text);
  println!("audio {audio_secs:.1}s, decode {decode:?}, RTF {:.3}", decode.as_secs_f32() / audio_secs);
}
