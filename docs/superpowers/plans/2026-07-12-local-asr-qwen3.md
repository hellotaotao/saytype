# 本地 Qwen3-ASR 转写后端 Implementation Plan(rev2:llama.cpp 子进程)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **rev2 (2026-07-13)**:引擎从 sherpa-onnx 进程内改为 **llama.cpp 子进程**(两轮真机实测后用户拍板,见 spec 修订)。Task 1(sherpa spike)已完成并保留;sherpa 版计划在本文件 git 历史。

**Goal:** 给 SayType 加第三个转写 provider `"local"`:每次转写起一个 `llama-mtmd-cli` 子进程跑 Qwen3-ASR-0.6B Q8_0(Metal/CPU),模型与二进制按需下载,转写完进程即退(零常驻内存)。

**Architecture:** 新模块 `src-tauri/src/local_asr.rs` 承载资产清单(2 个 GGUF + 每平台一个 llama.cpp 官方 zip)/下载/子进程执行器;`commands.rs` 的 `transcribe_audio` 增加路由层(local / cloud),取消 = 杀子进程(`kill_on_drop`);前端在 local 模式下恒发 16k mono WAV;settings 窗新增本地模型面板。无 worker 线程、无预加载、无闲置卸载。下游 scrub/历史/插入管线零改动。

**Tech Stack:** Rust (Tauri 2), `tokio::process`, `zip`(解压 llama 包), `sha2`(校验), reqwest(已有,流式下载), 前端 plain JS。**不再依赖 sherpa-onnx/hound。**

**Spec:** `docs/superpowers/specs/2026-07-12-local-asr-qwen3-design.md`(rev 2026-07-13,含全部实测事实:`-c 2048` 脚枪、`-p "a"` 必给、输出前缀格式、无 Q4、版本锁定 ≥b9173)。

## Global Constraints

- Rust 代码 2 空格缩进;错误消息英文;**日志绝不含转写文本/API key**(只记计数/形状;子进程 stderr 只入日志最后一行/计数)。
- **新增 IPC 命令三处同步**:`commands.rs`、`lib.rs` `invoke_handler!`、`ipc-bridge.js` `tauriCommands`。
- 新 UI 文案进 `src/views/i18n.js`,**en + zh 两份**。
- provider 标识:`"local"`;模型标识:`"qwen3-asr-0.6b-q8_0"`;llama.cpp 锁定 build 常量 `LLAMA_BUILD`(Task 2 定值)。
- 子进程必带 `-c 2048`(防 7GiB KV 预分配)与 `-p "a"`(防交互模式挂住)。
- 插入失败无剪贴板回退;转写成功但历史写失败不许变成 Err;本地失败**不静默回退云端**。
- 版本号不在本计划内 bump;solo 项目直接提交 main。
- `cargo test` 在 `src-tauri/` 下跑;Node 测试 `node src/views/vad-decision.test.mjs`;每任务收尾全量跑。

## 资产事实速查(已核实)

| 工件 | 精确字节数 | 来源 |
|---|---|---|
| `Qwen3-ASR-0.6B-Q8_0.gguf` | 804,749,248 | HF `ggml-org/Qwen3-ASR-0.6B-GGUF` `/resolve/main/` |
| `mmproj-Qwen3-ASR-0.6B-Q8_0.gguf` | 214,392,480 | 同上 |
| llama.cpp 官方 zip(macos-arm64 / win-x64-CPU / linux-x64-CPU 各一) | Task 2 核实 | `github.com/ggml-org/llama.cpp/releases/download/<LLAMA_BUILD>/` |

- 调用形态(实测):`llama-mtmd-cli -m <gguf> --mmproj <mmproj> --audio <wav> -p "a" -c 2048`,stdout 带 `language <lang><asr_text>` 前缀,静音时 lang 为 `None` 且正文为空。
- 存放:`app_data_dir()/local-asr/models/*.gguf` + `app_data_dir()/local-asr/bin/<LLAMA_BUILD>/llama-mtmd-cli`(zip 解压、拍平、unix 置 +x;dylib/dll 与 cli 同目录,官方包本就按同目录运行设计)。
- 由 app 自身 reqwest 下载 → 无 quarantine 属性 → 无 Gatekeeper 问题;安装包体积不变。

---

### Task 2: sherpa 遗留清理 + 资产清单/就绪检查

**Files:**
- Modify: `src-tauri/Cargo.toml`(移除 sherpa-onnx/hound,加 zip,tokio 加 "process" feature)
- Delete: `src-tauri/examples/qwen3_spike.rs`
- Create: `src-tauri/src/local_asr.rs`
- Modify: `src-tauri/src/lib.rs:1-8`(加 `mod local_asr;`)

**Interfaces (Produces):**
- `local_asr::LOCAL_PROVIDER: &str = "local"`、`LOCAL_MODEL_ID: &str = "qwen3-asr-0.6b-q8_0"`、`LLAMA_BUILD: &str`
- `local_asr::Asset { rel_path: &'static str, urls: &'static [&'static str], size: u64, sha256: &'static str }`
- `local_asr::MODEL_ASSETS: &[Asset]`(2 个 GGUF)、`llama_zip_asset() -> &'static Asset`(当前平台)
- `local_asr::local_asr_dir() -> anyhow::Result<PathBuf>`、`bin_dir(base) -> PathBuf`、`cli_path(base) -> PathBuf`
- `local_asr::assets_ready() -> bool` / `assets_ready_at(dir: &Path) -> bool`
- `local_asr::total_download_bytes() -> u64`(含当前平台 zip)

- [ ] **Step 1: 核实锁定版本与三平台 zip 的名称/大小/sha256**

