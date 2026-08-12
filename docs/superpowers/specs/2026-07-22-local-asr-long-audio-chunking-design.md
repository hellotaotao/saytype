# Local ASR long-audio chunking (during-recording, Wispr-style latency hiding)

- **Date:** 2026-07-22
- **Status:** Design — pending review
- **Scope:** Local provider (`"local"`, Qwen3-ASR-0.6B via `llama-mtmd-cli`) only. Cloud modes untouched.
- **Related:** `docs/superpowers/specs/2026-07-12-local-asr-qwen3-design.md`; memory `local-asr-long-clip-ctx-cap-not-oom`, `local-asr-realtime-evaluated-rejected`.

## Problem

The local backend decodes a whole clip in one `llama-mtmd-cli` subprocess, with context sized to the clip (`ctx_size_for_wav`, ~20 tok/s, clamped `[2048, 16384]`). Measured 2026-07-22 (Metal, silence sweep, `/usr/bin/time -l`):

| audio | ctx | peak RSS | decode (Metal) |
|---|---|---|---|
| 60s | 2048 | 1284 MiB | 2.4s |
| 5 min | 6512 | ~2.0 GiB | ~7s |
| ~13 min | 16384 (cap) | ~3.1 GiB | ~27s |
| 25 min | 16384 (cap) | ~3.4 GiB | **FAIL** `Unable to decode media chunk` |

Two real problems for multi-minute dictation (3–5 min is normal for this user; sometimes longer):

1. **Correctness cliff.** Past ~13 min of *speech* (audio tokens overflow the 16384 ctx cap) the decode **fails outright** — the whole dictation is lost. (Memory is *not* the failure mode: the cap already bounds peak RSS to ~3.1 GiB; it does not OOM.)
2. **Unacceptable tail latency.** Even when it succeeds, all decoding happens *after* the user releases the key. A 5-min clip is ~7s; a 13-min clip ~27s on Metal (worse on CPU, where the 180s `TRANSCRIBE_TIMEOUT` bites ~10 min in). Waiting 30s after speaking is not tolerable long-term.

Internal segmentation is not an option: Qwen3-ASR is encoder-decoder and encodes the whole clip before token 1 — it does not self-chunk (confirmed by the monotonic memory/time curve and the overflow failure).

## Goals

- Support **arbitrarily long** local dictation without failure.
- **Hide decode latency behind speech**: after release, only the final (partial) chunk remains to decode, so the tail is ~one chunk (≤ ~3.5s on Metal) regardless of total length.
- Keep peak memory at the per-chunk floor (~1.3 GiB) instead of scaling with total length.
- Show progressive transcript in the **floating input-prompt window** as chunks finalize.
- **No regression** for short dictation: a clip shorter than one chunk behaves exactly as today.

## Non-goals

