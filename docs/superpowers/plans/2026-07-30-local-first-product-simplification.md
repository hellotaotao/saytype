# SayType Local-first 产品收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 SayType 从三个平级 provider 和两个录音动作，收敛为设备感知的 Local-first 单一听写产品，同时保留 `v1.8.1` 已交付的录音可靠性、Accessibility 引导、跨屏定位、pending recovery 与跨平台 raw IPC。

**Architecture:** 分五个可独立验证的提交批次实施。先补 Local ASR 并发与子进程生命周期安全，再把 provider 固定到 recording session 并完整删除 translation；只有这两层稳定后，才启用设备感知 fresh default、重构 onboarding/settings/home/tray，最后收敛 Dictionary、README 与真机验证。

**Tech Stack:** Rust / Tokio / Tauri 2 / 原生 HTML、CSS、JavaScript / Node `node:test`

---

## 先做什么

建议现在只执行前两个批次，然后停下来做一次真实听写回归：

| 顺序 | 批次 | 风险 | 用户可见变化 | 为什么先做 |
|---|---|---:|---|---|
| 1 | Local ASR release gates | 低至中 | 无 | 不改变产品选择，只防止默认 Local 后出现多模型进程和无界等待 |
| 2 | 单一听写路由 + 删除 translation | 中 | 第二快捷键消失 | 先减少状态和路由数量，为后续 UI 与默认值清场 |
| 3 | fresh default + `engineReady` | 中 | Apple Silicon 新装真实选择 Local | 到这里才改变新用户默认，依赖前两批安全地基 |
| 4 | Local/Cloud 两层 UI | 高 | onboarding、Settings、首页、托盘整体变化 | 面积最大，放在后面避免底层问题与 UI 问题混在一起 |
| 5 | Dictionary、README、发布验证 | 中 | 对外叙事完成 | 最后根据真实 UI 和行为写文案，避免文档先于产品 |

**Checkpoint:** Batch 1 和 Batch 2 完成后暂停，不直接继续 Batch 3。用当前真实录音、连续录音、pending recovery、多屏提示和 Windows raw IPC 基线确认没有回归，再决定是否启用 fresh Local default。

## 本轮明确不做

- 不实施 `docs/superpowers/specs/2026-07-22-local-asr-long-audio-chunking-design.md`；
- 不引入 AudioWorklet/RealTimeVAD chunking；
- 不修改 Accessibility drag cloud 的核心实现；
- 不重写 input prompt 跨屏定位算法；
- 不新增本地失败后的 cloud fallback；
- 不把 CI/build 当成 Windows/Linux 真实录音与插入验证。

## 文件职责

| 文件 | 本计划中的职责 |
|---|---|
| `src-tauri/src/state.rs` | 保存单实例 Local ASR semaphore |
| `src-tauri/src/local_asr.rs` | 完整子进程 lifecycle timeout、现有 watchdog/partial/no-warmup/Windows flags |
| `src-tauri/src/settings.rs` | provider 验证、fresh config、`engine_ready`、删除 translation config |
| `src-tauri/src/commands.rs` | 单一路由、raw request provider、pending recovery、设置保存 |
| `src-tauri/src/hotkey.rs` | 单一 Start action，同时保留跨屏定位 |
| `src-tauri/src/tray.rs` | 删除 Engine 子菜单 |
| `src/views/input-prompt.js` | immutable session provider、单一录音动作、retry/pending 保留 |
| `src/views/input-prompt.html` | 保留 macOS/Linux 与 Windows raw IPC CSP |
| `src/views/input-prompt.test.mjs` | session、顺序、retry、Local/Cloud pending 边界 |
| `src/views/ipc-bridge.js` | raw audio body + provider/MIME headers |
| `src/views/main.*` | 三阶段 onboarding、readiness、首页降噪 |
| `src/views/settings.*` | Local/Cloud 两层设置与 Cloud advanced |
| `src/views/i18n.js` | 删除 translation 文案、加入新信息架构文案 |
| `scripts/ipc-contract.test.mjs` | raw IPC 与 command registration contract |
| `README.md` | Local-first 对外叙事与平台边界 |

---

## Batch 1：Local ASR release gates