```bash
# 1) 确认 b9960 tag 存在并列出资产名(没有就选最近的稳定 release,须 ≥ b9173,记录最终定值)
curl -s "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b9960" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(a['name'], a['size']) for a in d.get('assets',[])]"
# 2) 选三个:macos-arm64、Windows x64 CPU 变体(名字含 win + x64,选 CPU/AVX2 而非 cuda/vulkan)、
#    ubuntu/linux x64 CPU 变体;下载并算 sha256(每个 zip 约 10–50MB):
curl -L -o /tmp/mac.zip  "https://github.com/ggml-org/llama.cpp/releases/download/<TAG>/<mac-asset>"
shasum -a 256 /tmp/mac.zip   # win/linux 同理
# 3) 两个 GGUF 的 sha256 从 HF LFS 元数据取:
curl -s "https://huggingface.co/api/models/ggml-org/Qwen3-ASR-0.6B-GGUF/tree/main" \
  | python3 -c "import json,sys; [print(f['path'], f['size'], (f.get('lfs') or {}).get('oid')) for f in json.load(sys.stdin) if f['type']=='file']"
# 4) 顺手探 ModelScope 是否镜像了该 GGUF 仓库(国内备源;404 就算了,HF 实测直连顺畅):
curl -sIL "https://modelscope.cn/models/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/master/Qwen3-ASR-0.6B-Q8_0.gguf" | head -5
# 5) 检查 mac zip 内部结构(拍平解压要用):
python3 -c "import zipfile; [print(n) for n in zipfile.ZipFile('/tmp/mac.zip').namelist()]" | head -20
```
记录:最终 TAG、三个资产名+字节数+sha256、GGUF 两个 oid、ModelScope 探测结果、zip 内部布局(`llama-mtmd-cli` 在哪层、伴随哪些 dylib)。

- [ ] **Step 2: 依赖清理与新增**

`src-tauri/Cargo.toml`:删除 `sherpa-onnx = "1.13.4"` 与 `hound = "3.5"` 两行(`sha2` 保留);tokio 行改为:

```toml
tokio = { version = "1", features = ["macros", "rt-multi-thread", "sync", "time", "process"] }
```

然后 `cargo add zip --no-default-features --features deflate`(记录落到的版本)。
删除 `src-tauri/examples/qwen3_spike.rs`(数据已沉淀在 spec/报告;git 历史可回溯)。

Run: `cd src-tauri && cargo build 2>&1 | tail -3` → 通过(顺带确认 sherpa 的构建期静态库下载消失)。

- [ ] **Step 3: 写失败测试**

`src-tauri/src/local_asr.rs`:

```rust
//! Local Qwen3-ASR backend (provider "local"): on-demand assets (2 GGUF files
//! + a pinned llama.cpp release binary), resumable downloads, and
//! per-transcription subprocess inference via llama-mtmd-cli. No resident
//! engine: the subprocess exits after each transcription, so SayType's idle
//! memory is unchanged. See docs/superpowers/specs/2026-07-12-local-asr-qwen3-design.md.
use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

pub const LOCAL_PROVIDER: &str = "local";
pub const LOCAL_MODEL_ID: &str = "qwen3-asr-0.6b-q8_0";
/// Pinned llama.cpp release. Must stay ≥ b9173 (Qwen3-ASR repetition fix,
/// ggml-org/llama.cpp#22357). Upgrading requires re-verifying CLI flags,
/// stdout format, all sha256s, and a real-dictation regression.
pub const LLAMA_BUILD: &str = "<FILL-STEP-1>";

pub struct Asset {
  /// Final location under local_asr_dir(); doubles as the download's .part
  /// sibling name. Forward slashes are fine in PathBuf::join on Windows.
  pub rel_path: &'static str,
  /// Try in order (mirror fallback); byte-identical across sources.
  pub urls: &'static [&'static str],
  pub size: u64,
  pub sha256: &'static str,
}

const HF_BASE: &str = "https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/main/";

pub const MODEL_ASSETS: &[Asset] = &[
  Asset {
    rel_path: "models/Qwen3-ASR-0.6B-Q8_0.gguf",
    urls: &["<FILL: HF url; prepend ModelScope url if Step-1 probe hit 200>"],
    size: 804_749_248,
    sha256: "<FILL-STEP-1>",
  },
  Asset {
    rel_path: "models/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
    urls: &["<FILL>"],
    size: 214_392_480,
    sha256: "<FILL-STEP-1>",
  },
];

// One llama.cpp zip per platform; only the current platform's entry is used.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn llama_zip_asset() -> &'static Asset {
  &Asset {
    rel_path: "llama-macos-arm64.zip",
    urls: &["https://github.com/ggml-org/llama.cpp/releases/download/<TAG>/<mac-asset>"],
    size: 0, // FILL
    sha256: "<FILL-STEP-1>",
  }
}
// (win-x64 / linux-x64 同构的 cfg 版本,Step 1 的值填入;其余平台 compile_error! 不必——
//  Tauri 目标就这三个,给一个 #[cfg(not(...))] 的兜底返回 mac 值即可避免编译分叉?不:
//  兜底用 unreachable 是错的,直接三个 cfg 函数 + 无兜底,CI 三平台恰好覆盖。)

pub fn total_download_bytes() -> u64 {
  MODEL_ASSETS.iter().map(|a| a.size).sum::<u64>() + llama_zip_asset().size
}

pub fn local_asr_dir() -> Result<PathBuf> {
  Ok(crate::settings::app_data_dir()?.join("local-asr"))
}

pub fn bin_dir(base: &Path) -> PathBuf {
  base.join("bin").join(LLAMA_BUILD)
}

pub fn cli_path(base: &Path) -> PathBuf {
  let name = if cfg!(target_os = "windows") { "llama-mtmd-cli.exe" } else { "llama-mtmd-cli" };
  bin_dir(base).join(name)
}

/// Cheap readiness: every GGUF at its exact size, plus the extracted CLI
/// present (executable on unix). sha256 is verified once at download time.
pub fn assets_ready_at(dir: &Path) -> bool {
  let models_ok = MODEL_ASSETS.iter().all(|a| {
    fs::metadata(dir.join(a.rel_path)).map(|m| m.len() == a.size).unwrap_or(false)
  });
  let cli = cli_path(dir);
  let cli_ok = fs::metadata(&cli).map(|m| m.is_file()).unwrap_or(false)
    && is_executable(&cli);
  models_ok && cli_ok
}

pub fn assets_ready() -> bool {
  local_asr_dir().map(|d| assets_ready_at(&d)).unwrap_or(false)
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
  use std::os::unix::fs::PermissionsExt;
  fs::metadata(path).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
  true
}
```

