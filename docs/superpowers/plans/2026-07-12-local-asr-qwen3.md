# 本地 Qwen3-ASR 转写后端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 SayType 加第三个转写 provider `"local"`:sherpa-onnx 进程内跑 Qwen3-ASR-0.6B int8,模型按需下载,录音开始时预加载、闲置 10 分钟卸载。

**Architecture:** 新模块 `src-tauri/src/local_asr.rs` 承载模型清单/下载/专属 worker 线程(加载-转写-闲时卸载);`commands.rs` 的 `transcribe_audio` 增加路由层(local / cloud);前端在 local 模式下恒发 16k mono WAV;settings 窗新增本地模型面板。下游 scrub/历史/插入管线零改动。

**Tech Stack:** Rust (Tauri 2), `sherpa-onnx = "1.13.4"`(官方 crate,default `static` feature,build.rs 自动下载预编译静态库,**无 cmake**), `hound`(WAV 解析), `sha2`(校验), reqwest(已有,流式下载), 前端 plain JS。

**Spec:** `docs/superpowers/specs/2026-07-12-local-asr-qwen3-design.md`(已含 2026-07-12 调研定案:crate 选型、模型文件清单与字节数、镜像 URL、线程安全模型)。

## Global Constraints

- Rust 代码 2 空格缩进(仓库既有风格);错误消息用英文(与现有 `commands.rs` 一致);**日志绝不含转写文本/API key**(只记计数/形状)。
- **新增 IPC 命令必须三处同步**:`commands.rs` 的 `#[tauri::command]`、`lib.rs` 的 `invoke_handler!`、`ipc-bridge.js` 的 `tauriCommands`(带参数的还要 `tauriArgs`)。
- 新 UI 文案一律进 `src/views/i18n.js`,**en + zh 两份**。
- provider 标识字符串:`"local"`;模型标识:`"qwen3-asr-0.6b-int8"`。
- 插入失败**无剪贴板回退**(既有设计,勿破坏);转写成功但历史写失败不许变成 Err(`b2dc1a6` 教训)。
- 版本号**不在本计划内 bump**(发布时手动)。
- Solo 项目:直接提交 main,不做旧配置兼容层。
- `cargo test` 在 `src-tauri/` 下运行;Node 测试:`node src/views/vad-decision.test.mjs`。
- 每个任务结束全量跑一遍 `cargo test`(不只是新增的测试)。

## 模型事实速查(实现时直接引用,已核实)

| 文件(rel_path,同为两镜像的 URL 后缀) | 字节数 |
|---|---|
| `conv_frontend.onnx` | 44,148,281 |
| `encoder.int8.onnx` | 182,491,662 |
| `decoder.int8.onnx` | 755,914,231 |
| `tokenizer/merges.txt` | ~1.6 MiB(精确值 Task 2 核实) |
| `tokenizer/vocab.json` | ~2.6 MiB(精确值 Task 2 核实) |
| `tokenizer/tokenizer_config.json` | ~12 KiB(精确值 Task 2 核实) |

- 主源(国内):`https://modelscope.cn/models/zengshuishui/Qwen3-ASR-onnx/resolve/master/model_0.6B/` + rel_path
- 备源:`https://huggingface.co/csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/main/` + rel_path
- 两镜像文件**逐字节相同**(已核实 decoder/encoder 字节数一致),断点续传可跨源续。
- 存放:`app_data_dir()/models/qwen3-asr-0.6b-int8/<rel_path>`。

---

### Task 1: Spike — sherpa-onnx 跑通 Qwen3 + 真实音频质量对比(⛔ GATE)

**目的:** 花半天把两个不可逆风险排掉:① sherpa crate 的 Qwen3 路径在本机(Apple Silicon)真实可用、RTF/内存可接受;② int8 的中文准确率/标点让用户满意(相对 Groq large-v3-turbo)。**不达标 → 撤退到 llama.cpp sidecar 路线,本计划作废重写。**

**Files:**
- Modify: `src-tauri/Cargo.toml`(加依赖)
- Create: `src-tauri/examples/qwen3_spike.rs`

- [ ] **Step 1: 加依赖并确认能编译链接**

`src-tauri/Cargo.toml` 的 `[dependencies]` 追加:

```toml
sherpa-onnx = "1.13.4"
hound = "3.5"
sha2 = "0.10"
```

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 编译通过。首次构建 build.rs 会从 GitHub 下载 `sherpa-onnx-v1.13.4-osx-arm64-static-lib.tar.bz2`(~19.5MB);若网络不通,先手动下载后设 `SHERPA_ONNX_ARCHIVE_DIR=<目录>`。
记录:`ls -lh target/debug/examples/ 与主二进制体积`,对比增量。

- [ ] **Step 2: 手动下载模型(spike 用,与正式下载器无关)**

```bash
MODEL_DIR="$HOME/Library/Application Support/com.tao.saytype/models/qwen3-asr-0.6b-int8"
mkdir -p "$MODEL_DIR/tokenizer"
BASE="https://modelscope.cn/models/zengshuishui/Qwen3-ASR-onnx/resolve/master/model_0.6B"
for f in conv_frontend.onnx encoder.int8.onnx decoder.int8.onnx \
         tokenizer/merges.txt tokenizer/vocab.json tokenizer/tokenizer_config.json; do
  curl -L --fail -o "$MODEL_DIR/$f" "$BASE/$f"
done
ls -l "$MODEL_DIR" "$MODEL_DIR/tokenizer"
```
Expected: decoder.int8.onnx = 755,914,231 B;encoder = 182,491,662 B;conv_frontend = 44,148,281 B。**顺手记下 tokenizer 三个文件的精确字节数(Task 2 的清单常量要用)。**
若 ModelScope 某文件 404(tokenizer 路径可能有出入),用 `curl -sI` 探 `model_0.6B/tokenizer/<name>` 与 HF 备源,把实际可用路径记下来(Task 4 SOURCES 用)。

- [ ] **Step 3: 写 spike example**

`src-tauri/examples/qwen3_spike.rs`:

```rust
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
```
> 注:字段名/方法签名以 crate 1.13.4 实际 API 为准(调研确认过 `OfflineQwen3ASRModelConfig`/`create`/`create_stream`/`accept_waveform`/`decode`/`get_result` 的形态);编译报错就对着 `docs.rs/sherpa-onnx` 微调,**把最终能编译的形态记下来,Task 3 的 `load_sherpa_engine` 要按它写**。

- [ ] **Step 4: 跑真实音频对比**

素材:dev 构建的 `debug-audio` 目录里有真实听写留档(见 CLAUDE.md);不足就现录几条中文(短句 5–10s、长独白 60–90s、带停顿的对话式各一),用 `ffmpeg -i in.m4a -ar 16000 -ac 1 out.wav` 转 16k mono WAV。

```bash
cargo run --release --example qwen3_spike -- "$MODEL_DIR" test.wav
```
逐条记录并与 Groq(历史里的同源转写,或现调 API)对比:
1. 中文字准确率(肉眼);2. 标点密度(Qwen3 是否补标点——这是相对 Whisper lv3 的核心期望);3. RTF(目标 < 0.5,预期 ~0.1–0.2);4. 加载耗时(预期数秒);5. **60–90s 长句是否截尾**(不够就把 max_new_tokens 提到 1024 重试,记录定稿值);6. Activity Monitor 峰值/稳态内存。
另跑一条**纯静音/噪声 WAV**,记录输出(空?幻觉?)——决定要不要依赖 VAD 门保护。

- [ ] **Step 5: ⛔ GATE — 向用户汇报数据,拿 go/no-go**

汇报格式:准确率对比结论、标点表现、RTF/加载/内存实测、长句截尾结论 + 定稿的 max_new_tokens。**用户点头才继续 Task 2;否则停下讨论撤退。**

- [ ] **Step 6: Commit(spike 通过后)**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/examples/qwen3_spike.rs
git commit -m "spike: sherpa-onnx Qwen3-ASR-0.6B int8 runs locally, quality/RTF validated"
```

---

### Task 2: `local_asr.rs` 之一 — 模型清单/路径/就绪检查 + WAV 解码

**Files:**
- Create: `src-tauri/src/local_asr.rs`
- Modify: `src-tauri/src/lib.rs:1-8`(加 `mod local_asr;`)

**Interfaces (Produces):**
- `local_asr::LOCAL_PROVIDER: &str = "local"`、`LOCAL_MODEL_ID: &str = "qwen3-asr-0.6b-int8"`
- `local_asr::MODEL_FILES: &[ModelFile]`(`ModelFile { rel_path: &'static str, size: u64, sha256: &'static str }`)
- `local_asr::model_dir() -> anyhow::Result<PathBuf>`
- `local_asr::model_ready() -> bool` / `model_ready_at(dir: &Path) -> bool`
- `local_asr::total_download_bytes() -> u64`
- `local_asr::wav_to_samples(bytes: &[u8]) -> anyhow::Result<(Vec<f32>, u32)>`

- [ ] **Step 1: 取 6 个文件的精确 size + sha256**

```bash
curl -s "https://huggingface.co/api/models/csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/tree/main?recursive=true" \
  | python3 -c "import json,sys; [print(f['path'], f['size'], (f.get('lfs') or {}).get('oid','(no-lfs: sha via download)')) for f in json.load(sys.stdin) if f['type']=='file']"
```
把 6 个目标文件的 size/sha256 抄进 Step 2 的常量。非 LFS 小文件(tokenizer 的 json/txt 可能不走 LFS)没有现成 oid,就用 Task 1 已下载的本地文件算:`shasum -a 256 <file>`(本地文件来自 ModelScope,与 HF 逐字节相同已核实过大文件;小文件算完后可再 curl HF 原文件比对一次)。

- [ ] **Step 2: 写失败测试**

`src-tauri/src/local_asr.rs`(先只写清单/路径/WAV 部分与测试;worker 在 Task 3):

```rust
//! Local Qwen3-ASR backend: model manifest/download/lifecycle + inference worker.
//! The model lives under app_data_dir()/models/qwen3-asr-0.6b-int8/ and is
//! downloaded on demand (never bundled). See
//! docs/superpowers/specs/2026-07-12-local-asr-qwen3-design.md.
use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

pub const LOCAL_PROVIDER: &str = "local";
pub const LOCAL_MODEL_ID: &str = "qwen3-asr-0.6b-int8";

pub struct ModelFile {
  /// Path under model_dir(); ALSO the URL suffix on both mirrors. Forward
  /// slashes are fine in PathBuf::join on Windows too.
  pub rel_path: &'static str,
  pub size: u64,
  pub sha256: &'static str,
}