### Task 1：为所有 Local decode 增加单实例 gate

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/commands.rs`
- Test: `src-tauri/src/commands.rs`

- [ ] **Step 1：先写 gate 的并发测试**

在 `src-tauri/src/commands.rs` 的测试模块增加一个测试，使用两个并发 future 记录同时执行数量：

```rust
#[tokio::test]
async fn local_asr_gate_allows_only_one_decode() {
  use std::sync::atomic::{AtomicUsize, Ordering};
  use std::sync::Arc;
  use tokio::sync::Semaphore;

  async fn measured_job(active: Arc<AtomicUsize>, peak: Arc<AtomicUsize>) -> anyhow::Result<()> {
    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
    peak.fetch_max(now, Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    active.fetch_sub(1, Ordering::SeqCst);
    Ok(())
  }

  let slots = Arc::new(Semaphore::new(1));
  let active = Arc::new(AtomicUsize::new(0));
  let peak = Arc::new(AtomicUsize::new(0));

  let first = with_local_asr_slot(&slots, measured_job(active.clone(), peak.clone()));
  let second = with_local_asr_slot(&slots, measured_job(active.clone(), peak.clone()));
  let (first_result, second_result) = tokio::join!(first, second);

  first_result.unwrap();
  second_result.unwrap();
  assert_eq!(peak.load(Ordering::SeqCst), 1);
}
```

- [ ] **Step 2：运行测试并确认失败**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml local_asr_gate_allows_only_one_decode
```

Expected: FAIL，`with_local_asr_slot` 尚不存在。

- [ ] **Step 3：在 `AppState` 中建立唯一 semaphore**

在 `src-tauri/src/state.rs`：

```rust
use tokio::sync::Semaphore;
```

在 `AppState` 增加：

```rust
pub local_asr_slots: Semaphore,
```

在 `Default` 中初始化：

```rust
local_asr_slots: Semaphore::new(1),
```

- [ ] **Step 4：实现可测试的 gate helper**

在 `src-tauri/src/commands.rs` 的 Local transcription helper 附近增加：

```rust
async fn with_local_asr_slot<T, F>(
  slots: &tokio::sync::Semaphore,
  work: F,
) -> anyhow::Result<T>
where
  F: std::future::Future<Output = anyhow::Result<T>>,
{
  let _permit = slots
    .acquire()
    .await
    .map_err(|_| anyhow::anyhow!("Local transcription queue is unavailable"))?;
  work.await
}
```

- [ ] **Step 5：让所有 Local 入口共用 gate**

将 `perform_local_transcription` 改为接收 `&tokio::sync::Semaphore`，并在调用 `local_asr::transcribe_wav` 前经过 `with_local_asr_slot`。

必须同步修改：

1. `transcribe_audio` 的 `TranscriptionRoute::Local`；
2. `retranscribe_pending`，给 command 增加 `State<'_, AppState>`；
3. 所有 Rust tests 中对 `perform_local_transcription` 的直接调用。

前端自动 retry 会再次调用 `transcribe-audio`，因此自然经过同一个 `AppState.local_asr_slots`，不得另建 retry 专用 gate。

- [ ] **Step 6：运行目标测试和完整 Rust tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml local_asr_gate_allows_only_one_decode
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: gate test 通过；完整 suite 在宿主环境通过。若只有 `pbcopy` 在 sandbox 失败，必须宿主复跑后再分类。

- [ ] **Step 7：提交**

```bash
git add src-tauri/src/state.rs src-tauri/src/commands.rs
git commit -m "fix(local-asr): serialize local transcription work"
```

### Task 2：让 hard timeout 覆盖 `child.wait()`

**Files:**
- Modify: `src-tauri/src/local_asr.rs`
- Test: `src-tauri/src/local_asr.rs`

- [ ] **Step 1：写 lifecycle helper 的失败测试**

在 `src-tauri/src/local_asr.rs` 测试模块增加：

```rust
#[tokio::test]
async fn hard_timeout_covers_work_after_output_closes() {
  let result = run_with_hard_timeout(
    async {
      std::future::pending::<()>().await;
      Ok::<(), anyhow::Error>(())
    },
    std::time::Duration::from_millis(20),
  )
  .await;

  let error = result.unwrap_err().to_string();
  assert!(error.contains("timed out"), "{error}");
}
```

- [ ] **Step 2：运行并确认失败**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml hard_timeout_covers_work_after_output_closes
```

Expected: FAIL，`run_with_hard_timeout` 尚不存在。

- [ ] **Step 3：实现统一 timeout helper**

在 `TRANSCRIBE_TIMEOUT` 附近增加：

```rust
async fn run_with_hard_timeout<T, F>(work: F, timeout: Duration) -> Result<T>
where
  F: std::future::Future<Output = Result<T>>,
{
  tokio::time::timeout(timeout, work)
    .await
    .map_err(|_| anyhow::anyhow!("local ASR timed out after {}s", timeout.as_secs()))?
}
```

- [ ] **Step 4：把 pump 和 wait 放进同一个 lifecycle future**

将当前“timeout 只包 `pump`，之后单独 `child.wait().await`”改成：

```rust
let lifecycle = async {
  let (stdout_bytes, stderr_bytes) = pump
    .await
    .context("failed to read llama-mtmd-cli output")?;
  let status = child.wait().await.context("failed to run llama-mtmd-cli")?;
  Ok::<_, anyhow::Error>((stdout_bytes, stderr_bytes, status))
};

let (stdout_bytes, stderr_bytes, status) = tokio::select! {
  completed = run_with_hard_timeout(lifecycle, TRANSCRIBE_TIMEOUT) => completed?,
  hung = watchdog => return Err(hung),
};
```

保留以下现有行为，不得改名或删除：

- `kill_on_drop(true)`；
- first-byte deadline；
- no-progress watchdog；
- partial text emit；
- `--no-warmup`；
- Windows `CREATE_NO_WINDOW`；
- temp WAV guard。

- [ ] **Step 5：运行 Local ASR 单测与完整 Rust tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml local_asr::tests
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: 全部通过；现有 `real_subprocess_smoke` 仍 ignored，不能把 ignored 当作真模型验证。

- [ ] **Step 6：提交**

```bash
git add src-tauri/src/local_asr.rs
git commit -m "fix(local-asr): bound the full child lifecycle"
```

### Batch 1 gate

- [ ] `cargo test` 宿主环境通过；
- [ ] `cargo check` 通过；
- [ ] 快速连续触发两次 Local 听写时，Activity Monitor 中最多一个 `llama-mtmd-cli`；
- [ ] Esc/cancel 不会让排队中的第二个 decode 在取消后启动；
- [ ] pending History re-transcribe 与新听写同时触发时仍最多一个 CLI。

---

## Batch 2：单一听写路由、immutable provider、删除 translation

### Task 3：建立统一 provider 验证边界

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/commands.rs`
- Test: `src-tauri/src/settings.rs`
- Test: `src-tauri/src/commands.rs`

- [ ] **Step 1：写 provider parsing tests**

在 `settings.rs` 测试模块增加：

```rust
#[test]
fn transcription_provider_accepts_only_known_values() {
  assert_eq!(
    TranscriptionProvider::try_from("local").unwrap(),
    TranscriptionProvider::Local
  );
  assert_eq!(
    TranscriptionProvider::try_from("groq").unwrap(),
    TranscriptionProvider::Groq
  );
  assert_eq!(
    TranscriptionProvider::try_from("openai").unwrap(),
    TranscriptionProvider::OpenAI
  );
  assert!(TranscriptionProvider::try_from("future-provider").is_err());
  assert!(TranscriptionProvider::try_from("").is_err());
}

#[test]
fn provider_specific_keys_never_cross_clouds() {
  let mut config = AppConfig::default();
  config.api_key_groq = "gsk".into();
  config.api_key_openai = "osk".into();
  assert_eq!(api_key_for(&config, TranscriptionProvider::Groq), "gsk");
  assert_eq!(api_key_for(&config, TranscriptionProvider::OpenAI), "osk");
  assert_eq!(api_key_for(&config, TranscriptionProvider::Local), "");
}
```

- [ ] **Step 2：实现 enum 与 parser**

在 `AppConfig` 上方增加：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptionProvider {
  Local,
  Groq,
  OpenAI,
}

impl TranscriptionProvider {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Local => "local",
      Self::Groq => "groq",
      Self::OpenAI => "openai",
    }
  }
}