> Step 3 的 `llama_zip_asset` 写法:const fn 不了就用返回 `&'static Asset` 的静态项(`static MAC_ZIP: Asset = ...; #[cfg] pub fn llama_zip_asset() -> &'static Asset { &MAC_ZIP }`),三平台三个 `static` + 三个同名 cfg 函数。

tests(同文件):

```rust
#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn manifest_is_filled_and_totals_are_sane() {
    assert_eq!(MODEL_ASSETS.len(), 2);
    for a in MODEL_ASSETS.iter().chain(std::iter::once(llama_zip_asset())) {
      assert_eq!(a.sha256.len(), 64, "{} sha256 must be real", a.rel_path);
      assert!(a.size > 0, "{} size must be real", a.rel_path);
      assert!(!a.urls.is_empty());
    }
    let total = total_download_bytes();
    // ~1.02GB models + a 10-80MB zip
    assert!(total > 1_020_000_000 && total < 1_150_000_000, "total = {total}");
    assert_ne!(LLAMA_BUILD, "<FILL-STEP-1>");
  }

  #[test]
  fn assets_ready_requires_models_at_exact_size_and_an_executable_cli() {
    let temp = tempfile::TempDir::new().unwrap();
    let dir = temp.path();
    assert!(!assets_ready_at(dir));
    for a in MODEL_ASSETS {
      let p = dir.join(a.rel_path);
      fs::create_dir_all(p.parent().unwrap()).unwrap();
      fs::File::create(&p).unwrap().set_len(a.size).unwrap(); // sparse, fast
    }
    assert!(!assets_ready_at(dir), "still missing the cli binary");
    let cli = cli_path(dir);
    fs::create_dir_all(cli.parent().unwrap()).unwrap();
    fs::write(&cli, b"#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      // Not executable yet -> not ready on unix.
      assert!(!assets_ready_at(dir));
      fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert!(assets_ready_at(dir));
    // Truncate one model -> not ready.
    fs::File::create(dir.join(MODEL_ASSETS[0].rel_path)).unwrap().set_len(1).unwrap();
    assert!(!assets_ready_at(dir));
  }
}
```

`lib.rs` 模块声明区加 `mod local_asr;`。

Run: `cargo test local_asr 2>&1 | tail -8` → `manifest_is_filled...` FAIL(占位符)——刻意:测试逼着填真值。

- [ ] **Step 4: 填入 Step 1 的真值,重跑至绿**

Run: `cargo test local_asr` → 全 PASS;`cargo test 2>&1 | tail -3` → 全绿(42+2)。

- [ ] **Step 5: Commit**

```bash
git add -A src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/examples src-tauri/src/local_asr.rs src-tauri/src/lib.rs
git commit -m "feat(local-asr): asset manifest + readiness; drop sherpa spike leftovers for the llama.cpp route"
```

---

### Task 3: 子进程转写执行器

**Files:**
- Modify: `src-tauri/src/local_asr.rs`(追加 runner)
- Test: 同文件 `#[cfg(test)]` + 一个 `#[ignore]` 真资产冒烟

**Interfaces:**
- Consumes: Task 2 的 `assets_ready_at/cli_path/local_asr_dir/MODEL_ASSETS`
- Produces:
  - `local_asr::transcribe_wav(wav_bytes: &[u8]) -> anyhow::Result<String>`(async;**取消安全靠 drop**:上层 `tokio::select!` 丢弃本 future 时,子进程被 `kill_on_drop` 杀死、临时文件被 guard 清理)
  - `local_asr::parse_mtmd_output(stdout: &str) -> String`(纯函数)
  - 错误哨兵:资产缺失时错误信息以 `LOCAL_MODEL_MISSING` 开头(Task 5 映射成用户可读提示)

- [ ] **Step 1: 采一份真实 stdout 样本(写解析器和测试用)**

前提:把 benchmark 留在 scratchpad 的 GGUF 和 Step-1 下载的 mac zip 手动摆进正式布局(这也是 Task 9 之前本机就绪的方式):

```bash
BASE="$HOME/Library/Application Support/com.tao.saytype/local-asr"
mkdir -p "$BASE/models" "$BASE/bin/<TAG>"
SCRATCH=/private/tmp/claude-501/-Users-tao-code-OpenClaw-Code-SayType/636cce3e-1ba1-4506-a3bd-633e7960a712/scratchpad
cp "$SCRATCH/llamacpp-gguf/"*.gguf "$BASE/models/"
python3 - <<'EOF'
import zipfile, os, stat
z = zipfile.ZipFile('/tmp/mac.zip')
dst = os.path.expanduser('~/Library/Application Support/com.tao.saytype/local-asr/bin/<TAG>')
for info in z.infolist():
    if info.is_dir(): continue
    name = os.path.basename(info.filename)
    if not name: continue
    with z.open(info) as src, open(os.path.join(dst, name), 'wb') as out:
        out.write(src.read())
    os.chmod(os.path.join(dst, name), 0o755)
EOF
# 真跑一把,把 stdout/stderr 分开留档:
"$BASE/bin/<TAG>/llama-mtmd-cli" -m "$BASE/models/Qwen3-ASR-0.6B-Q8_0.gguf" \
  --mmproj "$BASE/models/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf" \
  --audio <某个 16k mono wav> -p "a" -c 2048 >/tmp/mtmd.out 2>/tmp/mtmd.err
cat -A /tmp/mtmd.out | head -20   # 看清前缀/换行/是否有别的噪音
```
把**逐字节样本**(含静音输入的一份:`language None<asr_text>` 形态)记进报告——Step 2 的单测直接用它们。若拍平解压后 cli 因 dylib 路径起不来(rpath 问题),记录 `otool -L` 输出并改用"保留 zip 原目录层级解压"的方案(同样记录,Task 4 跟随)。

- [ ] **Step 2: 写失败测试**(解析器,样本用 Step 1 实录的逐字节文本替换下面的示意)

