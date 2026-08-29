# Local ASR long-audio chunking (during-recording, Wispr-style latency hiding)

- **Date:** 2026-07-22
- **Status:** Implemented 2026-08-29 per Revision 2 (frontend chunker, 55 s / 75 s, OfflineAudioContext resampling, single history row). Confirmed working on the author's machine 2026-08-29: about a minute into a dictation the floating window showed the already-decoded earlier text while capture continued, so the first cut, the mid-recording decode, the assembler rendering and uninterrupted capture are all verified end to end. Still unmeasured: multi-minute dictation (several seams, and the old >13 min failure cliff), and seam punctuation quality against a whole-clip baseline.
- **Scope:** Local provider (`"local"`, Qwen3-ASR-0.6B via `llama-mtmd-cli`) only. Cloud modes untouched.
- **Related:** `docs/superpowers/specs/2026-07-12-local-asr-qwen3-design.md`; memory `local-asr-long-clip-ctx-cap-not-oom`, `local-asr-realtime-evaluated-rejected`.

## Revision 2 (2026-08-29) — risk gate cleared, parameters must change

Three things changed after this design was written. The approach survives; two of its
specifics do not.

1. **The spike gate is already passed — in production.** Step 1 of the sequencing below made
   live `getUserMedia` → AudioWorklet capture in WKWebView a go/no-go gate. The Nemotron
   streaming engine (`9c4b1cf`, `0e16ded`, `3d76768`) shipped exactly that path:
   `src/views/live-pcm-worklet.js` (PCM16 capture processor) → `setupNemotronLive` →
   `push-live-audio`. Live capture works. Drop the gate.

2. **A resident worker now exists.** `local_asr.rs` keeps `llama-mtmd-cli` alive in chat mode
   (`ResidentWorker`, `/audio <path>` + `a` per decode, 60 s idle retirement). Per-chunk
   decoding no longer reloads the ~1.3 GiB model, which removes the main cost objection to
   chunking.

3. **…but the resident worker imposes a chunk-length cap this design violates.** Reuse
   requires `cached.ctx_size == ctx_size` **exactly** (`transcribe_wav_inner`), and
   `ctx_size_for_wav` = `seconds × 20 + 512` clamped to `[2048, 16384]`. Only clips
   **≤ 76.8 s** land on the 2048 floor. Variable-length chunks longer than that each compute a
   different ctx, so every chunk kills the warm worker and spawns a fresh one — chunking would
   be *slower* than today. **Soft target 45 s → 55 s; hard max 90 s → 75 s**, so every chunk
   pins ctx at 2048 and a single worker serves the whole dictation.

Three further corrections:

- **Keep the chunker in the frontend — the resampler decides this.** Chunks must reach Qwen as
  16 kHz mono WAV, and the frontend already produces exactly that: `vad-gate.js` renders every
  local-mode clip through `new OfflineAudioContext(1, len, 16000)` and `encodeWavPcm16`
  (`vad-decision.mjs`). Cutting in Rust would mean writing a 48→16 kHz resampler (or pulling in
  `rubato`) and placing a hand-rolled one in front of the model whose accuracy is the entire
  reason for staying on Qwen. Reusing WebKit's resampler keeps every chunk identical in
  provenance to what the model is fed today. The serial decode queue is still free —
  `LOCAL_INFERENCE` (`Semaphore::const_new(1)`) serializes on the Rust side regardless — and
  chunks ride the existing `transcribe-audio` raw-body IPC, which already carries `session-id`
  as a header; `chunk-index` is one more header. No new live-session routing, and Nemotron's
  path is untouched.
- **Cut points need energy, not Silero.** Choosing *where* to slice is "find the quietest frame
  in the 55–75 s window", not a speech/non-speech verdict, so RMS over the captured PCM suffices
  and avoids running the ONNX VAD during capture. This is also why the
  `local-asr-realtime-evaluated-rejected` objection — he pauses mid-sentence to pick words, so
  VAD cuts bisect sentences — does not apply: that argument was against *sentence-level*
  cutting, where every pause is a cut decision. At one cut per ~60 s the seam picks the best of
  a 60-second window of candidates, and a bad cut costs one seam's punctuation rather than a
  lost sentence, since the audio on both sides is still transcribed.
- **Drop the post-release VAD gate on the chunked path.** Its trimming exists to stop Whisper's
  zh silence boilerplate — a cloud concern; Qwen returns empty text for silence
  (`parse_mtmd_output`). An all-empty concatenation gives the same "no speech" UI, and skipping
  the gate takes an ONNX run out of the post-release tail.