impl TryFrom<&str> for TranscriptionProvider {
  type Error = String;

  fn try_from(value: &str) -> std::result::Result<Self, Self::Error> {
    match value {
      "local" => Ok(Self::Local),
      "groq" => Ok(Self::Groq),
      "openai" => Ok(Self::OpenAI),
      _ => Err(format!("Unknown transcription provider: {value}")),
    }
  }
}
```

持久化 schema 继续保留 `AppConfig.provider: String`，避免无必要的 JSON migration；所有路由、key selection 和 provider change 在使用前先 parse。

- [ ] **Step 3：替换隐式 fallback**

至少替换：

- `selected_api_key` 中的 `else => Groq`；
- `default_model_for` 中的兜底分支；
- `switch_provider`；
- `apply_provider_change`；
- `resolve_transcription_route`。

核心 helper 的签名统一为：

```rust
fn default_model_for(provider: TranscriptionProvider) -> &'static str

fn switch_provider(config: &mut AppConfig, provider: TranscriptionProvider)

pub fn api_key_for(
  config: &AppConfig,
  provider: TranscriptionProvider,
) -> String

fn resolve_transcription_route(
  config: &AppConfig,
  provider: TranscriptionProvider,
) -> Result<TranscriptionRoute, String>

pub fn apply_provider_change(
  app: &AppHandle,
  provider: TranscriptionProvider,
) -> Result<(), String>
```

`TranscriptionRoute::Cloud` 保存 `TranscriptionProvider` 而不是自由字符串；发 HTTP request 的最后边界才调用 `provider.as_str()`。

`api_key_for` 必须只读取指定 provider 的 key：Groq 读取 `api_key_groq`，OpenAI 读取 `api_key_openai`，两者可回退 legacy `api_key`，Local 恒为空；不能读取另一家 provider 的 key。`selected_api_key` 可保留为“parse `config.provider` 后调用 `api_key_for`”的 compatibility wrapper。

```rust
pub fn api_key_for(
  config: &AppConfig,
  provider: TranscriptionProvider,
) -> String {
  let provider_key = match provider {
    TranscriptionProvider::Local => return String::new(),
    TranscriptionProvider::Groq => &config.api_key_groq,
    TranscriptionProvider::OpenAI => &config.api_key_openai,
  };
  if provider_key.trim().is_empty() {
    config.api_key.clone()
  } else {
    provider_key.clone()
  }
}
```

IPC command 在边界 parse 一次：

```rust
let provider = TranscriptionProvider::try_from(provider.as_str())?;
apply_provider_change(&app, provider)?;
```

未知 provider 必须返回错误，不能变成 OpenAI 或 Groq 请求。

- [ ] **Step 4：运行 provider tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml transcription_provider
cargo test --manifest-path src-tauri/Cargo.toml commands::tests
```

Expected: 已知三值通过；未知值 fail closed。

- [ ] **Step 5：提交**

```bash
git add src-tauri/src/settings.rs src-tauri/src/commands.rs
git commit -m "refactor(transcription): validate providers centrally"
```