```rust
  #[test]
  fn parse_extracts_text_after_the_asr_marker() {
    let sample = "language Chinese<asr_text>你好，欢迎使用听写工具。\n"; // ← 换成 Step-1 实录
    assert_eq!(parse_mtmd_output(sample), "你好，欢迎使用听写工具。");
  }

  #[test]
  fn parse_silence_yields_empty() {
    let sample = "language None<asr_text>\n"; // ← 换成 Step-1 实录
    assert_eq!(parse_mtmd_output(sample), "");
  }

  #[test]
  fn parse_without_marker_falls_back_to_trimmed_whole() {
    assert_eq!(parse_mtmd_output("  plain text out  \n"), "plain text out");
    assert_eq!(parse_mtmd_output(""), "");
  }
```

Run: `cargo test local_asr::tests::parse 2>&1 | tail -5` → FAIL(未定义)。

- [ ] **Step 3: 实现 runner**

```rust
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// Hard ceiling on one decode. Metal does ~60s audio in ~3s; even a 13-min
/// clip (the 25MB WAV cap) at CPU speeds fits comfortably under this.
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(180);
/// MUST be passed explicitly: the model metadata declares ctx 65536 and the
/// CLI default ("0" = from model) preallocates a 7 GiB KV cache (measured).
const CTX_SIZE: &str = "2048";

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Removes the temp WAV on drop — including when the whole transcribe future
/// is dropped by the caller's tokio::select! on cancellation.
struct TempFile(PathBuf);
impl Drop for TempFile {
  fn drop(&mut self) {
    let _ = fs::remove_file(&self.0);
  }
}

/// Extract the transcription from llama-mtmd-cli stdout. The ASR chat
/// template emits `language <lang><asr_text>TEXT`; silence comes back as
/// `language None<asr_text>` with empty text. If the marker is ever absent
/// (format drift on a llama upgrade), fall back to the trimmed whole output
/// so dictations degrade instead of vanishing.
pub fn parse_mtmd_output(stdout: &str) -> String {
  match stdout.rfind("<asr_text>") {
    Some(idx) => stdout[idx + "<asr_text>".len()..].trim().to_string(),
    None => stdout.trim().to_string(),
  }
}

/// Run one transcription in a llama-mtmd-cli subprocess. Cancellation-safe
/// by construction: dropping this future kills the child (kill_on_drop) and
/// removes the temp file (TempFile guard).
pub async fn transcribe_wav(wav_bytes: &[u8]) -> Result<String> {
  let base = local_asr_dir()?;
  if !assets_ready_at(&base) {
    anyhow::bail!("LOCAL_MODEL_MISSING: local model assets are missing or incomplete");
  }

  let tmp_path = std::env::temp_dir().join(format!(
    "saytype-asr-{}-{}.wav",
    std::process::id(),
    TMP_SEQ.fetch_add(1, Ordering::Relaxed)
  ));
  fs::write(&tmp_path, wav_bytes)
    .with_context(|| format!("failed to write temp audio {}", tmp_path.display()))?;
  let _tmp = TempFile(tmp_path.clone());

  let started = std::time::Instant::now();
  let child = tokio::process::Command::new(cli_path(&base))
    .arg("-m").arg(base.join(MODEL_ASSETS[0].rel_path))
    .arg("--mmproj").arg(base.join(MODEL_ASSETS[1].rel_path))
    .arg("--audio").arg(&tmp_path)
    .arg("-p").arg("a")
    .arg("-c").arg(CTX_SIZE)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true)
    .spawn()
    .context("failed to start llama-mtmd-cli")?;

  let output = tokio::time::timeout(TRANSCRIBE_TIMEOUT, child.wait_with_output())
    .await
    .map_err(|_| anyhow::anyhow!("local ASR timed out after {}s", TRANSCRIBE_TIMEOUT.as_secs()))?
    .context("failed to run llama-mtmd-cli")?;

  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
    anyhow::bail!("llama-mtmd-cli failed ({}): {last}", output.status);
  }

  let text = parse_mtmd_output(&String::from_utf8_lossy(&output.stdout));
  // Counts only — no transcribed text in logs.
  log::info!(
    "local ASR: decoded {} KB wav in {:.2}s ({} chars)",
    wav_bytes.len() / 1024,
    started.elapsed().as_secs_f32(),
    text.chars().count()
  );
  Ok(text)
}
```

Run: `cargo test local_asr 2>&1 | tail -8` → parse 三测 PASS。