Resolved (this was an open fork): **no 16 kHz realtime `AudioContext` is needed.** The capture
context stays at the hardware rate exactly as Nemotron uses it, and each closed chunk is
resampled with `OfflineAudioContext` — the same call already shipping in `vad-gate.js`, so the
one genuinely unverified piece of this plan is gone. The worklet takes a
`processorOptions.format` of `"f32"` on this path so the chunker resamples from the original
float samples instead of round-tripping through Int16; Nemotron keeps `"i16"` and is unchanged.

Platform note: Nemotron is Apple Silicon only (`supported()` = macOS aarch64), so on
Windows/Linux Qwen chunking stays the only path to long dictation.

### How much audio actually fits in the 2048 floor (measured 2026-08-29)

The 75 s cap is set by resident-worker ctx reuse, not by what ctx 2048 can hold. Measured
directly against `llama-mtmd-cli` with the app's exact arguments (`-c 2048 --fit off -p "a"`),
TTS Chinese trimmed to exact durations:

| speech rate | last success | first failure | failure |
|---|---|---|---|
| 4.4 chars/s (normal dictation) | 125 s | 135 s | `failed to decode token` |
| 9.3 chars/s (far faster than anyone dictates) | 105 s | 110 s | `failed to decode token` |
| 4.4 chars/s | — | 160 s | `failed to decode audio` |

Two ceilings, and only one of them is content-dependent:

- **Audio tokens are fixed at ~15/s** — the encoder emits them per second of audio regardless of
  what is said. That sets a hard, content-independent ceiling of 2048 / 15 ≈ **136 s**, past
  which the audio alone overflows: the 160 s run fails with `failed to decode audio`, before any
  transcript exists.
- **Transcript tokens depend on the content**, which is why the real cliff sits below that and
  moves with speech rate: 135 s at normal pace, 110 s at nearly double the pace. Those runs fail
  with `failed to decode token` — audio fit, audio + transcript did not.

So the 75 s chunk cap carries **1.4x margin against the fastest case measured and 1.7x against
normal dictation**, and pauses make real dictation cheaper still (audio tokens accrue during a
pause, transcript tokens do not, so words-per-elapsed-second is what matters). The one case
these bounds do not cover is a degenerate repetition loop, where the decoder emits tokens until
ctx is full — a model failure rather than a content property, and one whose blast radius
chunking already limits to a single chunk.

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
- **状态：** 已按「修订 2」实现（2026-08-29）：前端 chunker、55s/75s、OfflineAudioContext 重采样、History 只写一条。2026-08-29 真机确认可用：一段听写进行到约一分钟时，悬浮窗显示出前面已解码的文字而录音继续，说明第一刀切分、录音中解码、组装器渲染、采集不中断四件事端到端都成立。仍未实测：多分钟听写（多个接缝，以及原先 >13 分钟的失败悬崖），以及接缝标点质量对照整段基线。
- **范围：** 仅本地 provider（`"local"`，Qwen3-ASR-0.6B，经 `llama-mtmd-cli`）。云端模式不动。
- **相关：** `docs/superpowers/specs/2026-07-12-local-asr-qwen3-design.md`；记忆 `local-asr-long-clip-ctx-cap-not-oom`、`local-asr-realtime-evaluated-rejected`。

## 修订 2（2026-08-29）—— 前置风险已消除，参数必须改

本设计写完之后有三件事变了。方案本身站得住，但其中两处具体规定不成立了。

1. **spike 闸门已经过了——而且是在生产代码里过的。** 下文实现顺序第 1 步把"WKWebView 里
   `getUserMedia` → AudioWorklet 实时采集"设为 go/no-go 闸门。Nemotron 流式引擎
   （`9c4b1cf`、`0e16ded`、`3d76768`）交付的正是这条路：`src/views/live-pcm-worklet.js`
   （PCM16 采集处理器）→ `setupNemotronLive` → `push-live-audio`。实时采集可用，闸门作废。

2. **常驻 worker 出现了。** `local_asr.rs` 现在让 `llama-mtmd-cli` 以 chat 模式常驻
   （`ResidentWorker`，每次解码走 `/audio <路径>` + `a`，空闲 60s 退休）。按块解码不再重载
   ~1.3 GiB 模型——分段最大的成本顾虑就此消失。

3. **……但常驻 worker 给块长加了一条本设计违反的硬约束。** 复用条件是
   `cached.ctx_size == ctx_size` **精确相等**（`transcribe_wav_inner`），而
   `ctx_size_for_wav` = `秒数 × 20 + 512`，clamp 到 `[2048, 16384]`。只有 **≤ 76.8 秒** 的音频
   才落在 2048 的 floor 上。超过这个长度的变长块各自算出不同的 ctx，于是每一块都会杀掉热
   worker 重开一个——分段反而比现在**更慢**。**软目标 45s → 55s；硬上限 90s → 75s**，让每块
   的 ctx 都钉在 2048，整段听写由同一个 worker 服务。