### Task 4：把 provider 固定到 recording session

**Files:**
- Modify: `src/views/input-prompt.js`
- Verify: `src/views/input-prompt.html`
- Modify: `src/views/input-prompt.test.mjs`
- Modify: `src/views/ipc-bridge.js`
- Modify: `src-tauri/src/commands.rs`
- Modify: `scripts/ipc-contract.test.mjs`

- [ ] **Step 1：先写 provider race test**

在 `src/views/input-prompt.test.mjs` 增加一个测试：

```javascript
test("a recording keeps its provider when settings change before transcription finishes", async () => {
  const calls = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, ...args) {
      if (command === "transcribe-audio") {
        calls.push(args);
        return Promise.resolve("hello");
      }
      return null;
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "local",
    recordingSessionId: 1,
    pendingInsertionOrder: [1],
  });

  prompt.currentProvider = "openai";
  await processOneRecording(prompt, 1, "local");

  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "local");
});
```

先把现有 `processOneRecording` helper 改为：

```javascript
function processOneRecording(
  prompt,
  id = 1,
  providerAtStart = prompt.currentProvider
) {
  return prompt.processRecording({
    id,
    chunks: [new Blob([new Uint8Array([1, 2, 3])])],
    mimeType: "audio/webm",
    providerAtStart,
    cancelledShortPress: false,
  });
}
```

其他现有 tests 继续调用 `processOneRecording(prompt)`，自动继承各自 bare prompt 的 provider；不要复制第二套 fake DOM。

- [ ] **Step 2：在录音开始时 capture provider**

`startRecording()` 创建 session 时写入：

```javascript
providerAtStart: this.currentProvider,
```

开始录音前必须验证 `this.currentProvider` 是 `local`、`groq` 或 `openai`。settings 尚未加载或值无效时，显示“转写方式尚未准备好”，不得用 `openai` 作为 fallback，也不得发送音频。

`processRecording()` 解构：

```javascript
const {
  id: sessionId,
  chunks,
  mimeType,
  providerAtStart,
  cancelledShortPress,
} = recordingSession;
```

以下路径只读取 `providerAtStart`：

- Local WAV 强制编码；
- model badge/session status；
- `transcribeWithRetry`；
- retry 后是否保存 pending audio。

- [ ] **Step 3：更新 raw IPC contract**

`src/views/ipc-bridge.js` 将 `transcribe-audio` 改为：

```javascript
"transcribe-audio": {
  body: 0,
  headers: { "provider": 1, "mime-type": 2 },
},
```

调用签名统一为：

```javascript
ipc.invoke("transcribe-audio", uploadBuffer, providerAtStart, uploadMime);
```

Rust `transcribe_audio` 从 `provider` header 读取字符串并调用 `TranscriptionProvider::try_from`。缺失或未知 provider 均返回错误，不读取 `config.provider` 代替。

`src/views/input-prompt.html` 的 `connect-src` 必须继续同时允许：

```text
ipc:
http://ipc.localhost
```

前者服务 macOS/Linux，后者服务 Windows WebView2；不得因为 header 重排而改回 JSON number array transport。

- [ ] **Step 4：保持 key 来自后端 config**

raw request 只携带 provider 名称，不携带 API key。后端按 session provider 从 `AppConfig` 取对应 key：

```rust
let provider = TranscriptionProvider::try_from(provider_header)?;
let route = resolve_transcription_route(&config, provider)?;
```

- [ ] **Step 5：运行 race 与 IPC tests**

Run:

```bash
node --test src/views/input-prompt.test.mjs
node --test scripts/ipc-contract.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml commands::tests
```

Expected: session provider race 通过；raw-body channel 与 Rust command registration 通过。

- [ ] **Step 6：提交**

```bash
git add src/views/input-prompt.js src/views/input-prompt.test.mjs src/views/ipc-bridge.js src-tauri/src/commands.rs scripts/ipc-contract.test.mjs
git commit -m "fix(transcription): bind providers to recording sessions"
```

### Task 5：完整删除 translation action

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/hotkey.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/views/input-prompt.js`
- Modify: `src/views/input-prompt.test.mjs`
- Modify: `src/views/ipc-bridge.js`
- Modify: `src/views/main.html`
- Modify: `src/views/main.css`
- Modify: `src/views/main.js`
- Modify: `src/views/settings.html`
- Modify: `src/views/settings.css`
- Modify: `src/views/settings.js`
- Modify: `src/views/i18n.js`
- Test: `scripts/ipc-contract.test.mjs`

- [ ] **Step 1：先把 Rust tests 改成单一路由期望**

删除 translation fallback tests，替换为：

```rust
#[test]
fn local_provider_never_routes_to_cloud() {
  let config = config_with("local", "gsk", "osk");
  let route = resolve_transcription_route(&config, TranscriptionProvider::Local).unwrap();
  assert!(matches!(route, TranscriptionRoute::Local));
}