// Sizes/hashes verified against the HF repo (csukuangfj2/...) — see the plan's
// 模型事实速查. ModelScope serves byte-identical files.
pub const MODEL_FILES: &[ModelFile] = &[
  ModelFile { rel_path: "conv_frontend.onnx", size: 44_148_281, sha256: "<FILL-STEP-1>" },
  ModelFile { rel_path: "encoder.int8.onnx", size: 182_491_662, sha256: "<FILL-STEP-1>" },
  ModelFile { rel_path: "decoder.int8.onnx", size: 755_914_231, sha256: "<FILL-STEP-1>" },
  ModelFile { rel_path: "tokenizer/merges.txt", size: 0 /*FILL*/, sha256: "<FILL-STEP-1>" },
  ModelFile { rel_path: "tokenizer/vocab.json", size: 0 /*FILL*/, sha256: "<FILL-STEP-1>" },
  ModelFile { rel_path: "tokenizer/tokenizer_config.json", size: 0 /*FILL*/, sha256: "<FILL-STEP-1>" },
];

pub fn total_download_bytes() -> u64 {
  MODEL_FILES.iter().map(|f| f.size).sum()
}

pub fn model_dir() -> Result<PathBuf> {
  Ok(crate::settings::app_data_dir()?.join("models").join(LOCAL_MODEL_ID))
}

/// Cheap readiness check: every file exists with the exact expected size.
/// (sha256 is verified once at download time, not on every check — hashing
/// ~1GB per settings read would be absurd.)
pub fn model_ready_at(dir: &Path) -> bool {
  MODEL_FILES.iter().all(|f| {
    fs::metadata(dir.join(f.rel_path)).map(|m| m.len() == f.size).unwrap_or(false)
  })
}

pub fn model_ready() -> bool {
  model_dir().map(|dir| model_ready_at(&dir)).unwrap_or(false)
}

/// Decode a (mono) WAV upload into f32 samples + sample rate for sherpa.
/// The frontend always sends 16k mono PCM16 WAV in local mode, but parse
/// generically: sherpa resamples internally, so only channel count is fatal.
pub fn wav_to_samples(bytes: &[u8]) -> Result<(Vec<f32>, u32)> {
  let mut reader =
    hound::WavReader::new(std::io::Cursor::new(bytes)).context("failed to parse WAV audio")?;
  let spec = reader.spec();
  if spec.channels != 1 {
    anyhow::bail!("local transcription expects mono WAV, got {} channels", spec.channels);
  }
  let samples: Vec<f32> = match spec.sample_format {
    hound::SampleFormat::Int => {
      let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
      reader
        .samples::<i32>()
        .map(|s| s.map(|v| v as f32 / max))
        .collect::<std::result::Result<_, _>>()
        .context("failed to read WAV samples")?
    }
    hound::SampleFormat::Float => reader
      .samples::<f32>()
      .collect::<std::result::Result<_, _>>()
      .context("failed to read WAV samples")?,
  };
  Ok((samples, spec.sample_rate))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn write_wav_pcm16(path: &Path, sample_rate: u32, samples: &[i16]) {
    let spec = hound::WavSpec {
      channels: 1,
      sample_rate,
      bits_per_sample: 16,
      sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    for s in samples {
      writer.write_sample(*s).unwrap();
    }
    writer.finalize().unwrap();
  }

  #[test]
  fn manifest_covers_the_six_model_files() {
    assert_eq!(MODEL_FILES.len(), 6);
    // ~983 MB download; a wildly-off total means a size constant is wrong.
    let total = total_download_bytes();
    assert!(total > 950_000_000 && total < 1_050_000_000, "total = {total}");
    for f in MODEL_FILES {
      assert_eq!(f.sha256.len(), 64, "{} sha256 must be filled in", f.rel_path);
    }
  }

  #[test]
  fn model_ready_requires_every_file_at_exact_size() {
    let temp = tempfile::TempDir::new().unwrap();
    let dir = temp.path();
    assert!(!model_ready_at(dir));
    // Right names, sizes via sparse set_len (fast, no real GB written).
    for f in MODEL_FILES {
      let path = dir.join(f.rel_path);
      fs::create_dir_all(path.parent().unwrap()).unwrap();
      let file = fs::File::create(&path).unwrap();
      file.set_len(f.size).unwrap();
    }
    assert!(model_ready_at(dir));
    // Truncate one file -> not ready.
    let victim = dir.join(MODEL_FILES[0].rel_path);
    fs::File::create(&victim).unwrap().set_len(1).unwrap();
    assert!(!model_ready_at(dir));
  }

  #[test]
  fn wav_roundtrips_16k_mono_pcm16() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("a.wav");
    write_wav_pcm16(&path, 16000, &[0, 16384, -16384, 32767]);
    let bytes = fs::read(&path).unwrap();
    let (samples, rate) = wav_to_samples(&bytes).unwrap();
    assert_eq!(rate, 16000);
    assert_eq!(samples.len(), 4);
    assert!((samples[1] - 0.5).abs() < 0.001);
    assert!((samples[2] + 0.5).abs() < 0.001);
  }

  #[test]
  fn wav_rejects_stereo_and_garbage() {
    let spec = hound::WavSpec {
      channels: 2,
      sample_rate: 16000,
      bits_per_sample: 16,
      sample_format: hound::SampleFormat::Int,
    };
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("stereo.wav");
    let mut writer = hound::WavWriter::create(&path, spec).unwrap();
    writer.write_sample(0i16).unwrap();
    writer.write_sample(0i16).unwrap();
    writer.finalize().unwrap();
    assert!(wav_to_samples(&fs::read(&path).unwrap()).is_err());
    assert!(wav_to_samples(b"not a wav").is_err());
  }
}
```

`lib.rs` 模块声明区(`mod hotkey;` 后)加一行:`mod local_asr;`

- [ ] **Step 3: 跑测试确认失败点**

Run: `cd src-tauri && cargo test local_asr 2>&1 | tail -20`
Expected: `manifest_covers_the_six_model_files` FAIL(sha256 是 `<FILL-STEP-1>` 占位、tokenizer size 是 0)——这是故意的:测试守住"常量必须填真值"。

- [ ] **Step 4: 填入 Step 1 抄来的真实 size/sha256,重跑**

Run: `cargo test local_asr`
Expected: 4 个测试全 PASS。

- [ ] **Step 5: 全量测试 + Commit**

Run: `cargo test 2>&1 | tail -3` → 全绿。

```bash
git add src-tauri/src/local_asr.rs src-tauri/src/lib.rs
git commit -m "feat(local-asr): model manifest, readiness check, WAV decode"
```

---

### Task 3: `local_asr.rs` 之二 — ASR worker 线程(加载/转写/闲时卸载)+ AppState 接线

**设计:** 一条专属 `std::thread` 独占持有 recognizer,`mpsc` 收消息:`Preload` / `Transcribe{samples, reply}` / `Unload`;`recv_timeout(60s)` 作为闲置心跳,10 分钟没活就 drop 掉模型(释放 ~1GB+)。队列天然串行化并发转写,也天然解决"预加载还没完成就来了转写"(FIFO:Preload 先处理完,Transcribe 排在后面)。引擎构造用注入的 loader 闭包,单测不需要真模型。

**Files:**
- Modify: `src-tauri/src/local_asr.rs`(追加 worker 部分)
- Modify: `src-tauri/src/state.rs`
- Test: 同文件 `#[cfg(test)]`

**Interfaces:**
- Consumes: Task 2 的 `model_dir()/model_ready()`
- Produces:
  - `#[derive(Clone)] pub struct AsrHandle`;`AsrHandle::preload(&self)`、`unload(&self)`、`transcribe_blocking(&self, samples: Vec<f32>, sample_rate: u32) -> Result<String, String>`(阻塞,调用方须包 `spawn_blocking`)
  - `local_asr::spawn_worker() -> AsrHandle`
  - `AppState.local_asr: AsrHandle`、`AppState.local_model_download: Mutex<Option<CancellationToken>>`
- 错误哨兵字符串:模型缺失时 loader 返回 `"LOCAL_MODEL_MISSING"` 开头的错误(Task 5 映射成用户可读提示)。

- [ ] **Step 1: 写失败测试**(追加到 `local_asr.rs` tests 模块)

```rust
  use std::sync::atomic::{AtomicUsize, Ordering};
  use std::sync::Arc;
  use std::time::Duration;

  /// Engine drop tracker: the closure captures it; when the worker unloads
  /// (drops the engine), drop_count increments.
  struct DropTracker(Arc<AtomicUsize>);
  impl Drop for DropTracker {
    fn drop(&mut self) {
      self.0.fetch_add(1, Ordering::SeqCst);
    }
  }

  fn fake_worker(
    loads: Arc<AtomicUsize>,
    drops: Arc<AtomicUsize>,
    idle_unload: Duration,
  ) -> AsrHandle {
    spawn_worker_with(
      Box::new(move |_| {
        loads.fetch_add(1, Ordering::SeqCst);
        let tracker = DropTracker(drops.clone());
        Ok(Box::new(move |samples: Vec<f32>, _rate: u32| {
          let _ = &tracker; // owned by the engine closure -> dropped on unload
          Ok(format!("ok:{}", samples.len()))
        }))
      }),
      idle_unload,
      Duration::from_millis(20), // idle poll
    )
  }

  #[test]
  fn transcribe_lazy_loads_once_and_reuses_the_engine() {
    let loads = Arc::new(AtomicUsize::new(0));
    let drops = Arc::new(AtomicUsize::new(0));
    let handle = fake_worker(loads.clone(), drops.clone(), Duration::from_secs(600));
    assert_eq!(handle.transcribe_blocking(vec![0.0; 3], 16000).unwrap(), "ok:3");
    assert_eq!(handle.transcribe_blocking(vec![0.0; 5], 16000).unwrap(), "ok:5");
    assert_eq!(loads.load(Ordering::SeqCst), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
  }

  #[test]
  fn preload_loads_eagerly() {
    let loads = Arc::new(AtomicUsize::new(0));
    let drops = Arc::new(AtomicUsize::new(0));
    let handle = fake_worker(loads.clone(), drops, Duration::from_secs(600));
    handle.preload();
    // preload is async (message); transcribe queues behind it.
    assert!(handle.transcribe_blocking(vec![], 16000).is_ok());
    assert_eq!(loads.load(Ordering::SeqCst), 1);
  }

  #[test]
  fn idle_unloads_the_engine_and_reloads_on_next_use() {
    let loads = Arc::new(AtomicUsize::new(0));
    let drops = Arc::new(AtomicUsize::new(0));
    let handle = fake_worker(loads.clone(), drops.clone(), Duration::from_millis(50));
    handle.transcribe_blocking(vec![], 16000).unwrap();
    // Wait past idle_unload + a few polls.
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(drops.load(Ordering::SeqCst), 1, "engine should be dropped after idle");
    handle.transcribe_blocking(vec![], 16000).unwrap();
    assert_eq!(loads.load(Ordering::SeqCst), 2, "next use reloads");
  }

  #[test]
  fn explicit_unload_drops_the_engine() {
    let loads = Arc::new(AtomicUsize::new(0));
    let drops = Arc::new(AtomicUsize::new(0));
    let handle = fake_worker(loads, drops.clone(), Duration::from_secs(600));
    handle.transcribe_blocking(vec![], 16000).unwrap();
    handle.unload();
    // Unload is a message; serialize behind it with another call.
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(drops.load(Ordering::SeqCst), 1);
  }

  #[test]
  fn loader_failure_propagates_and_next_call_retries() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let attempts2 = attempts.clone();
    let handle = spawn_worker_with(
      Box::new(move |_| {
        if attempts2.fetch_add(1, Ordering::SeqCst) == 0 {
          Err("LOCAL_MODEL_MISSING: no files".into())
        } else {
          Ok(Box::new(|_s: Vec<f32>, _r: u32| Ok("recovered".into())))
        }
      }),
      Duration::from_secs(600),
      Duration::from_millis(20),
    );
    let err = handle.transcribe_blocking(vec![], 16000).unwrap_err();
    assert!(err.starts_with("LOCAL_MODEL_MISSING"));
    assert_eq!(handle.transcribe_blocking(vec![], 16000).unwrap(), "recovered");
  }
```