- Incremental insertion into the *target app*. Final insert stays **one-shot on release** (concatenated). The floating window is the only place partial text appears.
- True streaming/word-level ASR (the model can't; see related memory).
- Cloud-mode changes. Cloud already streams fast and has no ctx ceiling.
- Cross-chunk context sharing in the model (`-p` is ignored; not available).

## Approach: during-recording chunking (option B)

Cut the live audio at VAD silence boundaries into coarse (~60s) chunks *while recording*, decode each chunk in the existing per-transcription subprocess as it closes, stream each chunk's text to the floating window, and on release flush the last chunk, concatenate, and insert once.

The backend barely changes: it is already "one subprocess per clip + token-by-token partial streaming." B is mostly a **frontend orchestration** change plus a small IPC payload extension.

### Data flow

```
mic stream ──► RealTimeVAD (Silero, frame-by-frame, live; vendored bundle)
                   │  speech-start / speech-end + frame probs + PCM
                   ▼
              Chunker  (accumulate speech; cut at first silence after 45s;
                        hard-cut at 90s on the lowest-prob frame)
                   │  chunk PCM (16 kHz mono)
                   ▼
              WAV encode (existing encodeWavPcm16)
                   │
                   ▼
              Serial decode queue  (one chunk in flight at a time)
                   │  invoke transcribe-audio { wav, sessionId, chunkIndex }
                   ▼
              Backend: llama-mtmd-cli, ctx sized to the *chunk*
                   │  emit local-transcription-partial { sessionId, chunkIndex, text, done }
                   ▼
              Assembler / floating window:
                   finalized text of chunks 0..k-1  +  live partial of chunk k

release ⇒ stop capture → flush residual speech as final chunk → drain queue
        → concat chunk texts in order → single type-text insert (+ history save)
```

## Components

### 1. Real-time capture + VAD (frontend, new)

- Feed `getUserMedia`'s stream through Web Audio (`AudioContext` → `MediaStreamSource` → `AudioWorklet`) to obtain 16 kHz mono Float32 frames live, and drive the vendored **`RealTimeVAD` / `FrameProcessor`** (already in `vendor/vad/bundle.min.js`; same Silero `silero_vad_legacy.onnx` model we use today, just the streaming entry point instead of `NonRealTimeVAD.run`).
- Emits: speech-start, speech-end, and per-frame speech probability (for forced cuts).
- **Risk / validation gate:** live capture + AudioWorklet reliability in **WKWebView** — this app has prior WebKit capture quirks (EC→VoiceProcessingIO first-word loss). Implementation **starts with a spike** (below) before any orchestration is built.
- Fallback: if the real-time path fails to initialize, fall back to today's whole-clip path (record → `NonRealTimeVAD` → single decode). Long clips then hit the old ceiling, but nothing breaks. Fail-open, matching the existing VAD gate.

### 2. Chunker (frontend, new — pure logic, unit-testable)

- Accumulates live PCM. Cut policy — all thresholds are the **current chunk's elapsed audio duration** (from the previous cut, including any interior silence):
  - **Soft target 60s:** once the chunk reaches ≥45s, cut at the **first VAD silence** (`speech-end`).
  - **Hard max 90s:** if no qualifying silence by 90s, force-cut at the **lowest speech-probability frame** in the recent window.
  - Params are constants, tunable after real-use testing.
- Output: ordered chunk PCM buffers. A dictation shorter than the soft target yields exactly one chunk (= today's behavior).
- Boundaries land at natural pauses, minimizing per-seam punctuation/sentence-break damage. Coarse chunks minimize the *number* of seams. (Memory is flat across 25–90s chunks — both sit at the ctx floor — so coarseness costs only tail latency, ~2.4–3.5s on Metal.)

### 3. Serial decode queue (frontend, new)

- Chunks are enqueued in capture order and decoded **one at a time** (bounds memory/CPU to one subprocess; guarantees ordering). On Metal/CPU, decode RTF ≪ 1, so the queue never backs up behind real-time speech.
- Each item: `transcribe-audio` invoke carrying `{ wav, sessionId, chunkIndex }`; resolves to that chunk's final text.

### 4. Backend per-chunk decode (Rust, minimal change)

- Reuse `transcribe_wav` as-is (ctx already sized per WAV by `ctx_size_for_wav`; a ≤90s chunk → ctx ≤2312, so **overflow is impossible** and peak RSS stays ~1.3–1.4 GiB).
- `transcribe_audio` (local path) gains optional `sessionId` + `chunkIndex`, threaded into the partial emit so the frontend can route partials to the right chunk slot. Cloud path ignores them.
- Partial event payload extended: `local-transcription-partial { sessionId, chunkIndex, text, done }` (`done: true` sent once when the chunk's final text is known). Still broadcast via `app.emit` (per the "always emit, never emit_to" rule).

### 5. Assembler + floating window (frontend)

- Maintains `finalized[chunkIndex] = text` plus the live partial of the in-flight chunk. Rendered as `finalized.join(joiner) + livePartial`.
- **Joiner:** single space for latin, direct concatenation for CJK (or just always a space — Qwen emits per-chunk punctuation; refine during testing). Each chunk is a natural sentence group, so joins fall at pauses.

### 6. Release flush + insert

- On hotkey-up: stop capture/VAD, take residual buffered speech since the last cut as the **final chunk**, enqueue it, await full queue drain.
- Concatenate all chunk texts in order → **one** `type-text` insert into the focused app (unchanged insertion model, no clipboard fallback). Save the assembled text to History as today.

### 7. Cancel semantics

- Cancel (existing `cancel-transcription` + hotkey-cancel) sets a session-abort flag: stop dispatching new chunks, cancel the in-flight decode (existing `cancel_transcription` → `kill_on_drop`), clear the queue, discard partials, tear down capture/VAD. No insert.

### 8. Error handling

- A chunk decode failing (subprocess error) does not abort the session: log it, keep the other chunks, and insert the successful concatenation on release (a failed chunk is skipped, leaving a gap rather than losing everything). Overflow specifically cannot occur at ≤90s.
- Silence-only chunk → empty text (existing `parse_mtmd_output` behavior) → contributes nothing.

## IPC changes (the "update three places" rule)

- `commands.rs`: `transcribe_audio` local path accepts `session_id: Option<String>`, `chunk_index: Option<u32>`; includes them in the `local-transcription-partial` payload.
- `lib.rs`: handler already registered (signature change only).
- `ipc-bridge.js`: extend `tauriArgs` for `transcribe-audio`; `local-transcription-partial` consumers read the new fields.

## Platform notes

- **Metal (primary, verified):** tail ≤ ~3.5s at 90s chunks; queue keeps up trivially.
- **CPU-only (Windows/Linux, unverified):** decode RTF ~0.3 → tail up to ~18–27s at 90s chunks, and decode-while-capture contends for cores. Acceptable for now (not real-machine targets); the chunking also keeps each decode under the 180s timeout, which today it exceeds ~10 min in.

## Testing

- **Unit (pure logic, no AppHandle):** Chunker cut decisions (soft/hard/no-pause/short-clip-single-chunk); assembler ordering + joins; partial routing by `chunkIndex`. Mirror the existing `vad-decision.test.mjs` / `local_asr.rs` `#[test]` style.
- **Backend:** extend `transcribe_wav_inner` tests to assert `sessionId/chunkIndex` propagate to partials.
- **Integration / regression:** real multi-minute dictation (the no-human e2e recipe: `say`+`afplay` into the mic, simulated hotkey), asserting (a) a >13-min clip now succeeds, (b) tail after release ≈ one chunk, (c) short-clip behavior unchanged. Compare punctuation on a fixed clip vs the whole-clip baseline to quantify seam cost.

## Implementation sequencing

1. **Spike (gate):** minimal WKWebView page — `getUserMedia` → AudioWorklet → `RealTimeVAD`, log speech-start/end timestamps live over a 3-min talk. Confirm stable framing, no first-word loss, acceptable CPU. If this fails, stop and revisit (fall back to option A or reconsider capture).
2. Chunker (pure logic + tests).
3. Serial queue + IPC payload extension + backend `sessionId/chunkIndex` threading.
4. Assembler + floating-window rendering.
5. Release flush + concat insert; cancel; error handling.
6. Integration/regression + parameter tuning on real dictation.

## Open questions

- Exact joiner rule (space vs CJK-aware) — settle during testing against real output.
- Whether to show a per-chunk "still processing" affordance in the floating window, or just append finalized text — decide during UX pass.

---

# 中文版（本设计文档的翻译）

# 本地 ASR 长音频分段（录音中切分，Wispr 式延迟隐藏）

- **日期：** 2026-07-22
- **状态：** 设计中 — 待评审
- **范围：** 仅本地 provider（`"local"`，Qwen3-ASR-0.6B，经 `llama-mtmd-cli`）。云端模式不动。
- **相关：** `docs/superpowers/specs/2026-07-12-local-asr-qwen3-design.md`；记忆 `local-asr-long-clip-ctx-cap-not-oom`、`local-asr-realtime-evaluated-rejected`。

## 问题

本地后端在单个 `llama-mtmd-cli` 子进程里解码整段音频，context 按整段时长计算（`ctx_size_for_wav`，约 20 token/秒，clamp 到 `[2048, 16384]`）。2026-07-22 实测（Metal，silence 扫描，`/usr/bin/time -l`）：

| 音频 | ctx | 峰值 RSS | 解码（Metal） |
|---|---|---|---|
| 60s | 2048 | 1284 MiB | 2.4s |
| 5 分钟 | 6512 | ~2.0 GiB | ~7s |
| ~13 分钟 | 16384（触顶） | ~3.1 GiB | ~27s |
| 25 分钟 | 16384（触顶） | ~3.4 GiB | **失败** `Unable to decode media chunk` |

多分钟听写（该用户常态 3–5 分钟，偶尔更长）有两个真实问题：

1. **正确性悬崖。** 超过约 13 分钟*语音*（audio token 顶破 16384 ctx cap），解码**直接失败**——整段听写丢失。（内存*不是*失败原因：cap 已把峰值 RSS 封在 ~3.1 GiB，不会 OOM。）
2. **无法接受的尾延迟。** 即便成功，所有解码都发生在用户松开按键*之后*。5 分钟约 ~7s；13 分钟在 Metal 上 ~27s（CPU 上更糟，180s 的 `TRANSCRIBE_TIMEOUT` 约 10 分钟就触发）。说完还要等 30s，长期无法忍受。

内部分段行不通：Qwen3-ASR 是 encoder-decoder，token 1 之前就要编码整段——它不会自分段（由单调的内存/时间曲线 + 溢出失败共同证实）。

## 目标

- 支持**任意长度**的本地听写而不失败。
- **把解码延迟藏在说话过程中**：松开后只剩最后（未完成的）一块要解，因此尾延迟约等于一块（Metal 上 ≤ ~3.5s），与总长无关。
- 峰值内存保持在单块下限（~1.3 GiB），不随总长增长。
- 在**悬浮输入窗口**里随每块定稿逐步显示转写文本。
- 短听写**无回归**：短于一块的音频行为与今天完全一致。

## 非目标

- 向*目标 app* 增量插入。最终插入仍为松开后**一次性**（拼接后）。悬浮窗是唯一显示 partial 文本的地方。
- 真正的流式/词级 ASR（模型做不到；见相关记忆）。
- 云端模式改动。云端本就快、无 ctx 天花板。
- 模型内跨块上下文共享（`-p` 被忽略；不可用）。

## 方案：录音中分段（方案 B）

录音*过程中*就在 VAD 静音边界把实时音频切成粗（~60s）块，每块在闭合时用现有的按次子进程解码，把每块文本推流到悬浮窗；松开时冲刷最后一块、拼接、一次性插入。

后端几乎不变：它本就是"每段音频一个子进程 + 逐 token partial 推流"。B 主要是**前端编排**改动，外加一个小的 IPC payload 扩展。

### 数据流

```
麦克风流 ──► RealTimeVAD（Silero，逐帧，实时；来自 vendored bundle）
                 │  speech-start / speech-end + 帧概率 + PCM
                 ▼
            Chunker（累积语音；45s 后在首个静音处切；
                     90s 无停顿则在概率最低帧硬切）
                 │  块 PCM（16 kHz 单声道）
                 ▼
            WAV 编码（现成的 encodeWavPcm16）
                 │
                 ▼
            串行解码队列（同一时刻只有一块在解）
                 │  invoke transcribe-audio { wav, sessionId, chunkIndex }
                 ▼
            后端：llama-mtmd-cli，ctx 按*该块*大小计算
                 │  emit local-transcription-partial { sessionId, chunkIndex, text, done }
                 ▼
            组装器 / 悬浮窗：
                 已定稿的 0..k-1 块文本  +  第 k 块的实时 partial

松开 ⇒ 停止采集 → 把最后残留语音冲刷成最终块 → 排空队列
      → 按序拼接各块文本 → 一次 type-text 插入（+ 存入 History）
```

## 组件

### 1. 实时采集 + VAD（前端，新增）

- 把 `getUserMedia` 的流经 Web Audio（`AudioContext` → `MediaStreamSource` → `AudioWorklet`）实时取出 16 kHz 单声道 Float32 帧，驱动 vendored 的 **`RealTimeVAD` / `FrameProcessor`**（已在 `vendor/vad/bundle.min.js` 里；与今天同一个 Silero `silero_vad_legacy.onnx` 模型，只是换成流式入口，而非 `NonRealTimeVAD.run`）。
- 输出：speech-start、speech-end，以及每帧语音概率（用于硬切）。
- **风险 / 验证闸门：** WKWebView 里实时采集 + AudioWorklet 的可靠性——这个 app 在 WebKit 采集上有前科（EC→VoiceProcessingIO 掉首字）。实现**从一个 spike 开始**（见下），验证通过后再搭编排。
- 回退：若实时路初始化失败，退回今天的整段路径（录完 → `NonRealTimeVAD` → 单次解码）。长音频则回到旧天花板，但功能不崩。fail-open，与现有 VAD gate 一致。

### 2. Chunker（前端，新增 — 纯逻辑，可单测）

- 累积实时 PCM。切分策略——所有阈值都指**当前块的已录音频时长**（从上一刀起，含中间的静音）：
  - **软目标 60s：** 当前块达到 ≥45s 后，在**首个 VAD 静音**（`speech-end`）处切。
  - **硬上限 90s：** 若到 90s 仍无合格静音，在近窗口内**语音概率最低的帧**处强制切。
  - 参数是常量，真机试用后可调。
- 输出：按序的块 PCM 缓冲。短于软目标的听写只产出一块（= 今天的行为）。
- 切口落在自然停顿处，最小化每个接缝的标点/断句损伤。粗块减少接缝*数量*。（25–90s 块内存持平——都贴着 ctx 下限——所以粗切只付出尾延迟，Metal 上 ~2.4–3.5s。）

### 3. 串行解码队列（前端，新增）

- 块按采集顺序入队，**一次解一块**（把内存/CPU 限制在一个子进程；保证顺序）。Metal/CPU 上解码 RTF ≪ 1，所以队列永远不会落后于实时语音。
- 每项：`transcribe-audio` invoke，带 `{ wav, sessionId, chunkIndex }`；解析为该块的最终文本。

### 4. 后端按块解码（Rust，最小改动）

- 原样复用 `transcribe_wav`（ctx 已由 `ctx_size_for_wav` 按每个 WAV 计算；≤90s 的块 → ctx ≤2312，因此**不可能溢出**，峰值 RSS 稳在 ~1.3–1.4 GiB）。
- `transcribe_audio`（本地路）新增可选 `sessionId` + `chunkIndex`，透传进 partial 事件，好让前端把 partial 路由到正确的块槽。云端路忽略它们。
- partial 事件 payload 扩展为：`local-transcription-partial { sessionId, chunkIndex, text, done }`（当该块最终文本确定时发一次 `done: true`）。仍用 `app.emit` 广播（遵循"永远 emit、绝不 emit_to"规则）。

### 5. 组装器 + 悬浮窗（前端）

- 维护 `finalized[chunkIndex] = text` 加上在解块的实时 partial。渲染为 `finalized.join(joiner) + livePartial`。
- **连接符（joiner）：** 拉丁文用单个空格，CJK 直接拼接（或干脆一律空格——Qwen 每块自带标点；测试时再定）。每块都是自然的句群，接缝落在停顿处。

### 6. 松开冲刷 + 插入

- 松开（hotkey-up）：停止采集/VAD，把上一刀之后残留的语音作为**最终块**入队，等待整个队列排空。
- 按序拼接所有块文本 → **一次** `type-text` 插入到聚焦的 app（插入模型不变，无剪贴板回退）。像今天一样把拼好的文本存入 History。

### 7. Cancel 语义

- Cancel（现有 `cancel-transcription` + 热键取消）置一个会话中止标志：停止派发新块、取消在解的那块（现有 `cancel_transcription` → `kill_on_drop`）、清空队列、丢弃 partial、拆除采集/VAD。不插入。

### 8. 错误处理

- 某块解码失败（子进程报错）不中止整个会话：记录日志、保留其他块，松开时插入成功部分的拼接（失败块被跳过，留一个空档而非整段丢失）。≤90s 不会发生溢出。
- 纯静音块 → 空文本（现有 `parse_mtmd_output` 行为）→ 不贡献内容。

## IPC 改动（"改三处"规则）

- `commands.rs`：`transcribe_audio` 本地路接收 `session_id: Option<String>`、`chunk_index: Option<u32>`；把它们放进 `local-transcription-partial` payload。
- `lib.rs`：handler 已注册（仅签名变化）。
- `ipc-bridge.js`：扩展 `transcribe-audio` 的 `tauriArgs`；`local-transcription-partial` 的消费方读取新字段。

## 平台说明

- **Metal（主平台，已验证）：** 90s 块尾延迟 ≤ ~3.5s；队列轻松跟上。
- **纯 CPU（Windows/Linux，未验证）：** 解码 RTF ~0.3 → 90s 块尾延迟可达 ~18–27s，且解码与采集争核。暂可接受（非真机目标）；分段也让每次解码都在 180s 超时以内——今天约 10 分钟就会超。

## 测试

- **单元（纯逻辑，无 AppHandle）：** Chunker 切分决策（软/硬/无停顿/短音频单块）；组装器排序 + 连接；按 `chunkIndex` 的 partial 路由。仿照现有 `vad-decision.test.mjs` / `local_asr.rs` `#[test]` 风格。
- **后端：** 扩展 `transcribe_wav_inner` 测试，断言 `sessionId/chunkIndex` 透传到 partial。
- **集成 / 回归：** 真实多分钟听写（无人 e2e 配方：`say`+`afplay` 外放进麦克风、模拟热键），断言：(a) >13 分钟的音频现在能成功，(b) 松开后尾延迟 ≈ 一块，(c) 短音频行为不变。在固定音频上对比标点 vs 整段基线，量化接缝代价。

## 实现顺序

1. **Spike（闸门）：** 最小 WKWebView 页面——`getUserMedia` → AudioWorklet → `RealTimeVAD`，实时打印一段 3 分钟讲话的 speech-start/end 时间戳。确认出帧稳定、无掉首字、CPU 可接受。若失败则停下重估（回退方案 A 或重新考虑采集）。
2. Chunker（纯逻辑 + 测试）。
3. 串行队列 + IPC payload 扩展 + 后端 `sessionId/chunkIndex` 透传。
4. 组装器 + 悬浮窗渲染。
5. 松开冲刷 + 拼接插入；cancel；错误处理。
6. 集成/回归 + 真实听写上的参数调优。

## 待定问题

- 精确的连接符规则（空格 vs CJK 感知）——测试对照真实输出后再定。
- 悬浮窗要不要显示每块"仍在处理"的提示，还是只追加已定稿文本——UX 环节再定。