#[test]
fn unknown_provider_never_routes_to_cloud() {
  assert!(TranscriptionProvider::try_from("unknown").is_err());
}
```

`AppConfig` compatibility test继续使用包含 `translateShortcut` 的旧 JSON，证明 serde 可忽略旧字段。

- [ ] **Step 2：删除 Rust translation state**

删除：

- `TRANSLATE_SHORTCUT`；
- `default_translate_shortcut()`；
- `AppConfig.translate_shortcut`；
- `SettingsPayload.translate_shortcut`；
- `HotkeyState` 的第二快捷键与 `translate_mode`；
- `Action::Start { translate_mode }`；
- `normalize_record_shortcut` 中只为避免 Shift+Alt translation 冲突而存在的限制；
- `broadcast_settings_updates` 中的 `translateShortcut` payload；
- `/audio/translations` endpoint；
- translation 专用模型；
- Local -> Cloud translation fallback。

`Action` 收敛为：

```rust
pub enum Action {
  Start,
  Stop,
  Cancel,
}
```

`dispatch_action(Action::Start)` 必须原样保留：

- `position_input_prompt()`；
- `wait_for_position()`；
- `window.show()`；
- `start-recording` emit。

- [ ] **Step 3：删除前端 translation state**

删除：

- `DEFAULT_TRANSLATE_SHORTCUT`；
- `TRANSLATE_MODEL`；
- `this.translateMode`；
- `recordingSession.translateMode`；
- English-output badge/status；
- 第二快捷键 hint；
- onboarding translation tip；
- Settings translation shortcut field。

`transcribeWithRetry` 最终签名：

```javascript
async transcribeWithRetry(uploadBuffer, providerAtStart, uploadMime)
```

- [ ] **Step 4：清理文案与样式，但不要误删无关内容**

Run:

```bash
rg -n -i "translate|translation" src-tauri/src src/views scripts README.md
```

逐项判断：

- product translation 文案、状态、快捷键必须归零；
- `scripts/release-notes-lib.mjs` 中与语言转换无关的普通英文单词不能因为关键词命中被删除；
- `transcription` 包含字母串 `translation` 的近似命中不能机械替换。

- [ ] **Step 5：保留现有 regression tests**

更新 fixtures 后，下列测试仍必须存在并通过：

- stale hide timer 不能隐藏新录音；
- 旧转写失败不能重绘新录音；
- 插入按 recording order；
- hang 只自动 retry 一次；
- Local hang 保存 pending；
- Cloud hang 不落盘；
- non-retryable error 不 retry。

- [ ] **Step 6：运行完整自动验证**

Run:

```bash
node --test "src/views/*.test.mjs" "scripts/*.test.mjs"
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: 全部通过；Rust hotkey 跨屏/DPI tests 继续存在。

- [ ] **Step 7：提交**

```bash
git add src-tauri/src/settings.rs src-tauri/src/hotkey.rs src-tauri/src/commands.rs src/views/input-prompt.js src/views/input-prompt.test.mjs src/views/ipc-bridge.js src/views/main.html src/views/main.css src/views/main.js src/views/settings.html src/views/settings.css src/views/settings.js src/views/i18n.js scripts/ipc-contract.test.mjs
git commit -m "refactor(dictation): remove translation mode"
```

### Batch 2 checkpoint

- [ ] App 只显示一个快捷键；
- [ ] Local 录音在任何失败路径都不读取 cloud key；
- [ ] 录音期间切 provider，当前 session 路由不变，下一次才变化；
- [ ] Local hang 仍保存 pending，Cloud hang 仍不落盘；
- [ ] 多屏 input prompt 位置无回归；
- [ ] Accessibility drag cloud 无回归；
- [ ] 到这里先停，不启用 fresh Local default。

---

## Batch 3：fresh default 与 readiness 分离

### Task 6：只对不存在的配置应用设备感知 fresh default

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Test: `src-tauri/src/settings.rs`

- [ ] **Step 1：写 fresh config tests**

```rust
#[test]
fn fresh_config_uses_local_on_local_capable_hardware() {
  let config = fresh_config_for(true);
  assert_eq!(config.provider, "local");
  assert_eq!(config.model, "qwen3-asr-0.6b-q8_0");
}

#[test]
fn fresh_config_uses_groq_elsewhere() {
  let config = fresh_config_for(false);
  assert_eq!(config.provider, "groq");
  assert_eq!(config.model, "whisper-large-v3-turbo");
}
```

再增加一个已有 JSON 缺字段的 compatibility test，证明 serde 仍使用稳定 legacy defaults，不根据当前硬件改写旧文件。

- [ ] **Step 2：实现 `fresh_config_for`**

```rust
pub fn fresh_config_for(local_capable: bool) -> AppConfig {
  let mut config = AppConfig::default();
  if local_capable {
    config.provider = "local".into();
    config.model = crate::local_asr::LOCAL_MODEL_ID.into();
  } else {
    config.provider = "groq".into();
    config.model = "whisper-large-v3-turbo".into();
  }
  config
}
```

直接复用 `src-tauri/src/local_asr.rs` 已公开的 `LOCAL_MODEL_ID`；不要复制第二个字符串常量。

- [ ] **Step 3：区分 fresh read 与 legacy deserialize**

增加可注入 helper：

```rust
fn read_config_from_path_with_capability(
  path: &Path,
  local_capable: bool,
) -> Result<AppConfig>
```

行为：

- path 不存在：`fresh_config_for(local_capable)`；
- path 存在：正常 serde deserialize；
- `read_config()` 传 `platform::supports_local_first()`；
- `AppConfig::default()` 继续保持 legacy default，不承担 fresh-install 策略。