Run: `cargo test local_asr 2>&1 | tail -20` → FAIL(`spawn_worker_with`/`AsrHandle` 未定义)。

- [ ] **Step 2: 实现 worker**(`local_asr.rs`,manifest 部分之后)

```rust
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How long a loaded model may sit unused before the worker drops it. The
/// model holds well over 1 GB resident — a tray app must not keep that
/// forever. Reload is seconds and is hidden by the record-start preload.
const IDLE_UNLOAD: Duration = Duration::from_secs(10 * 60);
const IDLE_POLL: Duration = Duration::from_secs(60);
const NUM_THREADS: i32 = 2;

/// A loaded engine: feed (samples, sample_rate), get text.
type Engine = Box<dyn FnMut(Vec<f32>, u32) -> Result<String, String> + Send>;
/// Builds an engine (loads the model). Injected so worker logic is testable
/// without the real ~1GB model. The u32 arg is unused (reserved: num threads).
type Loader = Box<dyn FnMut(u32) -> Result<Engine, String> + Send>;

enum AsrMsg {
  Preload,
  Transcribe { samples: Vec<f32>, sample_rate: u32, reply: mpsc::Sender<Result<String, String>> },
  Unload,
}

#[derive(Clone)]
pub struct AsrHandle {
  tx: mpsc::Sender<AsrMsg>,
}

impl AsrHandle {
  pub fn preload(&self) {
    let _ = self.tx.send(AsrMsg::Preload);
  }

  pub fn unload(&self) {
    let _ = self.tx.send(AsrMsg::Unload);
  }

  /// Blocking — callers on the async runtime must wrap in spawn_blocking.
  pub fn transcribe_blocking(&self, samples: Vec<f32>, sample_rate: u32) -> Result<String, String> {
    let (reply_tx, reply_rx) = mpsc::channel();
    self
      .tx
      .send(AsrMsg::Transcribe { samples, sample_rate, reply: reply_tx })
      .map_err(|_| "local ASR worker is not running".to_string())?;
    reply_rx.recv().map_err(|_| "local ASR worker dropped the request".to_string())?
  }
}

pub fn spawn_worker() -> AsrHandle {
  spawn_worker_with(Box::new(load_sherpa_engine), IDLE_UNLOAD, IDLE_POLL)
}

fn spawn_worker_with(mut loader: Loader, idle_unload: Duration, idle_poll: Duration) -> AsrHandle {
  let (tx, rx) = mpsc::channel::<AsrMsg>();
  std::thread::Builder::new()
    .name("local-asr".into())
    .spawn(move || {
      let mut engine: Option<Engine> = None;
      let mut last_used = Instant::now();
      loop {
        match rx.recv_timeout(idle_poll) {
          Ok(AsrMsg::Preload) => {
            if engine.is_none() {
              match loader(NUM_THREADS as u32) {
                Ok(built) => {
                  engine = Some(built);
                  last_used = Instant::now();
                }
                Err(err) => log::warn!("local ASR preload failed: {err}"),
              }
            }
          }
          Ok(AsrMsg::Transcribe { samples, sample_rate, reply }) => {
            if engine.is_none() {
              match loader(NUM_THREADS as u32) {
                Ok(built) => engine = Some(built),
                Err(err) => {
                  let _ = reply.send(Err(err));
                  continue;
                }
              }
            }
            let result = engine.as_mut().expect("engine loaded above")(samples, sample_rate);
            last_used = Instant::now();
            let _ = reply.send(result);
          }
          Ok(AsrMsg::Unload) => {
            if engine.take().is_some() {
              log::info!("local ASR: model unloaded (explicit)");
            }
          }
          Err(mpsc::RecvTimeoutError::Timeout) => {
            if engine.is_some() && last_used.elapsed() >= idle_unload {
              engine = None;
              log::info!("local ASR: model unloaded after {}s idle", idle_unload.as_secs());
            }
          }
          Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
      }
    })
    .expect("failed to spawn local-asr worker thread");
  AsrHandle { tx }
}

/// The real loader: builds a sherpa-onnx OfflineRecognizer from the on-disk
/// model. Shape confirmed by the Task-1 spike — if the spike recorded any API
/// deviation, mirror it here.
fn load_sherpa_engine(num_threads: u32) -> Result<Engine, String> {
  let dir = model_dir().map_err(|e| e.to_string())?;
  if !model_ready_at(&dir) {
    return Err("LOCAL_MODEL_MISSING: local model files are missing or incomplete".into());
  }
  let mut config = sherpa_onnx::OfflineRecognizerConfig::default();
  config.model_config.qwen3_asr = sherpa_onnx::OfflineQwen3ASRModelConfig {
    conv_frontend: Some(dir.join("conv_frontend.onnx").to_string_lossy().into_owned()),
    encoder: Some(dir.join("encoder.int8.onnx").to_string_lossy().into_owned()),
    decoder: Some(dir.join("decoder.int8.onnx").to_string_lossy().into_owned()),
    tokenizer: Some(dir.join("tokenizer").to_string_lossy().into_owned()),
    max_total_len: 2048,
    max_new_tokens: 512, // spike-validated for 60-90s dense Chinese dictation
    ..Default::default()
  };
  config.model_config.tokens = Some(String::new());
  config.model_config.num_threads = num_threads as i32;
  config.model_config.provider = Some("cpu".into());

  let started = Instant::now();
  let recognizer = sherpa_onnx::OfflineRecognizer::create(&config)
    .ok_or_else(|| "failed to load the local Qwen3-ASR model".to_string())?;
  log::info!("local ASR: model loaded in {:.1}s", started.elapsed().as_secs_f32());

  Ok(Box::new(move |samples: Vec<f32>, sample_rate: u32| {
    let started = Instant::now();
    let audio_secs = samples.len() as f32 / sample_rate.max(1) as f32;
    let stream = recognizer.create_stream();
    stream.accept_waveform(sample_rate as i32, &samples);
    recognizer.decode(&stream);
    let result = stream
      .get_result()
      .ok_or_else(|| "local ASR returned no result".to_string())?;
    // Counts only — no transcribed text in logs.
    log::info!(
      "local ASR: decoded {audio_secs:.1}s audio in {:.2}s ({} chars)",
      started.elapsed().as_secs_f32(),
      result.text.chars().count()
    );
    Ok(result.text.trim().to_string())
  }))
}
```

> `max_new_tokens: 512` 按 Task 1 Step 4 的定稿值调整。

- [ ] **Step 3: 跑测试**

Run: `cargo test local_asr 2>&1 | tail -15` → 新增 5 个测试全 PASS。

- [ ] **Step 4: AppState 接线**

`src-tauri/src/state.rs`:

```rust
use crate::hotkey::HotkeyHandle;
use crate::local_asr;
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub struct AppState {
  pub hotkey: Mutex<Option<HotkeyHandle>>,
  pub active_transcriptions: Mutex<HashMap<u64, CancellationToken>>,
  pub next_transcription_id: AtomicU64,
  pub accessibility: Mutex<Option<bool>>,
  /// Shared HTTP client for transcription requests. Reused across calls so we
  /// keep connection/TLS pooling instead of re-handshaking on every utterance,
  /// and carries the request timeouts so a hung network can't wedge the UI.
  pub http_client: reqwest::Client,
  /// Handle to the local-ASR worker thread (lazy model load; idle unload).
  /// The thread itself is spawned here but holds no model until used.
  pub local_asr: local_asr::AsrHandle,
  /// Cancellation token of the in-flight model download, if any (single-flight).
  pub local_model_download: Mutex<Option<CancellationToken>>,
}

impl Default for AppState {
  fn default() -> Self {
    Self {
      hotkey: Mutex::new(None),
      active_transcriptions: Mutex::new(HashMap::new()),
      next_transcription_id: AtomicU64::new(0),
      accessibility: Mutex::new(None),
      http_client: reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .expect("failed to build transcription HTTP client"),
      local_asr: local_asr::spawn_worker(),
      local_model_download: Mutex::new(None),
    }
  }
}
```