- [ ] **Step 4: 真资产冒烟(#[ignore],CI 不跑)**

```rust
  /// Needs the real assets laid out (Task 3 Step 1). Run manually:
  ///   cargo test real_subprocess_smoke -- --ignored --nocapture
  #[test]
  #[ignore]
  fn real_subprocess_smoke() {
    assert!(assets_ready(), "lay out the assets first (plan Task 3 Step 1)");
    let rt = tokio::runtime::Runtime::new().unwrap();
    // 0.5s of silence WAV (44-byte header + zeros), built inline.
    let mut wav = Vec::new();
    let data_len = 16000u32; // 0.5s * 16000Hz * 2 bytes
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());          // PCM
    wav.extend_from_slice(&1u16.to_le_bytes());          // mono
    wav.extend_from_slice(&16000u32.to_le_bytes());      // rate
    wav.extend_from_slice(&32000u32.to_le_bytes());      // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes());          // block align
    wav.extend_from_slice(&16u16.to_le_bytes());         // bits
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.resize(wav.len() + data_len as usize, 0);
    let text = rt.block_on(transcribe_wav(&wav)).expect("subprocess ok");
    assert_eq!(text, "", "silence must yield empty text");
    // Temp file cleaned up:
    let leftovers = fs::read_dir(std::env::temp_dir()).unwrap()
      .filter_map(|e| e.ok())
      .filter(|e| e.file_name().to_string_lossy().starts_with("saytype-asr-"))
      .count();
    assert_eq!(leftovers, 0, "temp wav files must be removed");
  }
```

Run: `cargo test real_subprocess_smoke -- --ignored --nocapture` → PASS(本机)。

- [ ] **Step 5: 全量测试 + Commit**

```bash
cargo test 2>&1 | tail -3   # 全绿
git add src-tauri/src/local_asr.rs
git commit -m "feat(local-asr): per-transcription llama-mtmd-cli subprocess runner (kill-on-drop cancel, temp-file guard)"
```

---

### Task 4: 资产下载器 + 4 个 IPC 命令 + 进度事件

**Files:**
- Modify: `src-tauri/src/local_asr.rs`(download/extract/status/delete)
- Modify: `src-tauri/src/state.rs`(加 `local_model_download` 槽)
- Modify: `src-tauri/src/commands.rs`(4 个新命令)
- Modify: `src-tauri/src/lib.rs:146-174`(注册)
- Modify: `src/views/ipc-bridge.js:15-43`(映射)

**Interfaces:**
- Consumes: Task 2 清单;Task 3 无依赖(下载先于转写可用)
- Produces:
  - `local_asr::ModelStatus { state, downloaded_bytes, total_bytes }`(serde camelCase;state ∈ `"ready"|"downloading"|"partial"|"absent"`)
  - `local_asr::model_status(downloading: bool) -> ModelStatus`
  - `local_asr::download_model(app, cancel) -> Result<(), String>`(Err `"DOWNLOAD_CANCELLED"` 表取消;完成含 zip 解压+置 +x)
  - `local_asr::delete_model() -> Result<(), String>`(整个 local-asr 目录)
  - `AppState.local_model_download: Mutex<Option<CancellationToken>>`
  - 命令:`download_local_model` / `cancel_local_model_download` / `get_local_model_status` / `delete_local_model`
  - 事件 `local-model-download-progress`,payload `{ state, downloadedBytes, totalBytes, message? }`,state ∈ `downloading|ready|cancelled|error`

- [ ] **Step 1: 写失败测试**

```rust
  #[test]
  fn model_status_reports_absent_partial_ready() {
    let temp = tempfile::TempDir::new().unwrap();
    let dir = temp.path();
    let s = model_status_at(dir, false);
    assert_eq!(s.state, "absent");
    assert_eq!(s.total_bytes, total_download_bytes());
    assert_eq!(s.downloaded_bytes, 0);

    // One finished GGUF + one .part -> partial, bytes add up.
    let a0 = &MODEL_ASSETS[0];
    let p = dir.join(a0.rel_path);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::File::create(&p).unwrap().set_len(a0.size).unwrap();
    let part = dir.join(format!("{}.part", MODEL_ASSETS[1].rel_path));
    fs::create_dir_all(part.parent().unwrap()).unwrap();
    fs::File::create(&part).unwrap().set_len(1000).unwrap();
    let s = model_status_at(dir, false);
    assert_eq!(s.state, "partial");
    assert_eq!(s.downloaded_bytes, a0.size + 1000);

    assert_eq!(model_status_at(dir, true).state, "downloading");

    // Everything in place (incl. executable cli) -> ready. The zip itself is
    // deleted after extraction, so "ready" ignores it; its bytes count as
    // downloaded when the cli exists.
    for a in MODEL_ASSETS {
      let p = dir.join(a.rel_path);
      fs::create_dir_all(p.parent().unwrap()).unwrap();
      fs::File::create(&p).unwrap().set_len(a.size).unwrap();
    }
    let cli = cli_path(dir);
    fs::create_dir_all(cli.parent().unwrap()).unwrap();
    fs::write(&cli, b"x").unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let s = model_status_at(dir, false);
    assert_eq!(s.state, "ready");
    assert_eq!(s.downloaded_bytes, s.total_bytes);
  }
```

Run: `cargo test model_status 2>&1 | tail -5` → FAIL(`model_status_at` 未定义)。

- [ ] **Step 2: 实现 status / 下载 / 解压 / 删除**

```rust
use serde::Serialize;
use sha2::Digest;
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

/// Emit a progress event at most every this many bytes.
const PROGRESS_EMIT_STEP: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
  pub state: String,
  pub downloaded_bytes: u64,
  pub total_bytes: u64,
}

pub fn model_status(downloading: bool) -> ModelStatus {
  match local_asr_dir() {
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
  let zip = llama_zip_asset();
  // Model files count by exact size; the zip counts as fully downloaded once
  // the extracted CLI exists (the archive is removed after extraction).
  for a in MODEL_ASSETS {
    let got = fs::metadata(dir.join(a.rel_path)).map(|m| m.len()).unwrap_or(0);
    if got == a.size {
      downloaded += a.size;
    } else {
      complete = false;
      downloaded += got.min(a.size);
      if let Ok(m) = fs::metadata(dir.join(format!("{}.part", a.rel_path))) {
        downloaded += m.len().min(a.size);
      }
    }
  }
  let cli = cli_path(dir);
  if fs::metadata(&cli).map(|m| m.is_file()).unwrap_or(false) && is_executable(&cli) {
    downloaded += zip.size;
  } else {
    complete = false;
    if let Ok(m) = fs::metadata(dir.join(format!("{}.part", zip.rel_path))) {
      downloaded += m.len().min(zip.size);
    } else if let Ok(m) = fs::metadata(dir.join(zip.rel_path)) {
      downloaded += m.len().min(zip.size);
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

/// Download all missing assets (resumable), verify sha256, extract the llama
/// zip, mark the CLI executable. Terminal events are emitted by the COMMAND.
pub async fn download_model(app: tauri::AppHandle, cancel: CancellationToken) -> Result<(), String> {
  let dir = local_asr_dir().map_err(|e| e.to_string())?;
  let client = reqwest::Client::builder()
    .connect_timeout(std::time::Duration::from_secs(15))
    .build()
    .map_err(|e| e.to_string())?;

  let mut done: u64 = 0;
  for a in MODEL_ASSETS {
    if fs::metadata(dir.join(a.rel_path)).map(|m| m.len() == a.size).unwrap_or(false) {
      done += a.size;
      continue;
    }
    download_asset(&app, &client, &dir, a, &cancel, done).await?;
    done += a.size;
    emit_progress(&app, "downloading", done, None);
  }

  let zip = llama_zip_asset();
  if !(fs::metadata(cli_path(&dir)).map(|m| m.is_file()).unwrap_or(false) && is_executable(&cli_path(&dir))) {
    let zip_final = dir.join(zip.rel_path);
    if !fs::metadata(&zip_final).map(|m| m.len() == zip.size).unwrap_or(false) {
      download_asset(&app, &client, &dir, zip, &cancel, done).await?;
    }
    let dir2 = dir.clone();
    tokio::task::spawn_blocking(move || extract_llama_zip(&dir2))
      .await
      .map_err(|e| e.to_string())??;
    let _ = fs::remove_file(&zip_final); // archive no longer needed
  }
  Ok(())
}

/// Extract every regular file in the archive, flattened to its basename, into
/// bin/<LLAMA_BUILD>/, and mark all of them executable on unix (the CLI needs
/// it; the bundled dylibs don't care). Flattening keeps us independent of the
/// zip's top-level folder naming across llama.cpp releases — adjust ONLY if
/// the Task-3 Step-1 rpath check demanded preserved structure.
fn extract_llama_zip(base: &Path) -> Result<(), String> {
  let zip_path = base.join(llama_zip_asset().rel_path);
  let out_dir = bin_dir(base);
  fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
  let file = fs::File::open(&zip_path).map_err(|e| e.to_string())?;
  let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
  for i in 0..archive.len() {
    let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
    if entry.is_dir() {
      continue;
    }
    let Some(name) = Path::new(entry.name()).file_name().map(|n| n.to_owned()) else { continue };
    let out_path = out_dir.join(name);
    let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
    std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(&out_path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
  }
  if !fs::metadata(cli_path(base)).map(|m| m.is_file()).unwrap_or(false) {
    return Err("archive did not contain llama-mtmd-cli".into());
  }
  Ok(())
}

async fn download_asset(
  app: &tauri::AppHandle,
  client: &reqwest::Client,
  dir: &Path,
  asset: &Asset,
  cancel: &CancellationToken,
  done_bytes: u64,
) -> Result<(), String> {
  let part_path = dir.join(format!("{}.part", asset.rel_path));
  if let Some(parent) = part_path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }

  let mut last_err = String::new();
  for url in asset.urls {
    if cancel.is_cancelled() {
      return Err("DOWNLOAD_CANCELLED".into());
    }
    let offset = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    let offset = if offset > asset.size { 0 } else { offset };
    match stream_to_part(app, client, url, &part_path, offset, asset, cancel, done_bytes).await {
      Ok(()) => {
        let got = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
        if got != asset.size {
          last_err = format!("{}: size mismatch {got} != {}", asset.rel_path, asset.size);
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
        if hash != asset.sha256 {
          last_err = format!("{}: sha256 mismatch", asset.rel_path);
          let _ = fs::remove_file(&part_path);
          continue;
        }
        fs::rename(&part_path, dir.join(asset.rel_path)).map_err(|e| e.to_string())?;
        return Ok(());
      }
      Err(err) if err == "DOWNLOAD_CANCELLED" => return Err(err),
      Err(err) => {
        // Keep the .part — the next source (byte-identical) resumes it.
        last_err = format!("{url}: {err}");
        log::warn!("asset download source failed: {last_err}");
      }
    }
  }
  Err(format!("failed to download {}: {last_err}", asset.rel_path))
}

#[allow(clippy::too_many_arguments)]
async fn stream_to_part(
  app: &tauri::AppHandle,
  client: &reqwest::Client,
  url: &str,
  part_path: &Path,
  offset: u64,
  asset: &Asset,
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
      emit_progress(app, "downloading", done_bytes + written.min(asset.size), None);
    }
  }
  out.flush().map_err(|e| e.to_string())?;
  Ok(())
}

/// Settings "delete model": remove the whole local-asr dir (models + bin).
/// No engine unload needed — nothing is resident between transcriptions.
pub fn delete_model() -> Result<(), String> {
  let dir = local_asr_dir().map_err(|e| e.to_string())?;
  match fs::remove_dir_all(&dir) {
    Ok(()) => Ok(()),
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(err) => Err(err.to_string()),
  }
}
```

Run: `cargo test local_asr 2>&1 | tail -8` → 全 PASS。

- [ ] **Step 3: AppState 槽位**

`src-tauri/src/state.rs` 的 struct 加一个字段(其余不动):

```rust
  /// Cancellation token of the in-flight local-model download, if any
  /// (single-flight guard for download_local_model).
  pub local_model_download: Mutex<Option<CancellationToken>>,
```

`Default` impl 里对应加 `local_model_download: Mutex::new(None),`。

- [ ] **Step 4: 命令层**(`commands.rs` 追加,`save_dictionary` 之后)

```rust
// --- Local ASR asset management (settings window) ---

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

  let status = crate::local_asr::model_status(false);
  match result {
    Ok(()) => {
      let _ = app.emit(
        "local-model-download-progress",
        json!({ "state": "ready", "downloadedBytes": status.downloaded_bytes, "totalBytes": status.total_bytes }),
      );
      Ok(true)
    }
    Err(err) if err == "DOWNLOAD_CANCELLED" => {
      let _ = app.emit(
        "local-model-download-progress",
        json!({ "state": "cancelled", "downloadedBytes": status.downloaded_bytes, "totalBytes": status.total_bytes }),
      );
      Ok(false)
    }
    Err(err) => {
      let _ = app.emit(
        "local-model-download-progress",
        json!({ "state": "error", "downloadedBytes": status.downloaded_bytes, "totalBytes": status.total_bytes, "message": err }),
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
  crate::local_asr::delete_model()?;
  Ok(true)
}
```

- [ ] **Step 5: 三处同步的另两处**

`lib.rs` `invoke_handler!`(`commands::save_onboarding_api_key,` 后)追加:

```rust
      commands::download_local_model,
      commands::cancel_local_model_download,
      commands::get_local_model_status,
      commands::delete_local_model,
```

`ipc-bridge.js` `tauriCommands`(`"save-onboarding-api-key"` 行后)追加(全部无参,不动 `tauriArgs`):

```js
    "download-local-model": "download_local_model",
    "cancel-local-model-download": "cancel_local_model_download",
    "get-local-model-status": "get_local_model_status",
    "delete-local-model": "delete_local_model",
```

- [ ] **Step 6: 全量测试 + Commit**

```bash
cargo test 2>&1 | tail -3 && cargo build 2>&1 | tail -3
git add src-tauri/src/local_asr.rs src-tauri/src/state.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/views/ipc-bridge.js
git commit -m "feat(local-asr): resumable asset downloader (GGUFs + pinned llama.cpp zip) + IPC commands"
```

---

### Task 5: 转写路由 — local 分支、翻译回退云端、has_api_key 语义

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/settings.rs`
- Test: 两文件 `#[cfg(test)]`

**Interfaces:**
- Consumes: Task 3 `local_asr::transcribe_wav`(async,drop 即取消)、哨兵 `LOCAL_MODEL_MISSING`;Task 2 `assets_ready`
- Produces:
  - `commands::TranscriptionRoute { Local, Cloud { provider: &'static str, api_key: String } }`
  - `commands::resolve_transcription_route(config: &AppConfig, translate_mode: bool) -> Result<TranscriptionRoute, String>`
  - `settings::SettingsPayload::from_config_with(config, local_model_ready: bool) -> Self`(`from_config` 变薄壳)
  - `settings::local_provider_selectable(provider: &str, model_ready: bool) -> Result<(), String>`
  - `perform_transcription_request` 新签名:`(client, config, provider: &str, api_key, audio_buffer, translate_mode, mime_type)`

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
    config.provider = "groq".into();
    config.api_key_groq = "gsk".into();
    assert!(SettingsPayload::from_config_with(&config, false).has_api_key);
  }

  #[test]
  fn local_provider_selectable_requires_downloaded_assets() {
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
    Self::from_config_with(config, crate::local_asr::assets_ready())
  }

  /// `local_model_ready` injected for tests (assets_ready() reads the real
  /// app data dir). For provider=="local", has_api_key means "the selected
  /// provider is usable" — assets downloaded — so the readiness UI works
  /// unchanged.
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