- [ ] **Step 4：运行 settings tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml settings::tests
```

Expected: fresh true/false、旧 JSON compatibility、atomic write 全部通过。

- [ ] **Step 5：提交**

```bash
git add src-tauri/src/settings.rs src-tauri/src/local_asr.rs
git commit -m "feat(settings): choose fresh defaults by device"
```

### Task 7：允许 Local intent 未 ready，并重命名 readiness

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/views/main.js`
- Modify: `src/views/settings.js`
- Modify: `src/views/input-prompt.js`
- Test: `src-tauri/src/settings.rs`

- [ ] **Step 1：先改 tests 表达正确语义**

```rust
#[test]
fn settings_payload_reports_engine_readiness() {
  let mut config = AppConfig::default();
  config.provider = "local".into();
  assert!(!SettingsPayload::from_config_with(&config, false).engine_ready);
  assert!(SettingsPayload::from_config_with(&config, true).engine_ready);
}
```

在 `commands.rs` 增加：

```rust
#[test]
fn switching_to_local_does_not_depend_on_asset_readiness() {
  let mut config = AppConfig::default();
  switch_provider(&mut config, TranscriptionProvider::Local);
  assert_eq!(config.provider, "local");
  assert_eq!(config.model, crate::local_asr::LOCAL_MODEL_ID);
}
```

- [ ] **Step 2：删除 Local selectable readiness gate**

删除 `local_provider_selectable()` 及其旧测试，使 provider validation 与 model readiness 分离。同步删除：

- `save_settings` 的 assets-ready 拒绝；
- `apply_provider_change` 的 assets-ready 拒绝；
- Settings 前端 `localModelState !== "ready"` 时阻止保存的逻辑；
- tray/home 中“模型未下载所以不能表达 Local intent”的旧逻辑。

Local 未 ready 时，按快捷键必须返回本地模型缺失错误并打开修复入口，不能读取 cloud key。

- [ ] **Step 3：重命名 payload**

Rust：

```rust
pub engine_ready: bool,
```

前端统一改为：

```javascript
settings.engineReady
```

Run:

```bash
rg -n "hasApiKey|has_api_key" src-tauri/src src/views scripts
```

Expected: 零命中。

- [ ] **Step 4：运行 Rust 与 Node tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml settings::tests
node --test "src/views/*.test.mjs" "scripts/*.test.mjs"
```

- [ ] **Step 5：提交**

```bash
git add src-tauri/src/settings.rs src-tauri/src/commands.rs src/views/main.js src/views/settings.js src/views/input-prompt.js
git commit -m "refactor(readiness): separate provider intent from engine state"
```

---

## Batch 4：Local/Cloud 两层产品 UI

### Task 8：先加静态 UI contract tests

**Files:**
- Create: `scripts/local-first-ui-contract.test.mjs`
- Modify: `src/views/main.html`
- Modify: `src/views/settings.html`

- [ ] **Step 1：写会失败的静态 contract**

Create `scripts/local-first-ui-contract.test.mjs`：

```javascript
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const mainHtml = fs.readFileSync("src/views/main.html", "utf8");
const settingsHtml = fs.readFileSync("src/views/settings.html", "utf8");
const mainJs = fs.readFileSync("src/views/main.js", "utf8");
const trayRs = fs.readFileSync("src-tauri/src/tray.rs", "utf8");

test("home and tray do not expose peer engine switchers", () => {
  assert.doesNotMatch(mainHtml, /id="engine-card"/);
  assert.doesNotMatch(mainJs, /ENGINE_OPTIONS/);
  assert.doesNotMatch(trayRs, /engine-groq|engine-openai|engine-local/);
});

test("settings exposes local and cloud as the top-level choices", () => {
  assert.match(settingsHtml, /data-transcription-mode="local"/);
  assert.match(settingsHtml, /data-transcription-mode="cloud"/);
  assert.match(settingsHtml, /id="cloudProviderSelect"/);
});

test("main UI has no translation action", () => {
  assert.doesNotMatch(mainHtml, /translate|translation/i);
});
```

- [ ] **Step 2：运行并确认失败**

Run:

```bash
node --test scripts/local-first-ui-contract.test.mjs
```

Expected: engine card、tray submenu 和 Settings hierarchy 断言失败。

### Task 9：重构 Settings 为 Local/Cloud 两层

**Files:**
- Modify: `src/views/settings.html`
- Modify: `src/views/settings.css`
- Modify: `src/views/settings.js`
- Modify: `src/views/i18n.js`

- [ ] **Step 1：建立稳定 DOM contract**

Settings 使用以下固定结构：

```html
<section id="transcriptionSection">
  <div class="transcription-mode-options">
    <button type="button" data-transcription-mode="local"></button>
    <button type="button" data-transcription-mode="cloud"></button>
  </div>
  <div id="localTranscriptionPanel"></div>
  <div id="cloudTranscriptionPanel">
    <select id="cloudProviderSelect"></select>
    <div id="cloudProviderFields"></div>
  </div>