- [ ] **Step 5: 真模型冒烟测试(#[ignore],CI 不跑)**(追加到 tests)

```rust
  /// Needs the real model on disk (Task 1 Step 2) — run manually:
  ///   cargo test real_model_smoke -- --ignored --nocapture
  #[test]
  #[ignore]
  fn real_model_smoke() {
    assert!(model_ready(), "download the model first (see plan Task 1 Step 2)");
    let handle = spawn_worker();
    // 0.5s of silence: must not crash; empty-ish output is fine.
    let result = handle.transcribe_blocking(vec![0.0; 8000], 16000);
    assert!(result.is_ok(), "{result:?}");
  }
```

Run: `cargo test real_model_smoke -- --ignored --nocapture` → PASS(本机有模型时)。

- [ ] **Step 6: 全量测试 + Commit**

Run: `cargo test 2>&1 | tail -3` → 全绿。

```bash
git add src-tauri/src/local_asr.rs src-tauri/src/state.rs
git commit -m "feat(local-asr): dedicated worker thread with lazy load and 10min idle unload"
```

---

### Task 4: 模型下载器 + 4 个 IPC 命令 + 进度事件

**Files:**
- Modify: `src-tauri/src/local_asr.rs`(追加 download 部分)
- Modify: `src-tauri/src/commands.rs`(4 个新命令)
- Modify: `src-tauri/src/lib.rs:146-174`(invoke_handler 注册)
- Modify: `src/views/ipc-bridge.js:15-43`(tauriCommands)

**Interfaces:**
- Consumes: Task 2 `MODEL_FILES/model_dir/model_ready_at/total_download_bytes`;Task 3 `AppState.local_model_download`、`AsrHandle::unload`
- Produces:
  - `local_asr::ModelStatus { state: String, downloaded_bytes: u64, total_bytes: u64 }`(serde camelCase;state ∈ `"ready" | "downloading" | "partial" | "absent"`)
  - `local_asr::model_status(downloading: bool) -> ModelStatus`
  - `local_asr::download_model(app: AppHandle, cancel: CancellationToken) -> Result<(), String>`(Err `"DOWNLOAD_CANCELLED"` 表取消)
  - `local_asr::delete_model() -> Result<(), String>`
  - 命令:`download_local_model` / `cancel_local_model_download` / `get_local_model_status` / `delete_local_model`
  - 事件 `local-model-download-progress`,payload `{ state, downloadedBytes, totalBytes, message? }`,state ∈ `downloading | ready | cancelled | error`

- [ ] **Step 1: 写失败测试**(status 状态机 + URL 拼接,追加到 tests)

```rust
  #[test]
  fn model_status_reports_absent_partial_ready() {
    let temp = tempfile::TempDir::new().unwrap();
    let dir = temp.path();
    let s = model_status_at(dir, false);
    assert_eq!(s.state, "absent");
    assert_eq!(s.total_bytes, total_download_bytes());
    assert_eq!(s.downloaded_bytes, 0);

    // One finished file + one .part -> partial, bytes add up.
    let f0 = &MODEL_FILES[0];
    let p = dir.join(f0.rel_path);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::File::create(&p).unwrap().set_len(f0.size).unwrap();
    let part = dir.join(format!("{}.part", MODEL_FILES[1].rel_path));
    fs::create_dir_all(part.parent().unwrap()).unwrap();
    fs::File::create(&part).unwrap().set_len(1000).unwrap();
    let s = model_status_at(dir, false);
    assert_eq!(s.state, "partial");
    assert_eq!(s.downloaded_bytes, f0.size + 1000);

    // downloading flag wins over partial.
    assert_eq!(model_status_at(dir, true).state, "downloading");

    // All files at full size -> ready.
    for f in MODEL_FILES {
      let p = dir.join(f.rel_path);
      fs::create_dir_all(p.parent().unwrap()).unwrap();
      fs::File::create(&p).unwrap().set_len(f.size).unwrap();
    }
    assert_eq!(model_status_at(dir, false).state, "ready");
  }

  #[test]
  fn download_urls_join_source_and_rel_path() {
    let urls = file_urls(&MODEL_FILES[3]);
    assert_eq!(urls.len(), SOURCES.len());
    assert!(urls[0].starts_with("https://modelscope.cn/") && urls[0].ends_with("tokenizer/merges.txt"));
    assert!(urls[1].starts_with("https://huggingface.co/") && urls[1].ends_with("tokenizer/merges.txt"));
  }
```

Run: `cargo test local_asr 2>&1 | tail -10` → FAIL(`model_status_at`/`file_urls`/`SOURCES` 未定义)。

- [ ] **Step 2: 实现下载器**(`local_asr.rs` 追加)

```rust
use serde::Serialize;
use sha2::Digest;
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

/// ModelScope first: byte-identical to the official package and reachable
/// from China; HF (csukuangfj2) as fallback. hf-mirror.com 308s back to HF
/// for this repo, so it is NOT a usable mirror (verified 2026-07-12).
const SOURCES: &[&str] = &[
  "https://modelscope.cn/models/zengshuishui/Qwen3-ASR-onnx/resolve/master/model_0.6B/",
  "https://huggingface.co/csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/main/",
];

/// Emit a progress event at most every this many bytes (avoid event spam:
/// ~983MB / 8MB ≈ 120 events for the whole download).
const PROGRESS_EMIT_STEP: u64 = 8 * 1024 * 1024;

fn file_urls(file: &ModelFile) -> Vec<String> {
  SOURCES.iter().map(|base| format!("{base}{}", file.rel_path)).collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
  pub state: String,
  pub downloaded_bytes: u64,
  pub total_bytes: u64,
}

pub fn model_status(downloading: bool) -> ModelStatus {
  match model_dir() {
    Ok(dir) => model_status_at(&dir, downloading),
    Err(_) => ModelStatus {
      state: "absent".into(),
      downloaded_bytes: 0,
      total_bytes: total_download_bytes(),
    },
  }
}

fn model_status_at(dir: &Path, downloading: bool) -> ModelStatus {
  let mut downloaded = 0u64;
  let mut complete = true;
  for f in MODEL_FILES {
    let finished = fs::metadata(dir.join(f.rel_path)).map(|m| m.len()).unwrap_or(0);
    if finished == f.size {
      downloaded += f.size;
      continue;
    }
    complete = false;
    downloaded += finished.min(f.size);
    if let Ok(m) = fs::metadata(dir.join(format!("{}.part", f.rel_path))) {
      downloaded += m.len().min(f.size);
    }
  }
  let state = if downloading {
    "downloading"
  } else if complete {
    "ready"
  } else if downloaded > 0 {
    "partial"
  } else {
    "absent"
  };
  ModelStatus { state: state.into(), downloaded_bytes: downloaded, total_bytes: total_download_bytes() }
}

fn emit_progress(app: &tauri::AppHandle, state: &str, downloaded: u64, message: Option<&str>) {
  let _ = app.emit(
    "local-model-download-progress",
    serde_json::json!({
      "state": state,
      "downloadedBytes": downloaded,
      "totalBytes": total_download_bytes(),
      "message": message,
    }),
  );
}

/// Download every missing model file (resumable via HTTP Range on a .part
/// sibling), verify sha256, then atomically rename into place. Progress goes
/// out as `local-model-download-progress` events; the terminal event
/// (ready/cancelled/error) is emitted by the COMMAND, not here.
pub async fn download_model(app: tauri::AppHandle, cancel: CancellationToken) -> Result<(), String> {
  let dir = model_dir().map_err(|e| e.to_string())?;
  let client = reqwest::Client::builder()
    .connect_timeout(std::time::Duration::from_secs(15))
    // No overall timeout: a ~756MB file on a slow link legitimately takes long.
    .build()
    .map_err(|e| e.to_string())?;

  // Bytes of files already complete before this run (for absolute progress).
  let mut done_bytes: u64 = MODEL_FILES
    .iter()
    .filter(|f| fs::metadata(dir.join(f.rel_path)).map(|m| m.len() == f.size).unwrap_or(false))
    .map(|f| f.size)
    .sum();

  for file in MODEL_FILES {
    let final_path = dir.join(file.rel_path);
    if fs::metadata(&final_path).map(|m| m.len() == file.size).unwrap_or(false) {
      continue; // already downloaded
    }
    download_one(&app, &client, &dir, file, &cancel, done_bytes).await?;
    done_bytes += file.size;
    emit_progress(&app, "downloading", done_bytes, None);
  }
  Ok(())
}

async fn download_one(
  app: &tauri::AppHandle,
  client: &reqwest::Client,
  dir: &Path,
  file: &ModelFile,
  cancel: &CancellationToken,
  done_bytes: u64,
) -> Result<(), String> {
  use std::io::Write;

  let part_path = dir.join(format!("{}.part", file.rel_path));
  if let Some(parent) = part_path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }

  let mut last_err = String::new();
  for url in file_urls(file) {
    if cancel.is_cancelled() {
      return Err("DOWNLOAD_CANCELLED".into());
    }
    let offset = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    // A .part larger than the target is corrupt — restart it.
    let offset = if offset > file.size { 0 } else { offset };
    match stream_to_part(app, client, &url, &part_path, offset, file, cancel, done_bytes).await {
      Ok(()) => {
        // Size + sha256 gate before the file becomes "real".
        let got = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
        if got != file.size {
          last_err = format!("{}: size mismatch {got} != {}", file.rel_path, file.size);
          let _ = fs::remove_file(&part_path);
          continue;
        }
        let path_for_hash = part_path.clone();
        let hash = tokio::task::spawn_blocking(move || -> Result<String, String> {
          let mut hasher = sha2::Sha256::new();
          let mut reader = fs::File::open(&path_for_hash).map_err(|e| e.to_string())?;
          std::io::copy(&mut reader, &mut hasher).map_err(|e| e.to_string())?;
          Ok(format!("{:x}", hasher.finalize()))
        })
        .await
        .map_err(|e| e.to_string())??;
        if hash != file.sha256 {
          last_err = format!("{}: sha256 mismatch", file.rel_path);
          let _ = fs::remove_file(&part_path);
          continue;
        }
        fs::rename(&part_path, dir.join(file.rel_path)).map_err(|e| e.to_string())?;
        return Ok(());
      }
      Err(err) if err == "DOWNLOAD_CANCELLED" => return Err(err),
      Err(err) => {
        // Keep the .part — the next source (byte-identical) resumes it.
        last_err = format!("{url}: {err}");
        log::warn!("model download source failed: {last_err}");
      }
    }
  }
  Err(format!("failed to download {}: {last_err}", file.rel_path))
}

#[allow(clippy::too_many_arguments)]
async fn stream_to_part(
  app: &tauri::AppHandle,
  client: &reqwest::Client,
  url: &str,
  part_path: &Path,
  offset: u64,
  file: &ModelFile,
  cancel: &CancellationToken,
  done_bytes: u64,
) -> Result<(), String> {
  use std::io::Write;

  let mut request = client.get(url);
  if offset > 0 {
    request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
  }
  let response = request.send().await.map_err(|e| e.to_string())?;
  let status = response.status();
  if !status.is_success() {
    return Err(format!("HTTP {status}"));
  }
  // 206 = server honored Range (append); anything else = full body (truncate).
  let append = offset > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
  let mut out = fs::OpenOptions::new()
    .create(true)
    .append(append)
    .write(true)
    .truncate(!append)
    .open(part_path)
    .map_err(|e| e.to_string())?;
  let mut written = if append { offset } else { 0 };
  let mut last_emit = written;

  let mut response = response;
  loop {
    let chunk = tokio::select! {
      _ = cancel.cancelled() => return Err("DOWNLOAD_CANCELLED".into()),
      chunk = response.chunk() => chunk.map_err(|e| e.to_string())?,
    };
    let Some(chunk) = chunk else { break };
    out.write_all(&chunk).map_err(|e| e.to_string())?;
    written += chunk.len() as u64;
    if written - last_emit >= PROGRESS_EMIT_STEP {
      last_emit = written;
      emit_progress(app, "downloading", done_bytes + written.min(file.size), None);
    }
  }
  out.flush().map_err(|e| e.to_string())?;
  Ok(())
}

/// Remove the model from disk (Settings "delete model"). Callers must unload
/// the worker first so ~1GB of weights don't linger in RAM for a deleted model.
pub fn delete_model() -> Result<(), String> {
  let dir = model_dir().map_err(|e| e.to_string())?;
  match fs::remove_dir_all(&dir) {
    Ok(()) => Ok(()),
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(err) => Err(err.to_string()),
  }
}
```

- [ ] **Step 3: 跑 Step 1 测试**

Run: `cargo test local_asr 2>&1 | tail -10` → 全 PASS。

- [ ] **Step 4: 命令层**(`commands.rs` 追加,`get_dictionary` 附近)

```rust
// --- Local ASR model management (settings window) ---

#[tauri::command]
pub async fn download_local_model(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
  log::info!("command:download_local_model");
  let cancel = CancellationToken::new();
  {
    let mut slot = state.local_model_download.lock().unwrap();
    if slot.is_some() {
      return Err("Model download already in progress".into());
    }
    *slot = Some(cancel.clone());
  }

  let result = crate::local_asr::download_model(app.clone(), cancel).await;
  *state.local_model_download.lock().unwrap() = None;

  match result {
    Ok(()) => {
      let status = crate::local_asr::model_status(false);
      let _ = app.emit(
        "local-model-download-progress",
        json!({
          "state": "ready",
          "downloadedBytes": status.downloaded_bytes,
          "totalBytes": status.total_bytes,
        }),
      );
      Ok(true)
    }
    Err(err) if err == "DOWNLOAD_CANCELLED" => {
      let status = crate::local_asr::model_status(false);
      let _ = app.emit(
        "local-model-download-progress",
        json!({
          "state": "cancelled",
          "downloadedBytes": status.downloaded_bytes,
          "totalBytes": status.total_bytes,
        }),
      );
      Ok(false)
    }
    Err(err) => {
      let status = crate::local_asr::model_status(false);
      let _ = app.emit(
        "local-model-download-progress",
        json!({
          "state": "error",
          "downloadedBytes": status.downloaded_bytes,
          "totalBytes": status.total_bytes,
          "message": err,
        }),
      );
      Err(err)
    }
  }
}

#[tauri::command]
pub fn cancel_local_model_download(state: State<'_, AppState>) -> Result<bool, String> {
  log::info!("command:cancel_local_model_download");
  if let Some(token) = state.local_model_download.lock().unwrap().as_ref() {
    token.cancel();
    return Ok(true);
  }
  Ok(false)
}

#[tauri::command]
pub fn get_local_model_status(state: State<'_, AppState>) -> crate::local_asr::ModelStatus {
  let downloading = state.local_model_download.lock().unwrap().is_some();
  crate::local_asr::model_status(downloading)
}

#[tauri::command]
pub fn delete_local_model(state: State<'_, AppState>) -> Result<bool, String> {
  log::info!("command:delete_local_model");
  if state.local_model_download.lock().unwrap().is_some() {
    return Err("Cancel the running download first".into());
  }
  // Drop the loaded engine before deleting files, or ~1GB of weights would
  // linger in RAM serving a model the user just deleted.
  state.local_asr.unload();
  crate::local_asr::delete_model()?;
  Ok(true)
}
```

- [ ] **Step 5: 注册(三处同步的另两处)**

`lib.rs` `invoke_handler!` 列表(`commands::save_onboarding_api_key,` 之后)追加:

```rust
      commands::download_local_model,
      commands::cancel_local_model_download,
      commands::get_local_model_status,
      commands::delete_local_model,
```

`ipc-bridge.js` `tauriCommands`(`"save-onboarding-api-key"` 行后)追加(无参数命令,不用动 `tauriArgs`):

```js
    "download-local-model": "download_local_model",
    "cancel-local-model-download": "cancel_local_model_download",
    "get-local-model-status": "get_local_model_status",
    "delete-local-model": "delete_local_model",
```

- [ ] **Step 6: 编译 + 全量测试 + 真下载冒烟**

Run: `cargo test 2>&1 | tail -3` → 全绿;`cargo build` → 通过。
真下载路径(Range 续传/镜像回退)留给 Task 10 E2E 在 UI 里验证(先删本地模型再下,中途取消再继续)。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/local_asr.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/views/ipc-bridge.js
git commit -m "feat(local-asr): resumable two-mirror model downloader + IPC commands"
```

---

### Task 5: 转写路由 — local 分支、翻译回退云端、has_api_key 语义

**Files:**
- Modify: `src-tauri/src/commands.rs`(transcribe_audio、perform_transcription_request、新 resolve 函数)
- Modify: `src-tauri/src/settings.rs`(selected_api_key、SettingsPayload、save_settings 配套)
- Test: 两文件的 `#[cfg(test)]`

**Interfaces:**
- Consumes: Task 3 `AppState.local_asr`、`local_asr::wav_to_samples`、哨兵 `LOCAL_MODEL_MISSING`
- Produces:
  - `commands::TranscriptionRoute { Local, Cloud { provider: &'static str, api_key: String } }`
  - `commands::resolve_transcription_route(config: &AppConfig, translate_mode: bool) -> Result<TranscriptionRoute, String>`
  - `settings::SettingsPayload::from_config_with(config: &AppConfig, local_model_ready: bool) -> Self`(原 `from_config` 变薄壳)
  - `settings::local_provider_selectable(provider: &str, model_ready: bool) -> Result<(), String>`
  - `perform_transcription_request` 新签名:`(client, config, provider: &str, api_key, audio_buffer, translate_mode, mime_type)`(provider 不再从 config 推导)

- [ ] **Step 1: 写失败测试**

`commands.rs` tests 追加:

```rust
  fn config_with(provider: &str, groq: &str, openai: &str) -> AppConfig {
    let mut c = AppConfig::default();
    c.provider = provider.into();
    c.api_key_groq = groq.into();
    c.api_key_openai = openai.into();
    c
  }

  #[test]
  fn local_provider_routes_to_local_for_normal_dictation() {
    let route = resolve_transcription_route(&config_with("local", "", ""), false).unwrap();
    assert!(matches!(route, TranscriptionRoute::Local));
  }

  #[test]
  fn local_translate_falls_back_to_a_cloud_key_groq_first() {
    match resolve_transcription_route(&config_with("local", "gsk", "osk"), true).unwrap() {
      TranscriptionRoute::Cloud { provider, api_key } => {
        assert_eq!(provider, "groq");
        assert_eq!(api_key, "gsk");
      }
      other => panic!("expected cloud, got {other:?}"),
    }
    match resolve_transcription_route(&config_with("local", "", "osk"), true).unwrap() {
      TranscriptionRoute::Cloud { provider, api_key } => {
        assert_eq!(provider, "openai");
        assert_eq!(api_key, "osk");
      }
      other => panic!("expected cloud, got {other:?}"),
    }
  }

  #[test]
  fn local_translate_without_any_cloud_key_errors_clearly() {
    let err = resolve_transcription_route(&config_with("local", "", ""), true).unwrap_err();
    assert!(err.contains("cloud API key"), "{err}");
  }

  #[test]
  fn cloud_providers_route_unchanged_and_require_a_key() {
    match resolve_transcription_route(&config_with("groq", "gsk", ""), false).unwrap() {
      TranscriptionRoute::Cloud { provider, api_key } => {
        assert_eq!(provider, "groq");
        assert_eq!(api_key, "gsk");
      }
      other => panic!("{other:?}"),
    }
    assert!(resolve_transcription_route(&config_with("openai", "", ""), false).is_err());
  }
```

`settings.rs` tests 追加:

```rust
  #[test]
  fn selected_api_key_is_empty_for_local_provider() {
    let mut config = AppConfig::default();
    config.provider = "local".into();
    config.api_key_groq = "gsk".into();
    config.api_key = "legacy".into();
    assert_eq!(selected_api_key(&config), "");
  }

  #[test]
  fn settings_payload_local_provider_reports_model_readiness_as_has_api_key() {
    let mut config = AppConfig::default();
    config.provider = "local".into();
    assert!(SettingsPayload::from_config_with(&config, true).has_api_key);
    assert!(!SettingsPayload::from_config_with(&config, false).has_api_key);
    // Cloud providers keep the key-based semantics regardless of the flag.
    config.provider = "groq".into();
    config.api_key_groq = "gsk".into();
    assert!(SettingsPayload::from_config_with(&config, false).has_api_key);
  }

  #[test]
  fn local_provider_selectable_requires_a_downloaded_model() {
    assert!(local_provider_selectable("local", true).is_ok());
    assert!(local_provider_selectable("groq", false).is_ok());
    let err = local_provider_selectable("local", false).unwrap_err();
    assert!(err.to_lowercase().contains("download"), "{err}");
  }
```

Run: `cargo test 2>&1 | tail -10` → FAIL(符号未定义)。

- [ ] **Step 2: settings.rs 实现**

`selected_api_key` 开头加:

```rust
pub fn selected_api_key(config: &AppConfig) -> String {
  if config.provider == crate::local_asr::LOCAL_PROVIDER {
    // The local backend needs no key; never surface a cloud key as "selected"
    // (translate-mode fallback reads api_key_groq/api_key_openai directly).
    return String::new();
  }
  // ... 现有逻辑不动 ...
```

`SettingsPayload`:

```rust
impl SettingsPayload {
  pub fn from_config(config: &AppConfig) -> Self {
    Self::from_config_with(config, crate::local_asr::model_ready())
  }

  /// `local_model_ready` injected for tests (model_ready() reads the real
  /// app data dir). For provider=="local", has_api_key means "the selected
  /// provider is usable" — i.e. the model is on disk — so the readiness UI
  /// works unchanged.
  pub fn from_config_with(config: &AppConfig, local_model_ready: bool) -> Self {
    Self {
      has_api_key: if config.provider == crate::local_asr::LOCAL_PROVIDER {
        local_model_ready
      } else {
        !selected_api_key(config).trim().is_empty()
      },
      // ... 其余字段照旧 ...
    }
  }
}
```

新增校验函数(`normalize_record_shortcut` 附近):

```rust
/// Server-side guard behind the settings UI: provider "local" may only be
/// saved once the model is fully downloaded (the UI also enforces this, but
/// a stale window must not be able to persist an unusable config).
pub fn local_provider_selectable(provider: &str, model_ready: bool) -> Result<(), String> {
  if provider == crate::local_asr::LOCAL_PROVIDER && !model_ready {
    return Err("Local model is not downloaded yet — download it in Settings → Models first.".into());
  }
  Ok(())
}
```

- [ ] **Step 3: commands.rs 实现**

路由类型 + 函数(`build_transcription_prompt` 附近):

```rust
#[derive(Debug)]
pub enum TranscriptionRoute {
  Local,
  Cloud { provider: &'static str, api_key: String },
}

/// Decide where this transcription goes. Local provider transcribes locally;
/// translate mode is the exception — Qwen3-ASR only transcribes, so translation
/// falls back to whichever cloud key is configured (Groq preferred: cheaper,
/// and its whisper-large-v3 is the existing translate default).
pub fn resolve_transcription_route(
  config: &AppConfig,
  translate_mode: bool,
) -> Result<TranscriptionRoute, String> {
  if config.provider == crate::local_asr::LOCAL_PROVIDER {
    if !translate_mode {
      return Ok(TranscriptionRoute::Local);
    }
    if !config.api_key_groq.trim().is_empty() {
      return Ok(TranscriptionRoute::Cloud { provider: "groq", api_key: config.api_key_groq.trim().into() });
    }
    if !config.api_key_openai.trim().is_empty() {
      return Ok(TranscriptionRoute::Cloud { provider: "openai", api_key: config.api_key_openai.trim().into() });
    }
    return Err(
      "Translation needs a cloud API key (the local model only transcribes). Add a Groq or OpenAI key in Settings.".into(),
    );
  }
  let provider = if config.provider == "groq" { "groq" } else { "openai" };
  let api_key = settings::selected_api_key(config);
  if api_key.trim().is_empty() {
    return Err("API key not configured".into());
  }
  Ok(TranscriptionRoute::Cloud { provider, api_key })
}

/// Local decode: parse the (frontend-guaranteed) WAV and hand PCM to the
/// worker thread. Runs inside the caller's tokio::select! so cancel works
/// (the worker finishes in the background; the result is discarded).
async fn perform_local_transcription(
  handle: crate::local_asr::AsrHandle,
  audio_buffer: Vec<u8>,
  mime_type: &str,
) -> Result<String> {
  if !mime_type.contains("wav") {
    return Err(anyhow::anyhow!(
      "local transcription expects WAV audio, got {mime_type} (frontend must re-encode)"
    ));
  }
  let (samples, sample_rate) = crate::local_asr::wav_to_samples(&audio_buffer)?;
  log::info!(
    "transcribe: local qwen3, {:.1}s audio",
    samples.len() as f32 / sample_rate.max(1) as f32
  );
  let text = tokio::task::spawn_blocking(move || handle.transcribe_blocking(samples, sample_rate))
    .await
    .context("local ASR task join failed")?
    .map_err(|err| {
      if err.starts_with("LOCAL_MODEL_MISSING") {
        anyhow::anyhow!("Local model files are missing — download the model again in Settings.")
      } else {
        anyhow::anyhow!(err)
      }
    })?;
  Ok(text)
}
```

`transcribe_audio` 中,把

```rust
  let config = settings::read_config().map_err(stringify_error)?;
  let api_key = settings::selected_api_key(&config);
  if api_key.trim().is_empty() {
    return Err("API key not configured".into());
  }
```

替换为:

```rust
  let config = settings::read_config().map_err(stringify_error)?;
  let route = resolve_transcription_route(&config, translate_mode)?;
```

`tokio::select!` 块替换为:

```rust
  let asr_handle = state.local_asr.clone();
  let result = tokio::select! {
    _ = cancellation.cancelled() => Err(anyhow::anyhow!("TRANSCRIPTION_CANCELLED")),
    result = async {
      match &route {
        TranscriptionRoute::Local => {
          perform_local_transcription(asr_handle, audio_buffer, &mime).await
        }
        TranscriptionRoute::Cloud { provider, api_key } => {
          perform_transcription_request(
            &state.http_client,
            &config,
            provider,
            api_key,
            audio_buffer,
            translate_mode,
            mime.clone(),
          ).await
        }
      }
    } => result,
  };
```

`perform_transcription_request` 签名与首行改为:

```rust
async fn perform_transcription_request(
  client: &reqwest::Client,
  config: &AppConfig,
  provider: &str,
  api_key: &str,
  audio_buffer: Vec<u8>,
  translate_mode: bool,
  mime_type: String,
) -> Result<String> {
  let endpoint_root = if provider == "groq" {
```

(删除原 `let provider = if config.provider == "groq" ...` 一行;函数内其余 `provider` 引用不变。)

`save_settings` 中,`config.api_key = settings::selected_api_key(&config);` 替换为:

```rust
  settings::local_provider_selectable(&config.provider, crate::local_asr::model_ready())
    .map_err(stringify_error)?;
  if config.provider == crate::local_asr::LOCAL_PROVIDER {
    // The form's key fields are hidden for the local provider; keep the stored
    // legacy key instead of clobbering it with the (empty) local selection.
    config.api_key = existing.api_key.clone();
  } else {
    config.api_key = settings::selected_api_key(&config);
  }
```

- [ ] **Step 4: 跑测试**

Run: `cargo test 2>&1 | tail -5` → 全绿(含既有 settings/commands 测试——`selected_api_key` 的 local 早退不影响它们)。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/settings.rs
git commit -m "feat(local-asr): route transcription local/cloud; translate falls back to cloud; local readiness drives hasApiKey"
```

---

### Task 6: 录音开始时预加载模型

**Files:**
- Modify: `src-tauri/src/local_asr.rs`(`maybe_preload`)
- Modify: `src-tauri/src/hotkey.rs:594-603`(dispatch_action)

**Interfaces:**
- Produces: `local_asr::maybe_preload(app: &AppHandle)`(非阻塞,可从任意线程调)

- [ ] **Step 1: 实现**(`local_asr.rs` 追加)

```rust
/// Fired on hotkey record-start: while the user is speaking, warm the model
/// so the transcription that follows pays ~zero load latency. Runs off-thread
/// — the hotkey dispatch loop must never block on config I/O or model load.
pub fn maybe_preload(app: &tauri::AppHandle) {
  use tauri::Manager;
  let handle = app.state::<crate::state::AppState>().local_asr.clone();
  std::thread::spawn(move || {
    let Ok(config) = crate::settings::read_config() else { return };
    if config.provider == LOCAL_PROVIDER && model_ready() {
      handle.preload();
    }
  });
}
```

`hotkey.rs` `dispatch_action` 的 `Action::Start` 分支,`let _ = app.emit("start-recording", translate_mode);` 之前加:

```rust
      // Warm the local model while the user speaks (no-op for cloud providers).
      crate::local_asr::maybe_preload(app);
```

- [ ] **Step 2: 编译 + 全量测试**

Run: `cargo test 2>&1 | tail -3` → 全绿;`cargo build` → 通过。
(薄胶水,不单测;行为由 Task 10 E2E 验证:按下快捷键后日志出现 `local ASR: model loaded in …`,转写零加载等待。)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/local_asr.rs src-tauri/src/hotkey.rs
git commit -m "feat(local-asr): preload the model on record start"
```

---

### Task 7: 前端音频通路 — local 模式恒发 WAV + 模型徽章

**Files:**
- Modify: `src/views/vad-gate.js`
- Modify: `src/views/input-prompt.js:16-24, 327-341, 916-946`

**Interfaces:**
- Consumes: Rust 侧要求 local+非翻译时 mime 必须含 `wav`(Task 5)
- Produces: `window.SayTypeVadGate.analyze(blob, { forceWav })`、`window.SayTypeVadGate.encodeFullWav(blob)`

- [ ] **Step 1: vad-gate.js**

`analyze` 改为:

```js
  // opts.forceWav: the local ASR backend needs PCM WAV regardless of whether
  // trimming saves anything — encode even when the trim is skipped.
  async function analyze(blob, opts) {
    const forceWav = !!(opts && opts.forceWav);
    const vad = await getVad();
    const pcm = await blobToPcm16k(blob);
    const durationMs = (pcm.length / TARGET_RATE) * 1000;
    const segments = [];
    for await (const seg of vad.run(pcm, TARGET_RATE)) {
      segments.push({ start: seg.start, end: seg.end });
    }
    const verdict = window.SayTypeVad.decideSpeech(segments, MIN_SPEECH_MS);
    let wav = null;
    let trimmedMs = 0;
    if (verdict.speech) {
      const range = window.SayTypeVad.trimRangeMs(segments, durationMs, {
        padStartMs: PAD_START_MS,
        padEndMs: PAD_END_MS,
      });
      if (window.SayTypeVad.shouldTrim(range, durationMs, MIN_TRIM_SAVINGS_MS)) {
        const startSample = Math.max(0, Math.floor((range.startMs / 1000) * TARGET_RATE));
        const endSample = Math.min(pcm.length, Math.ceil((range.endMs / 1000) * TARGET_RATE));
        wav = window.SayTypeVad.encodeWavPcm16(pcm.subarray(startSample, endSample), TARGET_RATE);
        trimmedMs = Math.round(durationMs - (range.endMs - range.startMs));
      } else if (forceWav) {
        wav = window.SayTypeVad.encodeWavPcm16(pcm, TARGET_RATE);
      }
    }
    return { speech: verdict.speech, totalSpeechMs: verdict.totalSpeechMs, durationMs, wav, trimmedMs };
  }
```

新增(warmup 前)+ 导出行更新:

```js
  // Local-backend fallback: WAV without the VAD. Plain WebAudio decode +
  // resample (blobToPcm16k) doesn't depend on Silero/ort, so even when the
  // VAD path fails the local engine can still get its PCM.
  async function encodeFullWav(blob) {
    const pcm = await blobToPcm16k(blob);
    return window.SayTypeVad.encodeWavPcm16(pcm, TARGET_RATE);
  }
```

```js
  window.SayTypeVadGate = { analyze, warmup, encodeFullWav };
```

- [ ] **Step 2: input-prompt.js 常量与徽章**

行 16-24 的常量区追加/修改:

```js
const LOCAL_MODEL_ID = "qwen3-asr-0.6b-int8";
const MODEL_LABEL = {
  "gpt-4o-transcribe": "OpenAI GPT-4o",
  "gpt-4o-mini-transcribe": "OpenAI GPT-4o mini",
  "whisper-1": "OpenAI Whisper",
  "whisper-large-v3": "Groq Whisper v3",
  "whisper-large-v3-turbo": "Groq Whisper v3 Turbo",
  [LOCAL_MODEL_ID]: "Qwen3 · Local",
};
```

`resolveActiveModel()`(行 327)改为:

```js
  resolveActiveModel() {
    if (this.currentProvider == null) {
      return null; // settings not loaded yet
    }
    if (this.currentProvider === "local") {
      // Translate mode falls back to a cloud Whisper (commands.rs picks the
      // provider by key presence — the exact one isn't known here).
      return this.translateMode ? "Cloud Whisper" : MODEL_LABEL[LOCAL_MODEL_ID];
    }
    const provider = this.currentProvider === "groq" ? "groq" : "openai";
    let model;
    if (this.translateMode) {
      model = TRANSLATE_MODEL[provider];
    } else if (!String(this.currentModel || "").trim()) {
      model = RECORD_DEFAULT_MODEL[provider];
    } else {
      model = this.currentModel;
    }
    return MODEL_LABEL[model] || model || "";
  }
```

- [ ] **Step 3: processRecording 的 WAV 强制与回退**

VAD 块(行 916-939)改为:

```js
      let uploadBuffer = null;
      let uploadMime = mimeType || "audio/webm";
      // Local backend (non-translate) can only decode WAV — force PCM output
      // from the VAD path, and fall back to a plain decode+encode if the VAD
      // itself fails. Translate mode goes to a cloud API, which takes any format.
      const useLocalWav = this.currentProvider === "local" && !translateMode;
      try {
        if (window.SayTypeVadGate) {
          const verdict = await window.SayTypeVadGate.analyze(audioBlob, { forceWav: useLocalWav });
          if (!verdict.speech) {
            this.removePendingInsertion(sessionId);
            if (allowUi) {
              this.statusText.textContent = t("inputPrompt.noSpeech");
              this.scheduleHidePrompt(2000);
            }
            return;
          }
          if (verdict.wav) {
            uploadBuffer = verdict.wav;
            uploadMime = "audio/wav";
            if (verdict.trimmedMs > 0) {
              console.log(
                `VAD trim: cut ${verdict.trimmedMs}ms of head/tail silence from a ${Math.round(verdict.durationMs)}ms clip`
              );
            }
          }
        }
      } catch (vadError) {
        console.warn("VAD gate failed; proceeding to transcription:", vadError);
      }
      if (useLocalWav && !uploadBuffer) {
        // VAD path failed (or produced no WAV): encode without it. If even
        // this fails, fall through with the original bytes — the backend
        // rejects them with an explicit "expects WAV" error (no silent drop).
        try {
          uploadBuffer = await window.SayTypeVadGate.encodeFullWav(audioBlob);
          uploadMime = "audio/wav";
        } catch (wavError) {
          console.warn("full-WAV fallback failed; sending original bytes:", wavError);
        }
      }
```

- [ ] **Step 4: Node 测试 + 浏览器冒烟**

Run: `node src/views/vad-decision.test.mjs` → 既有 14 个测试全 PASS(纯函数未动)。
浏览器冒烟(照 CLAUDE.md 的 static-serve 法):`python3 -m http.server 1430 -d src/views` 开 `input-prompt.html`,console 里:
```js
const r = await fetch("vendor/vad/..");  // 略——直接验证新 API 形态:
typeof SayTypeVadGate.encodeFullWav === "function"  // true
```
再用 `new Blob([...])` 造一段真录音(或跳过,留给 Task 10 真机)。

- [ ] **Step 5: Commit**

```bash
git add src/views/vad-gate.js src/views/input-prompt.js
git commit -m "feat(local-asr): always upload 16k mono WAV in local mode; Qwen3 model badge"
```

---

### Task 8: 设置 UI(本地模型面板 + 下载进度)+ i18n + readiness 文案

**Files:**
- Modify: `src/views/settings.html:248-289`
- Modify: `src/views/settings.js`
- Modify: `src/views/main.js:462-470`(readiness pill 文案)
- Modify: `src/views/i18n.js`(en + zh)

**Interfaces:**
- Consumes: Task 4 的 4 个 IPC 命令与 `local-model-download-progress` 事件;`get-settings` 的 `hasApiKey` local 语义(Task 5)

- [ ] **Step 1: settings.html**

`providerSelect` 加选项(brand 名不进 i18n,与 Groq/OpenAI 一致):

```html
                <option value="groq">Groq</option>
                <option value="openai">OpenAI</option>
                <option value="local">Local · Qwen3-ASR</option>
```

Model Selection 的 setting-item 之后追加:

```html
          <div class="setting-item hidden" id="localModelItem">
            <div class="setting-info">
              <div class="setting-title" data-i18n="settings.localModel.title">Local model</div>
              <div class="setting-description" id="localModelStatus"></div>
            </div>
            <div class="setting-control">
              <progress id="localModelProgress" class="hidden" max="1000" value="0"></progress>
              <button class="btn btn-secondary" id="localModelActionBtn" type="button"></button>
              <button class="btn btn-secondary hidden" id="localModelDeleteBtn" type="button"></button>
            </div>
          </div>
```

- [ ] **Step 2: settings.js — 数据与渲染**

`modelOptions`(行 24-34)加:

```js
  local: [
    { value: "qwen3-asr-0.6b-int8", labelKey: "settings.model.options.qwen3AsrLocal", recommended: false },
  ],
```

`toggleApiKeyVisibility`(行 150)改为三态:

```js
function toggleApiKeyVisibility(provider) {
  const fieldGroq = document.getElementById("apiKeyFieldGroq");
  const fieldOpenAI = document.getElementById("apiKeyFieldOpenAI");
  if (!fieldGroq || !fieldOpenAI) {
    return;
  }
  fieldGroq.classList.toggle("hidden", provider !== "groq");
  fieldOpenAI.classList.toggle("hidden", provider !== "openai");
}
```

新增本地模型面板逻辑(`toggleApiKeyVisibility` 后):

```js
// --- Local model panel (provider "local") ---
let localModelState = "absent"; // absent | partial | downloading | ready
let localModelSyncBound = false;

function formatGB(bytes) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function renderLocalModelPanel(status) {
  const item = document.getElementById("localModelItem");
  const statusEl = document.getElementById("localModelStatus");
  const actionBtn = document.getElementById("localModelActionBtn");
  const deleteBtn = document.getElementById("localModelDeleteBtn");
  const progressEl = document.getElementById("localModelProgress");
  if (!item || !statusEl || !actionBtn || !deleteBtn || !progressEl) {
    return;
  }
  localModelState = status.state;
  const provider = document.getElementById("providerSelect")?.value;
  item.classList.toggle("hidden", provider !== "local");

  const pct = status.totalBytes ? status.downloadedBytes / status.totalBytes : 0;
  progressEl.value = Math.round(pct * 1000);
  progressEl.classList.toggle("hidden", status.state !== "downloading");
  deleteBtn.classList.toggle("hidden", status.state !== "ready");
  deleteBtn.textContent = translate("settings.localModel.delete");

  if (status.state === "ready") {
    statusEl.textContent = translate("settings.localModel.statusReady", {
      size: formatGB(status.totalBytes),
    });
    actionBtn.classList.add("hidden");
  } else if (status.state === "downloading") {
    statusEl.textContent = translate("settings.localModel.statusDownloading", {
      done: formatGB(status.downloadedBytes),
      total: formatGB(status.totalBytes),
    });
    actionBtn.classList.remove("hidden");
    actionBtn.textContent = translate("settings.localModel.cancel");
  } else {
    statusEl.textContent =
      status.state === "partial"
        ? translate("settings.localModel.statusPartial")
        : translate("settings.localModel.statusAbsent", { total: formatGB(status.totalBytes) });
    actionBtn.classList.remove("hidden");
    actionBtn.textContent = translate(
      status.state === "partial" ? "settings.localModel.resume" : "settings.localModel.download"
    );
  }
}

async function refreshLocalModelStatus() {
  if (!ipc) {
    return;
  }
  try {
    renderLocalModelPanel(await ipc.invoke("get-local-model-status"));
  } catch (error) {
    console.error("Failed to fetch local model status:", error);
  }
}

async function handleLocalModelAction() {
  try {
    if (localModelState === "downloading") {
      await ipc.invoke("cancel-local-model-download");
      return; // terminal event repaints the panel
    }
    // Optimistic repaint, then kick the (long-running) download; progress
    // events keep the panel live. Errors surface via the "error" event too.
    renderLocalModelPanel({
      state: "downloading",
      downloadedBytes: 0,
      totalBytes: 1,
    });
    void refreshLocalModelStatus();
    await ipc.invoke("download-local-model");
  } catch (error) {
    console.error("Local model download failed:", error);
  }
}

async function handleLocalModelDelete() {
  if (!confirm(translate("settings.localModel.deleteConfirm"))) {
    return;
  }
  try {
    await ipc.invoke("delete-local-model");
    await refreshLocalModelStatus();
  } catch (error) {
    console.error("Failed to delete local model:", error);
  }
}

function setupLocalModelSync() {
  if (localModelSyncBound || !ipc) {
    return;
  }
  localModelSyncBound = true;
  ipc.on("local-model-download-progress", (_event, payload) => {
    if (!payload) {
      return;
    }
    if (payload.state === "error") {
      alert(translate("settings.localModel.downloadFailed", { reason: payload.message || "" }));
    }
    renderLocalModelPanel({
      state: payload.state === "downloading" ? "downloading" : null,
      downloadedBytes: payload.downloadedBytes || 0,
      totalBytes: payload.totalBytes || 0,
    });
    if (payload.state !== "downloading") {
      // ready/cancelled/error: re-derive the real on-disk state.
      void refreshLocalModelStatus();
    }
  });
}
```

- [ ] **Step 3: settings.js — 接线**

`handleProviderChange`(行 196)追加一行:

```js
function handleProviderChange(event) {
  const provider = event.target.value || "groq";
  updateModelOptions(provider);
  toggleApiKeyVisibility(provider);
  void refreshLocalModelStatus();
}
```

`bindEventHandlers`(行 246 附近)追加:

```js
  document.getElementById("localModelActionBtn")?.addEventListener("click", () => {
    void handleLocalModelAction();
  });
  document.getElementById("localModelDeleteBtn")?.addEventListener("click", () => {
    void handleLocalModelDelete();
  });
```

`bootstrapSettingsPage`(行 630 附近)`setupThemeSync();` 后加 `setupLocalModelSync();`。
`loadSettings`(行 547 的 `await Promise.all` 前)加 `await refreshLocalModelStatus();`。

`saveSettings`(行 564)provider 取出后加保存门:

```js
    const provider = document.getElementById("providerSelect")?.value || "groq";
    if (provider === "local" && localModelState !== "ready") {
      alert(translate("settings.localModel.notReady"));
      return;
    }
```

- [ ] **Step 4: main.js readiness pill**

行 466-469 的 API key pill 改为:

```js
  const isLocal = cachedSettings?.provider === "local";
  pills.push(
    buildPill({
      label: isLocal
        ? t("readiness.localModel")
        : hasKey
          ? t("readiness.apiKey")
          : t("readiness.addApiKey"),
      ok: hasKey,
      onFix: openSettings,
    })
  );
```

(以文件实际结构为准——第 468 行现为单行 `buildPill({...})` 调用,保持其调用形态,仅换 label 表达式。)

- [ ] **Step 5: i18n.js(en 与 zh 两处都加)**

en 的 `settings.model.options` 加:

```js
            qwen3AsrLocal: "Qwen3-ASR 0.6B (on-device) — free, offline",
```

en 的 `settings` 下加(`apiKey` 同级):

```js
        localModel: {
          title: "Local model",
          statusAbsent: "Not downloaded — about {total} on disk, one-time download.",
          statusPartial: "Download interrupted — resume where it left off.",
          statusDownloading: "Downloading… {done} / {total}",
          statusReady: "Ready · {size} on disk",
          download: "Download model",
          resume: "Resume download",
          cancel: "Cancel download",
          delete: "Delete model",
          deleteConfirm: "Delete the local model? You'll need to download ~1 GB again to use it.",
          notReady: "Download the local model first, then save.",
          downloadFailed: "Model download failed: {reason}",
        },
```

en 的 `readiness` 加:

```js
        localModel: "Local model",
```

zh 对应(`translations.zh` 相同路径):

```js
            qwen3AsrLocal: "Qwen3-ASR 0.6B(本地)— 免费、离线",
```

```js
        localModel: {
          title: "本地模型",
          statusAbsent: "未下载 — 磁盘占用约 {total},一次性下载。",
          statusPartial: "下载中断 — 可从断点继续。",
          statusDownloading: "下载中… {done} / {total}",
          statusReady: "已就绪 · 磁盘占用 {size}",
          download: "下载模型",
          resume: "继续下载",
          cancel: "取消下载",
          delete: "删除模型",
          deleteConfirm: "删除本地模型?再次使用需重新下载约 1 GB。",
          notReady: "请先下载本地模型,再保存设置。",
          downloadFailed: "模型下载失败:{reason}",
        },
```

```js
        localModel: "本地模型",
```

> i18n 的 `t(key, vars)` 支持 `{var}` 占位(`inputPrompt.hint` 已在用)。

- [ ] **Step 6: 验证**

Run: `node src/views/vad-decision.test.mjs` → PASS。
静态冒烟:`python3 -m http.server 1430 -d src/views` 开 `settings.html`——IPC 超时后渲染为未授权态属预期(见 CLAUDE.md 验证 gotcha);检查 provider 下拉有第三项、选中 local 时 key 字段隐藏且 `#localModelItem` 显示(console 里手动 `renderLocalModelPanel({state:"absent",downloadedBytes:0,totalBytes:983000000})` 驱动)。

- [ ] **Step 7: Commit**

```bash
git add src/views/settings.html src/views/settings.js src/views/main.js src/views/i18n.js
git commit -m "feat(local-asr): settings panel for model download/progress/delete + i18n"
```

---

### Task 9: 文档同步 + CI 核查

**Files:**
- Modify: `CLAUDE.md`(架构小节 + 新增"Local transcription"小节)
- Modify: `.github/workflows/ci.yml`(仅在核查发现需要时)

- [ ] **Step 1: CLAUDE.md**

架构小节 `commands.rs` 条目的 IPC 三处同步提醒不变;`platform/` 条目后加:

```markdown
- `local_asr.rs` — the local transcription backend (provider `"local"`): Qwen3-ASR-0.6B
  int8 via the official `sherpa-onnx` crate (in-process, CPU). Owns the model manifest
  (6 files, ~955 MB under `<app-data>/models/qwen3-asr-0.6b-int8/`), the resumable
  two-mirror downloader (ModelScope primary, HF `csukuangfj2` fallback; sha256-gated),
  and a dedicated worker thread that lazy-loads the model, transcribes, and unloads
  after 10 min idle (the record-start hotkey path calls `maybe_preload` so loading
  overlaps with speaking). Translate mode never runs locally — it falls back to a
  configured cloud key (Groq preferred). The frontend always uploads 16 kHz mono WAV
  in local mode (`vad-gate.js` forceWav / encodeFullWav). `SettingsPayload.has_api_key`
  means "model downloaded" when provider is local.
  Build note: `sherpa-onnx-sys` (default `static` feature) downloads prebuilt static
  libs from GitHub at build time — no cmake, but network needed on first build; set
  `SHERPA_ONNX_ARCHIVE_DIR` to build offline. Known risk: the Windows static lib is
  MT Release and may conflict with Rust's default /MD CRT — if the Windows CI leg
  reds, switch that target to the `shared` feature and bundle the DLLs.
```

- [ ] **Step 2: CI 核查**

Run: `git push` 前先本地 `cargo test` 全绿;push 后看 ci.yml 三条腿:
- macOS/Linux:预期直接绿(build.rs 联网下载静态库,runner 可出网)。
- Windows:若链接期报 CRT 冲突(LNK2038 / MT vs MD),按 CLAUDE.md 里写的退路处理——本任务只**记录**,修复另开工作(Windows 属"未真机验证"档,不阻塞)。

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the local Qwen3-ASR backend and its build/runtime model"
```

---

### Task 10: 真机端到端验证(手动清单)

**前提:** `npm run build:mac:install` 装最新构建(签名 env 存在则权限保持,见 CLAUDE.md);或 `npm run dev`。**先把 Task 1 spike 手动放的模型目录删掉**,从零走下载流程:`rm -rf ~/Library/Application\ Support/com.tao.saytype/models`。

- [ ] 1. 设置 → Models:provider 下拉出现"Local · Qwen3-ASR";选中后 key 字段消失、本地模型面板显示"未下载(约 0.98 GB)";**此时点保存被拦**(提示先下载)。
- [ ] 2. 点"下载模型":进度条走动、字节数增长;**中途点"取消下载"** → 面板变"下载中断 — 可从断点继续";点"继续下载" → 从断点续(观察字节数不清零);下载完成 → "已就绪"。日志无报错(`~/Library/Logs/com.tao.saytype/SayType.log` 或 dev stdout)。
- [ ] 3. 保存(provider=local)成功;主窗 readiness 卡显示"本地模型"pill 为绿(切窗口焦点触发刷新)。
- [ ] 4. 中文听写(短句):按住 Ctrl+Shift 说一句 → 小窗徽章显示 **Qwen3 · Local** → 松开 → 文字插入目标应用。看日志:`local ASR: model loaded in …`(应在录音期间就出现——预加载生效)、`transcribe: local qwen3, …s audio`。
- [ ] 5. 长独白(60–90s):无截尾(对照 spike 定稿的 max_new_tokens)。
- [ ] 6. 质量对比:同样内容分别在 local 与 Groq turbo 下各说一遍,对比准确率/标点(主观满意即可——spike 已量化过)。
- [ ] 7. 取消路径:录音后立刻 Esc 取消转写 → 小窗显示"已取消",无插入。
- [ ] 8. 内存曲线:Activity Monitor 观察——转写后 SayType 内存 ~1.2GB+;**闲置 10 分钟后回落**(日志 `local ASR: model unloaded after 600s idle`)。
- [ ] 9. 翻译模式(Shift+Alt):配了 Groq key 时走云端翻译照常;把两个云 key 都清掉再试 → 明确报错"Translation needs a cloud API key…"。
- [ ] 10. 删除模型:设置 → 删除(确认框)→ 面板回"未下载";provider 仍是 local 时听写 → 报"Local model files are missing — download…";设置里保存被拦。切回 Groq 一切照旧。
- [ ] 11. 回归:云端 provider(Groq/OpenAI)的听写、翻译、词典、历史、插入失败复制按钮全部照旧。
- [ ] 12. 全部通过后,与用户确认是否要把 TODO.md 里补一条"本地 ASR 后续"(dictionary/context biasing、1.7B 选项、Qwen 自有幻觉观察)。

---

## Self-Review 结论(写完计划后自查)

- **Spec 覆盖:** 设计 §1 settings(T5/T8)、§2 local_asr 四职责(T2/T3/T4)、§3 转写路径(T5/T7)、§4 下载 UX(T4/T8)、§5 边界(翻译 T5、dictionary 不支持=无代码即正确、徽章 T7、SEED 不发=local 分支不构造 prompt,天然满足)、§6 错误处理(T4 sha256/续传、T5 缺模型映射、无静默回退)、§7 测试(各任务 + T1 spike + T10 E2E)、§8 CI(T9)。**无缺口。**
- **占位符:** Task 2 的 `<FILL-STEP-1>`/`0 /*FILL*/` 是**刻意的实现步骤**(Step 1 提供精确获取命令,Step 3 的测试强制填真值才能变绿),非计划缺口。
- **类型一致性:** `AsrHandle::transcribe_blocking(Vec<f32>, u32) -> Result<String, String>` 在 T3 定义、T5 消费一致;`ModelStatus` camelCase 序列化与 T8 前端字段(`downloadedBytes/totalBytes/state`)一致;`resolve_transcription_route` 返回类型 T5 内自洽;事件名 `local-model-download-progress` 三处(T4 发、T8 收、接口块)一致;`maybe_preload` T6 定义即消费。
- **已知不确定点(不阻塞,均有兜底):** sherpa crate 1.13.4 具体方法名以 spike 编译为准(T1 Step 3 显式要求记录形态、T3 按其修正);ModelScope tokenizer 子路径(T1 Step 2 探测);Windows CRT 冲突(T9 记录 + 退路)。