另外三处修正：

- **Chunker 留在前端——决定因素是重采样器。** 块必须以 16 kHz 单声道 WAV 送进千问，而前端今天
  产出的正是这个：`vad-gate.js` 把每一段本地模式的录音都过一遍
  `new OfflineAudioContext(1, len, 16000)` 加 `encodeWavPcm16`（`vad-decision.mjs`）。改在 Rust
  切就意味着要写一个 48→16 kHz 重采样器（或者引入 `rubato`），把一个手搓的重采样器摆在那个
  "识别率正是我们留在千问的全部理由"的模型前面。复用 WebKit 的重采样器，能让每一块的来路跟今天
  喂给模型的东西完全一致。串行解码队列照样白拿——`LOCAL_INFERENCE`（`Semaphore::const_new(1)`）
  在 Rust 侧本来就串行——块走现成的 `transcribe-audio` raw-body IPC，它本来就用 header 带
  `session-id`，`chunk-index` 不过是多一个 header。不需要新的 live 会话路由，Nemotron 那条路
  一个字都不用动。
- **切点要的是能量，不是 Silero。** 决定*在哪儿切*是"在 55–75s 窗口里找最安静的一帧"，不是
  语音/非语音的判定，所以对采集到的 PCM 做 RMS 就够，也免去采集期间跑 ONNX VAD。这同时解释了
  `local-asr-realtime-evaluated-rejected` 里那条反对意见——他为选词会在句中停顿，VAD 会腰斩
  句子——在这里为什么不适用：那条是针对*句级*切分的，那种方案每个停顿都是一次切分决策。这里
  每 ~60s 才切一刀，接缝是在一个 60 秒的候选窗口里挑最好的，而且切错的代价是一个接缝的标点，
  不是丢一句话——接缝两侧的音频照样都会被转写。
- **分段路上不再跑松手后的 VAD gate。** 它的裁剪是为了挡 Whisper 中文的静音套话，那是云端的
  问题；千问对静音返回空文本（`parse_mtmd_output`）。全部块都空，就给出同样的"没听到声音"
  提示，而省掉 gate 等于把一次 ONNX 运行从松手后的尾巴里拿掉。

已解决（原本是待定岔路）：**不需要 16 kHz 的实时 `AudioContext`。** 采集 context 保持硬件采样率，
跟 Nemotron 用的完全一样；每块切下来之后用 `OfflineAudioContext` 重采样——就是 `vad-gate.js` 里
已经在生产跑的那一句，于是这个计划里唯一真正没验证过的东西消失了。worklet 在这条路上接受
`processorOptions.format` 为 `"f32"`，让 chunker 从原始 float 采样重采样，而不是绕一圈 Int16；
Nemotron 继续用 `"i16"`，保持不变。

平台说明：Nemotron 只支持 Apple Silicon（`supported()` = macOS aarch64），所以在 Windows/Linux
上，千问分段仍是长听写唯一的路。

### 2048 的 floor 到底能装多长音频（2026-08-29 实测）

75 秒这个上限是常驻 worker 的 ctx 复用定的，不是 ctx 2048 装得下多少定的。用 app 完全相同的参数
（`-c 2048 --fit off -p "a"`）直接跑 `llama-mtmd-cli`，中文 TTS 截成精确时长：

| 语速 | 最后成功 | 首次失败 | 失败类型 |
|---|---|---|---|
| 4.4 字/秒（正常口述） | 125 s | 135 s | `failed to decode token` |
| 9.3 字/秒（比任何人口述都快得多） | 105 s | 110 s | `failed to decode token` |
| 4.4 字/秒 | — | 160 s | `failed to decode audio` |

两个天花板，只有一个跟内容有关：

- **音频 token 固定约 15/秒**——编码器按音频秒数产出，说什么都一样。这给出一个内容无关的硬上限
  2048 / 15 ≈ **136 秒**，超过它光音频就装不下：160 秒那次报 `failed to decode audio`，此时还没有
  任何转写文本。
- **转写 token 取决于内容**，所以真正的悬崖落在硬上限以内，且随语速移动：正常语速 135 秒，接近
  两倍语速时 110 秒。这些失败报的是 `failed to decode token`——音频装得下，音频加文字装不下。

于是 75 秒的块上限**对实测最快语速有 1.4 倍余量、对正常口述有 1.7 倍**，而且真实听写还更省：
停顿期间音频 token 照涨、转写 token 不涨，真正起作用的是「每流逝秒的字数」。这些边界唯一盖不住的
是退化的重复循环——解码器一路吐 token 直到填满 ctx，那属于模型故障而非内容属性，而分段已经把它的
影响面限制在单独一块里。

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