</section>
```

Local panel复用现有 model state、download/resume/cancel/retry/delete controls；Cloud panel内部才显示 Groq/OpenAI、key、model 和 cloud vocabulary prompt。

- [ ] **Step 2：实现双层映射**

```javascript
function transcriptionModeForProvider(provider) {
  return provider === "local" ? "local" : "cloud";
}

function providerForCloudSelection(value) {
  if (value === "groq" || value === "openai") return value;
  throw new Error(`Unknown cloud provider: ${value}`);
}
```

选择 Local 立即保存 `provider=local`，不等待模型下载。Cloud 内切换 Groq/OpenAI 时立即持久化当前 provider。

本轮不新增 `lastCloudProvider` 配置字段。Local -> Cloud 使用以下确定性规则：

```javascript
function defaultCloudProvider(apiKeys) {
  const hasGroq = Boolean(apiKeys.groq?.trim());
  const hasOpenAI = Boolean(apiKeys.openai?.trim());
  return !hasGroq && hasOpenAI ? "openai" : "groq";
}
```

即只有 OpenAI key 时预选 OpenAI，其余情况一律 Groq；不得把未知状态默认为 OpenAI。

Cloud panel 必须明确说明：音频从本机直接发送到用户选择的 Groq/OpenAI，SayType 不经过自有服务器。该说明不出现在 Local panel。

- [ ] **Step 3：移动 Dictionary 编辑入口**

从主导航删除 Dictionary 页面，将现有 textarea 与保存 command 移到 `cloudTranscriptionPanel` 的 advanced disclosure，文案改为：

- English: `Cloud vocabulary prompt`
- Chinese: `云端词汇提示`

保留 `get-dictionary`、`save-dictionary` 与已有配置数据。

- [ ] **Step 4：运行静态 contract 和完整 Node tests**

Run:

```bash
node --test scripts/local-first-ui-contract.test.mjs
node --test "src/views/*.test.mjs" "scripts/*.test.mjs"
```

- [ ] **Step 5：提交**

```bash
git add src/views/settings.html src/views/settings.css src/views/settings.js src/views/i18n.js scripts/local-first-ui-contract.test.mjs
git commit -m "refactor(settings): group transcription into local and cloud"
```

### Task 10：首页与托盘降噪

**Files:**
- Modify: `src/views/main.html`
- Modify: `src/views/main.css`
- Modify: `src/views/main.js`
- Modify: `src-tauri/src/tray.rs`
- Modify: `src/views/i18n.js`

- [ ] **Step 1：删除首页 engine card**

删除：

- `#engine-card`；
- `ENGINE_OPTIONS`；
- `renderEngineCard()`；
- `selectEngine()`；
- 只服务于 segmented engine switcher 的 CSS/i18n。

readiness card保留一行状态：

```text
Transcription: On this device · Manage
```

或：

```text
Transcription: Groq cloud · Manage
```

`Manage` 打开 Settings 的 `#transcriptionSection`。

- [ ] **Step 2：删除 tray Engine submenu**

删除：

- `ENGINE_ITEMS`；
- `engine-groq` / `engine-openai` / `engine-local` handler；
- `Submenu::with_id(..., "engine", ...)`；
- provider checkmark refresh。

保留 Settings、更新、退出及现有录音相关菜单。

- [ ] **Step 3：运行 Rust、Node 与 static contract**

Run:

```bash
node --test scripts/local-first-ui-contract.test.mjs
node --test "src/views/*.test.mjs" "scripts/*.test.mjs"
cargo test --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 4：提交**

```bash
git add src/views/main.html src/views/main.css src/views/main.js src-tauri/src/tray.rs src/views/i18n.js
git commit -m "refactor(ui): remove prominent provider switching"
```

### Task 11：把 onboarding 收敛为三个阶段

**Files:**
- Modify: `src/views/main.html`
- Modify: `src/views/main.css`
- Modify: `src/views/main.js`
- Modify: `src/views/i18n.js`
- Test: `scripts/local-first-ui-contract.test.mjs`

- [ ] **Step 1：扩展 onboarding static contract**

```javascript
test("onboarding has three product stages", () => {
  assert.match(mainHtml, /data-onboarding-stage="welcome"/);
  assert.match(mainHtml, /data-onboarding-stage="prepare"/);
  assert.match(mainHtml, /data-onboarding-stage="first-dictation"/);
  assert.doesNotMatch(mainJs, /const OB_TOTAL = 6/);
});
```

- [ ] **Step 2：建立三阶段结构**

使用固定 stage：

```text
welcome -> prepare -> first-dictation
```

`prepare` 同时显示三个 checklist：

1. transcription engine；
2. microphone；
3. Accessibility。

Local-capable：

- provider fresh state 已是 Local；
- 显示 Local recommended；
- 用户点击后才下载约 1 GB；
- Cloud 作为低优先级展开项。

非 Local-capable：

- fresh provider 是 Groq；
- 显示 Cloud recommended；
- 同页提供 Groq key 输入，OpenAI 作为第二选择；
- Local 是低优先级可选项并带验证/性能提示。

Local-capable 用户展开 Cloud 后才看到 Groq/OpenAI 与 key 表单；Local 主路径不渲染 API key 输入。

- [ ] **Step 3：完整复用 Accessibility flow**

保留调用：

```javascript
startAccessibilityFlow()
```

不得删除或绕过：

- `show-permission-dialog`；
- `show-ax-cloud`；
- AX polling；
- window focus recheck；
- granted 后 `hide-ax-cloud`；
- timeout 后 reveal/retry UI。

- [ ] **Step 4：第一次听写只显示一个 shortcut**

最终 stage包含真实输入框，用户完成：

```text
hold -> speak -> release -> insert
```

跳过未完成项后仍可进入首页；readiness card继续提供同一个修复入口。

- [ ] **Step 5：运行 tests**

Run:

```bash
node --test scripts/local-first-ui-contract.test.mjs
node --test "src/views/*.test.mjs" "scripts/*.test.mjs"
```

- [ ] **Step 6：提交**

```bash
git add src/views/main.html src/views/main.css src/views/main.js src/views/i18n.js scripts/local-first-ui-contract.test.mjs
git commit -m "refactor(onboarding): focus setup on first dictation"
```

---

## Batch 5：README、发布验证与 rollout

### Task 12：按真实产品行为重写 README

**Files:**
- Modify: `README.md`

- [ ] **Step 1：按产品优先顺序重排**

顺序固定为：

1. `Speak. It types.` / `说话，就是打字。`
2. Download；
3. 三步使用；
4. Apple Silicon Local-first；
5. 平台支持矩阵；
6. Optional Cloud transcription；
7. Settings 与本地数据；
8. Development/build。

- [ ] **Step 2：执行文案 contract scan**

Run:

```bash
rg -n -i "translation|translate shortcut|shift\\+alt" README.md
```

Expected: 零命中。

确认：

- 普通用户 Requirements 不要求 API key；
- Apple Silicon 是自动 Local-first 的真实范围；
- Intel/Windows/Linux 不宣称已经默认本地或完成同等级真机验证；
- Groq/OpenAI 只在 Optional Cloud section 出现；
- Cloud section 说明音频直达所选 provider，不经过 SayType 自有服务器；
- 不宣称永久免费、无限录音或 streaming ASR。

- [ ] **Step 3：提交**

```bash
git add README.md
git commit -m "docs: present SayType as local-first voice typing"
```

### Task 13：完整自动验证

- [ ] **Step 1：Node**

Run:

```bash
node --test "src/views/*.test.mjs" "scripts/*.test.mjs"
```

Expected: 0 failed。

- [ ] **Step 2：Rust**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: 0 failed。sandbox 中若只有 macOS `pbcopy` 失败，宿主复跑；不得直接忽略。

- [ ] **Step 3：残留扫描**

Run:

```bash
rg -n -i "translate|translation|translateShortcut|translate-mode|Shift\\+Alt" src-tauri/src src/views README.md
rg -n "hasApiKey|has_api_key|engine-groq|engine-openai|engine-local|ENGINE_OPTIONS" src-tauri/src src/views
git diff --check
```

Expected:

- product translation 与旧 readiness 名称零命中；
- 三段 engine switcher 零命中；
- `git diff --check` 无输出。

### Task 14：真机 E2E gate

- [ ] Apple Silicon 删除/移走 config 后启动：持久化 Local，但不未经点击自动下载；
- [ ] 模型 absent/partial/downloading/ready/error 五态：provider 始终 Local；
- [ ] Local 模型缺失时按快捷键：只提示下载，不发 cloud 请求；
- [ ] 连续两次 Local 听写：最多一个 CLI，结果按录音顺序插入；
- [ ] Local hang：自动 retry 一次，之后 pending History 可恢复；
- [ ] Cloud hang：不保存音频；
- [ ] 录音期间切 provider：当前 session 不变；
- [ ] 现有 OpenAI/Groq/Local 用户升级：provider、keys、history、model assets 保留；
- [ ] 多屏/混合 DPI：input prompt 出现在焦点应用所在屏幕；
- [ ] macOS 首次 AX：system prompt -> Settings -> drag cloud -> granted -> cloud hidden；
- [ ] Windows release build：raw audio IPC 可用，转写不弹 console；
- [ ] Linux/Windows 未真机通过的行为继续标注为未验证，不用 CI 替代。

### Task 15：release decision

只有以下全部成立，才允许发布 Apple Silicon fresh default=Local：

- [ ] Batch 1–5 自动验证全部通过；
- [ ] Apple Silicon fresh install E2E 通过；
- [ ] 连续录音只运行一个 Local CLI；
- [ ] Local 全路径无 cloud fallback；
- [ ] AX drag cloud 和跨屏 input prompt 无回归；
- [ ] 现有 cloud 用户升级无配置改写；
- [ ] README 与产品 UI 一致；
- [ ] long-audio 仍明确属于独立、未批准实施的设计。

---

## 执行建议

本轮实际执行时，先只领取：

```text
Task 1 -> Task 2 -> Task 3 -> Task 4 -> Task 5
```

完成 Batch 1 和 Batch 2 后提交一份 checkpoint 报告，内容只包括：

- changed files；
- 自动测试结果；
- Local/Cloud privacy route matrix；
- 连续录音进程数；
- pending recovery；
- 多屏与 Accessibility 手动结果；
- 尚未验证的平台边界。

Checkpoint 获得确认后，再执行 Batch 3–5。不要在同一批改动中同时删除 translation、切 fresh default 和重写 onboarding。