新增(`normalize_record_shortcut` 附近):

```rust
/// Server-side guard behind the settings UI: provider "local" may only be
/// saved once the assets are fully downloaded (the UI also enforces this, but
/// a stale window must not be able to persist an unusable config).
pub fn local_provider_selectable(provider: &str, model_ready: bool) -> Result<(), String> {
  if provider == crate::local_asr::LOCAL_PROVIDER && !model_ready {
    return Err("Local model is not downloaded yet — download it in Settings → Models first.".into());
  }
  Ok(())
}
```

- [ ] **Step 3: commands.rs 实现**

路由(`build_transcription_prompt` 附近):

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

/// Local decode: hand the (frontend-guaranteed) WAV to the subprocess runner.
/// Lives inside the caller's tokio::select! — dropping this future kills the
/// child process (kill_on_drop), so cancel truly aborts the decode.
async fn perform_local_transcription(audio_buffer: Vec<u8>, mime_type: &str) -> Result<String> {
  if !mime_type.contains("wav") {
    return Err(anyhow::anyhow!(
      "local transcription expects WAV audio, got {mime_type} (frontend must re-encode)"
    ));
  }
  crate::local_asr::transcribe_wav(&audio_buffer).await.map_err(|err| {
    if err.to_string().starts_with("LOCAL_MODEL_MISSING") {
      anyhow::anyhow!("Local model files are missing — download the model again in Settings.")
    } else {
      err
    }
  })
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
  let result = tokio::select! {
    _ = cancellation.cancelled() => Err(anyhow::anyhow!("TRANSCRIPTION_CANCELLED")),
    result = async {
      match &route {
        TranscriptionRoute::Local => perform_local_transcription(audio_buffer, &mime).await,
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
  settings::local_provider_selectable(&config.provider, crate::local_asr::assets_ready())
    .map_err(stringify_error)?;
  if config.provider == crate::local_asr::LOCAL_PROVIDER {
    // The form's key fields are hidden for the local provider; keep the stored
    // legacy key instead of clobbering it with the (empty) local selection.
    config.api_key = existing.api_key.clone();
  } else {
    config.api_key = settings::selected_api_key(&config);
  }
```

- [ ] **Step 4: 跑测试 + Commit**

```bash
cargo test 2>&1 | tail -5   # 全绿,含既有 settings/commands 测试
git add src-tauri/src/commands.rs src-tauri/src/settings.rs
git commit -m "feat(local-asr): route transcription local/cloud; translate falls back to cloud; assets drive hasApiKey"
```

---

### Task 6: 前端音频通路 — local 模式恒发 WAV + 模型徽章

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
const LOCAL_MODEL_ID = "qwen3-asr-0.6b-q8_0";
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

- [ ] **Step 4: Node 测试 + Commit**

```bash
node src/views/vad-decision.test.mjs   # 既有 14 测全 PASS(纯函数未动)
git add src/views/vad-gate.js src/views/input-prompt.js
git commit -m "feat(local-asr): always upload 16k mono WAV in local mode; Qwen3 model badge"
```

---

### Task 7: 设置 UI(本地模型面板 + 下载进度)+ i18n + readiness 文案

**Files:**
- Modify: `src/views/settings.html:248-289`
- Modify: `src/views/settings.js`
- Modify: `src/views/main.js:462-470`
- Modify: `src/views/i18n.js`(en + zh)

**Interfaces:**
- Consumes: Task 4 的 4 个 IPC 命令与 `local-model-download-progress` 事件;`get-settings` 的 `hasApiKey` local 语义(Task 5)

- [ ] **Step 1: settings.html**

`providerSelect` 加选项:

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
    { value: "qwen3-asr-0.6b-q8_0", labelKey: "settings.model.options.qwen3AsrLocal", recommended: false },
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
    renderLocalModelPanel({ state: "downloading", downloadedBytes: 0, totalBytes: 1 });
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
    if (payload.state === "downloading") {
      renderLocalModelPanel({
        state: "downloading",
        downloadedBytes: payload.downloadedBytes || 0,
        totalBytes: payload.totalBytes || 0,
      });
    } else {
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

行 466-469 的 API key pill 改为(以文件实际调用形态为准,仅换 label 表达式):

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

- [ ] **Step 6: 验证 + Commit**

```bash
node src/views/vad-decision.test.mjs   # PASS
# 静态冒烟(CLAUDE.md 验证 gotcha):
python3 -m http.server 1430 -d src/views &
# 浏览器开 settings.html:provider 下拉有第三项;选 local 时 key 字段隐藏、#localModelItem 显示;
# console 手动 renderLocalModelPanel({state:"absent",downloadedBytes:0,totalBytes:1050000000}) 驱动各状态。
git add src/views/settings.html src/views/settings.js src/views/main.js src/views/i18n.js
git commit -m "feat(local-asr): settings panel for asset download/progress/delete + i18n"
```

---

### Task 8: 文档同步 + CI 核查

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md**

架构小节 `platform/` 条目后加:

```markdown
- `local_asr.rs` — the local transcription backend (provider `"local"`): Qwen3-ASR-0.6B
  Q8_0 GGUF run by a **per-transcription `llama-mtmd-cli` subprocess** (pinned llama.cpp
  release, `LLAMA_BUILD`); the process exits after each decode, so idle memory is
  unchanged and cancel = kill (kill_on_drop). Owns the asset manifest (2 GGUFs +
  per-platform llama.cpp zip, ~1GB under `<app-data>/local-asr/`), the resumable
  sha256-gated downloader, and the stdout parser (`language <lang><asr_text>` prefix).
  **Invocation invariants:** `-c 2048` is mandatory (the model metadata's ctx 65536
  otherwise preallocates a 7GiB KV cache) and `-p "a"` is mandatory (empty prompt hangs
  in interactive mode). Translate mode never runs locally — it falls back to a
  configured cloud key (Groq preferred). The frontend always uploads 16 kHz mono WAV in
  local mode (`vad-gate.js` forceWav/encodeFullWav) because mtmd's miniaudio decoder
  doesn't read AAC/m4a. `SettingsPayload.has_api_key` means "assets downloaded" when
  provider is local. The language setting and dictionary do not apply to the local
  provider (auto-detect only; documented v1 limits). Engine benchmarks and the
  sherpa-onnx retreat path live in docs/superpowers/specs/2026-07-12-local-asr-qwen3-design.md.
```

- [ ] **Step 2: CI 核查 + Commit**

CI 预期零改动(llama.cpp 是运行时下载工件,不参与编译)。push 后看三条腿绿灯(移除 sherpa 后构建应更快)。

```bash
git add CLAUDE.md
git commit -m "docs: document the llama.cpp-subprocess local ASR backend"
git push
```

---

### Task 9: 真机端到端验证(手动清单)

**前提:** `npm run build:mac:install` 装最新构建;**先清掉手动摆的资产走全新下载**:`rm -rf ~/Library/Application\ Support/com.tao.saytype/local-asr`(注意 spike 时代的 `models/qwen3-asr-0.6b-int8` ONNX 目录也顺手删了,已无用)。

- [ ] 1. 设置 → Models:provider 下拉出现"Local · Qwen3-ASR";选中后 key 字段消失、面板显示"未下载(约 1.05 GB)";此时点保存被拦(提示先下载)。
- [ ] 2. 点"下载模型":进度条走动;**中途取消** → "下载中断 — 可从断点继续";**继续下载** → 字节数不清零(断点续传生效);完成 → "已就绪"(zip 已解压、归档已删)。日志无报错。
- [ ] 3. 保存(provider=local)成功;主窗 readiness 显示"本地模型"pill 绿。
- [ ] 4. 中文听写(短句):小窗徽章 **Qwen3 · Local** → 文字插入目标应用。日志:`local ASR: decoded … KB wav in …s (… chars)`。体感等待 ~1–2s。
- [ ] 5. 长独白(60–90s):完整无截断,等待 ~3–6s(Metal RTF ~0.05–0.1)。
- [ ] 6. **内存与进程卫生**:转写中 `ps aux | grep mtmd` 能看到子进程;转写完立即消失;Activity Monitor 里 SayType 本体内存与未用本地模型时相同;`ls /tmp/saytype-asr-*` 无残留临时 WAV。
- [ ] 7. **转写中取消**(录音后立刻 Esc):小窗"已取消",`grep mtmd` 无残留进程(kill_on_drop 生效)。
- [ ] 8. 翻译模式(Shift+Alt):有 Groq key 时走云端照常;清掉两个云 key 再试 → 明确报错"Translation needs a cloud API key…"。
- [ ] 9. 删除模型:确认框 → 面板回"未下载";provider 仍 local 时听写 → 报"Local model files are missing…";保存被拦;切回 Groq 一切照旧。
- [ ] 10. 回归:云端 provider 听写、翻译、词典、历史、插入失败复制按钮全部照旧。
- [ ] 11. (可选)机器忙时转写:开个大编译再听写,确认速度不明显劣化(Metal 不吃 CPU 争抢)。
- [ ] 12. 全部通过后与用户对一遍:质量真实体感(同音字/幻觉观察)、是否把"本地 ASR 后续"(dictionary biasing、1.7B、量化对比)补进 TODO.md。

---

## Self-Review 结论(rev2 写完后自查)

- **Spec 覆盖(对照 rev 2026-07-13)**:§1 settings(T5/T7)、§2 三职责(T2 清单/T4 下载/T3 子进程)、§3 路由+WAV 前置(T5/T6)、§4 下载 UX(T4/T7)、§5 边界(翻译 T5、dictionary/语言不支持=无代码即正确、徽章 T6、SEED 不发)、§6 错误(sha256/续传 T4、缺资产映射 T5、无静默回退)、§7 测试(各任务+T3 冒烟+T9 E2E、sherpa 清理=T2)、§8 CI 归零(T8 验证)。无缺口。
- **占位符**:T2 的 `<FILL-STEP-1>` 是刻意步骤设计(Step 1 给精确获取命令,测试逼填真值);T3 的 stdout 样本明确要求用 Step 1 实录替换。非缺口。
- **类型一致性**:`transcribe_wav(&[u8]) -> Result<String>` T3 定义 T5 消费;`ModelStatus` camelCase 与 T7 前端字段一致;事件名/命令名 T4 定义 T7 消费一致;`assets_ready` 贯穿 T2/T5;取消语义(drop=kill)在 T3 定义、T5 的 select! 正确利用。
- **已知不确定点(有兜底)**:llama zip 内部布局与 rpath(T3 Step 1 实测,拍平不行就保层级);win/linux 资产变体名(T2 Step 1 从 release API 取真名);ModelScope 是否镜像 GGUF(探测,可选)。
