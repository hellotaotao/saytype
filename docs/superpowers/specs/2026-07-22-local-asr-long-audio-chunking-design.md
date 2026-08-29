# Local ASR long-audio chunking (during-recording, Wispr-style latency hiding)

- **Date:** 2026-07-22
- **Status:** Implemented 2026-08-29 per Revision 2 (frontend chunker, 55 s / 75 s, OfflineAudioContext resampling, single history row). Confirmed working on the author's machine 2026-08-29: about a minute into a dictation the floating window showed the already-decoded earlier text while capture continued, so the first cut, the mid-recording decode, the assembler rendering and uninterrupted capture are all verified end to end. A controlled 272.47 s English TTS A/B on an M4 produced five chunks, no missing/duplicated seam words, whole-clip WER 1.47%, and chunked WER 1.20%. This is synthetic evidence; real multi-minute microphone dictation, seam punctuation, and the old >13 min failure cliff remain unverified.
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
   (`ResidentWorker`, `/audio <path>` + `a` per decode, 60 s post-decode idle retirement).
   Recording-time prewarm uses an 80 s first idle deadline so it survives the 75 s hard cut.
   Per-chunk decoding no longer reloads the ~1.3 GiB model, which removes the main cost
   objection to chunking.

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

### Controlled offline seam A/B (2026-08-29)

On an M4/24 GB Mac, a known 738-word English script was synthesized to a 272.47 s WAV. The
production cut rule yielded five chunks (55.157 s, 55.000 s, 55.115 s, 55.029 s, 52.172 s),
all at quiet frames. The same audio was decoded once as a whole clip at ctx 5961 and once as
the five chunks through one ctx-2048 resident worker.

| path | WER vs script | decode evidence |
|---|---:|---|
| whole clip | 1.47% (11 edits / 747 normalized words) | 15.85 s wall time, including process start |
| five chunks | 1.20% (9 edits / 747 normalized words) | 11.37 s decode + 0.42 s prewarm; final chunk 2.18 s |

All four joins preserved the source words in order with no duplication or omission. Chunked
WER being slightly lower is normal run-to-run/model-window variation, not evidence that
chunking improves recognition. The result clears the repeatable offline seam check; it does
not replace real-microphone punctuation and latency validation.

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

Capture Float32 PCM during recording and cut it into coarse 55–75 s chunks. After 55 s,
the first sufficiently quiet RMS frame closes the chunk; at 75 s, the quietest frame in
the 55–75 s search window is forced. Each closed chunk is resampled to 16 kHz mono WAV,
decoded through the shared resident worker, and rendered in the floating window. Release
flushes the remainder, drains the serial queue, concatenates the results, and inserts once.

### Data flow

```
mic stream ──► AudioWorklet capture (hardware-rate Float32 PCM)
                   │  PCM blocks + per-block RMS
                   ▼
              Chunker  (first quiet frame after 55 s;
                        hard-cut at 75 s on the quietest frame)
                   │  hardware-rate Float32 chunk
                   ▼
              OfflineAudioContext resample → 16 kHz mono WAV
                   │
                   ▼
              Serial decode queue  (one chunk in flight at a time)
                   │  invoke transcribe-audio { wav, sessionId, chunkIndex }
                   ▼
              Backend: resident llama-mtmd-cli, fixed ctx 2048 for every chunk
                   │  partial events; command response is the final chunk text
                   ▼
              Assembler / floating window:
                   finalized text of chunks 0..k-1  +  live partial of chunk k

release ⇒ stop capture → flush residual speech as final chunk → drain queue
        → concat chunk texts in order → single type-text insert (+ history save)
```

## Components

### 1. Real-time capture (frontend, implemented)

- `getUserMedia` feeds the existing Web Audio graph and `live-pcm-worklet.js`, which emits
  hardware-rate Float32 blocks on the Qwen path. The same stream still feeds MediaRecorder.
- The chunker computes RMS directly from each block. Silero does not run during capture.
- If AudioWorklet setup fails, `recordingSession.chunked` stays unset and the existing
  whole-clip path remains the fail-open fallback.

### 2. Chunker (frontend, new — pure logic, unit-testable)

- Accumulates live PCM. Cut policy — all thresholds are the **current chunk's elapsed audio duration** (from the previous cut, including any interior silence):
  - **Soft target 55 s:** after this point, the first frame at or below
    `loudRef × QUIET_RATIO` closes the chunk.
  - **Hard max 75 s:** if no qualifying quiet frame arrives, cut at the quietest frame in
    the 55–75 s search window.
  - `loudRef` resets after every cut, so the decision is scale-invariant across mic gains.
- Output: ordered chunk PCM buffers. A dictation shorter than the soft target yields exactly one chunk (= today's behavior).
- Boundaries prefer natural pauses, minimizing per-seam punctuation/sentence-break damage.
  Every chunk remains on ctx 2048, so one resident worker serves the entire dictation.

### 3. Serial decode queue (frontend, new)

- Chunks are enqueued in capture order and decoded **one at a time** (bounds memory/CPU to one subprocess; guarantees ordering). On Metal/CPU, decode RTF ≪ 1, so the queue never backs up behind real-time speech.
- Each item: `transcribe-audio` invoke carrying `{ wav, sessionId, chunkIndex }`; resolves to that chunk's final text.

### 4. Backend per-chunk decode (Rust, minimal change)

- Reuse `transcribe_wav`; every ≤75 s WAV maps exactly to ctx 2048. This preserves worker
  reuse and keeps peak RSS at the short-clip floor (~1.3 GiB on the measured Apple Silicon
  path). The measured fast-speech failure boundary is 110 s, leaving material headroom.
- `transcribe_audio` (local path) gains optional `sessionId` + `chunkIndex`, threaded into the partial emit so the frontend can route partials to the right chunk slot. Cloud path ignores them.
- Partial event payload is `local-transcription-partial { sessionId, chunkIndex, text }`,
  broadcast with `app.emit`. The `transcribe-audio` command response supplies the final text.

### 5. Assembler + floating window (frontend)

- Maintains `finalized[chunkIndex] = text` plus the live partial of the in-flight chunk. Rendered as `finalized.join(joiner) + livePartial`.
- **Joiner:** single space for latin, direct concatenation for CJK (or just always a space — Qwen emits per-chunk punctuation; refine during testing). Each chunk is a natural sentence group, so joins fall at pauses.

### 6. Release flush + insert

- On hotkey-up: stop capture/VAD, take residual buffered speech since the last cut as the **final chunk**, enqueue it, await full queue drain.
- Concatenate all chunk texts in order → **one** `type-text` insert into the focused app (unchanged insertion model, no clipboard fallback). Save the assembled text to History as today.

### 7. Cancel semantics

- Cancel (existing `cancel-transcription` + hotkey-cancel) sets a session-abort flag: stop dispatching new chunks, cancel the in-flight decode (existing `cancel_transcription` → `kill_on_drop`), clear the queue, discard partials, tear down capture/VAD. No insert.

### 8. Error handling

- A chunk decode failing does not abort the session: log it, keep the other chunks, and
  insert the successful concatenation on release. The 75 s cap has measured ctx headroom;
  it does not claim to make a pathological decoder repetition loop impossible.
- Silence-only chunk → empty text (existing `parse_mtmd_output` behavior) → contributes nothing.

## IPC changes (the "update three places" rule)

- `commands.rs`: `transcribe_audio` reads optional `session-id` and `chunk-index` headers
  from the raw-body request and threads them into Qwen partial events.
- `lib.rs`: the existing command remains registered.
- `ipc-bridge.js`: `tauriRawBody` maps the binary body plus both headers; the partial-event
  consumer routes by `sessionId` and `chunkIndex`.

## Platform notes

- **Metal (primary):** the first cut and mid-recording decode are verified. Tail is bounded by
  the final ≤75 s chunk; exact p50/p95 remains to be measured.
- **CPU-only (Windows/Linux, unverified):** the upstream runtime is not safe to reuse across
  audio requests. Each chunk still uses the chat protocol, but its worker is killed immediately
  after that chunk instead of being parked; the `--audio` compatibility one-shot path remains
  reserved for chat startup/protocol failures. Chunking still bounds ctx and each decode, but
  process startup and capture/decode CPU contention need real-machine measurement.

## Testing

- **Unit (pure logic, no AppHandle):** Chunker cut decisions (soft/hard/no-pause/short-clip-single-chunk); assembler ordering + joins; partial routing by `chunkIndex`. Mirror the existing `vad-decision.test.mjs` / `local_asr.rs` `#[test]` style.
- **Backend:** Rust locks the 75 s/2048 invariant; event-payload tests cover session/chunk routing.
- **Integration / regression:** first-cut behavior and the controlled 272.47 s synthetic
  whole-vs-chunked seam comparison are verified. Real-microphone multi-minute, >13-minute,
  release-tail, and seam-punctuation checks remain release gates.

## Implementation sequencing

1. AudioWorklet Float32 capture: implemented through the shipped Nemotron capture substrate.
2. Chunker and ctx invariant tests: implemented at 55 s / 75 s.
3. Serial queue, IPC routing, assembler, preview, release flush, cancel, and error handling:
   implemented.
4. Controlled synthetic seam A/B: complete. Remaining: multi-minute real-dictation
   latency/quality gates.

## Open questions

- The joiner is CJK-aware: no space when either seam edge is CJK/full-width text; one space
  between Latin chunks.
- The floating window renders finalized chunks plus the current partial, without a separate
  per-chunk processing indicator.

---

# 中文版（本设计文档的翻译）

# 本地 ASR 长音频分段（录音中切分，Wispr 式延迟隐藏）

- **日期：** 2026-07-22
- **状态：** 已按「修订 2」实现（2026-08-29）：前端 chunker、55s/75s、OfflineAudioContext 重采样、History 只写一条。2026-08-29 真机确认可用：一段听写进行到约一分钟时，悬浮窗显示出前面已解码的文字而录音继续，说明第一刀切分、录音中解码、组装器渲染、采集不中断四件事端到端都成立。同日受控 272.47s 英文 TTS A/B 产出 5 块，四个接缝没有丢词或重复；整段 WER 1.47%，分块 WER 1.20%。这是合成音频证据；真实多分钟麦克风听写、接缝标点和原先 >13 分钟的失败悬崖仍未验证。
- **范围：** 仅本地 provider（`"local"`，Qwen3-ASR-0.6B，经 `llama-mtmd-cli`）。云端模式不动。
- **相关：** `docs/superpowers/specs/2026-07-12-local-asr-qwen3-design.md`；记忆 `local-asr-long-clip-ctx-cap-not-oom`、`local-asr-realtime-evaluated-rejected`。

## 修订 2（2026-08-29）—— 前置风险已消除，参数必须改

本设计写完之后有三件事变了。方案本身站得住，但其中两处具体规定不成立了。

1. **spike 闸门已经过了——而且是在生产代码里过的。** 下文实现顺序第 1 步把"WKWebView 里
   `getUserMedia` → AudioWorklet 实时采集"设为 go/no-go 闸门。Nemotron 流式引擎
   （`9c4b1cf`、`0e16ded`、`3d76768`）交付的正是这条路：`src/views/live-pcm-worklet.js`
   （PCM16 采集处理器）→ `setupNemotronLive` → `push-live-audio`。实时采集可用，闸门作废。

2. **常驻 worker 出现了。** `local_asr.rs` 现在让 `llama-mtmd-cli` 以 chat 模式常驻
   （`ResidentWorker`，每次解码走 `/audio <路径>` + `a`，解码后空闲 60s 退休）。录音中预加载
   的首次 idle deadline 是 80s，确保覆盖前端 75s 硬切。按块解码不再重载 ~1.3 GiB 模型——
   分段最大的成本顾虑就此消失。

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

### 受控离线接缝 A/B（2026-08-29）

在 M4/24 GB Mac 上，把一份已知 738 词英文稿合成为 272.47s WAV。生产切分规则得到 5 块
（55.157s、55.000s、55.115s、55.029s、52.172s），全部落在安静帧。同一音频分别以 ctx 5961
整段解码，以及通过一个 ctx-2048 常驻 worker 分 5 块解码。

| 路径 | 对原稿 WER | 解码数据 |
|---|---:|---|
| 整段 | 1.47%（747 个规范化词中 11 个 edit） | 15.85s wall time，含进程启动 |
| 五块 | 1.20%（747 个规范化词中 9 个 edit） | 解码 11.37s + 预热 0.42s；最后一块 2.18s |

四个接缝都按原顺序保留了词，没有重复或遗漏。分块 WER 略低属于不同窗口下的正常模型波动，不能解读为
分块提高了识别率。这个结果完成了可重复的离线接缝检查，但不能替代真实麦克风的标点和尾延迟验证。

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

录音时采集 Float32 PCM，并切成 55–75 秒的粗块。55 秒之后遇到第一个足够安静的 RMS 帧
就闭合；到 75 秒仍没有合格静音，就在 55–75 秒窗口中选择最安静的帧强制切分。每个闭合块
重采样为 16 kHz 单声道 WAV，经同一个常驻 worker 解码并显示在悬浮窗。松开时冲刷余量、排空
串行队列、拼接结果并一次性插入。

### 数据流

```
麦克风流 ──► AudioWorklet（硬件采样率 Float32 PCM）
                 │  PCM block + 每块 RMS
                 ▼
            Chunker（55s 后首个安静帧切；
                     75s 时在窗口中最安静处硬切）
                 │  硬件采样率 Float32 块
                 ▼
            OfflineAudioContext 重采样 → 16 kHz 单声道 WAV
                 │
                 ▼
            串行解码队列（同一时刻只有一块在解）
                 │  invoke transcribe-audio { wav, sessionId, chunkIndex }
                 ▼
            后端：常驻 llama-mtmd-cli，每块固定 ctx 2048
                 │  partial 事件；command response 是该块最终文本
                 ▼
            组装器 / 悬浮窗：
                 已定稿的 0..k-1 块文本  +  第 k 块的实时 partial

松开 ⇒ 停止采集 → 把最后残留语音冲刷成最终块 → 排空队列
      → 按序拼接各块文本 → 一次 type-text 插入（+ 存入 History）
```

## 组件

### 1. 实时采集（前端，已实现）

- `getUserMedia` 进入现有 Web Audio 图和 `live-pcm-worklet.js`；千问路径输出硬件采样率
  Float32 block，同一条流仍供 MediaRecorder 使用。
- Chunker 直接计算每个 block 的 RMS；采集期间不运行 Silero。
- AudioWorklet 初始化失败时不设置 `recordingSession.chunked`，自动回到原有整段路径。

### 2. Chunker（前端，新增 — 纯逻辑，可单测）

- 累积实时 PCM。切分策略——所有阈值都指**当前块的已录音频时长**（从上一刀起，含中间的静音）：
  - **软目标 55s：** 此后第一个不高于 `loudRef × QUIET_RATIO` 的帧闭合该块。
  - **硬上限 75s：** 若没有合格安静帧，在 55–75s 搜索窗口中最安静的帧切开。
  - 每刀之后重置 `loudRef`，因此不同麦克风增益下的决策保持一致。
- 输出：按序的块 PCM 缓冲。短于软目标的听写只产出一块（= 今天的行为）。
- 切口优先落在自然停顿处，减少接缝标点/断句损伤。每块都落在 ctx 2048，因此整段听写
  由同一个常驻 worker 服务。

### 3. 串行解码队列（前端，新增）

- 块按采集顺序入队，**一次解一块**（把内存/CPU 限制在一个子进程；保证顺序）。Metal/CPU 上解码 RTF ≪ 1，所以队列永远不会落后于实时语音。
- 每项：`transcribe-audio` invoke，带 `{ wav, sessionId, chunkIndex }`；解析为该块的最终文本。

### 4. 后端按块解码（Rust，最小改动）

- 复用 `transcribe_wav`；每个 ≤75s WAV 都精确映射到 ctx 2048，既保住 worker 复用，也把
  Apple Silicon 实测峰值维持在短音频下限（约 1.3 GiB）。实测快速语音首次失败是 110s，
  75s 保留了明显余量。
- `transcribe_audio`（本地路）新增可选 `sessionId` + `chunkIndex`，透传进 partial 事件，好让前端把 partial 路由到正确的块槽。云端路忽略它们。
- partial payload 是 `local-transcription-partial { sessionId, chunkIndex, text }`，通过
  `app.emit` 广播；`transcribe-audio` 的 command response 提供最终文本。

### 5. 组装器 + 悬浮窗（前端）

- 维护 `finalized[chunkIndex] = text` 加上在解块的实时 partial。渲染为 `finalized.join(joiner) + livePartial`。
- **连接符（joiner）：** 拉丁文用单个空格，CJK 直接拼接（或干脆一律空格——Qwen 每块自带标点；测试时再定）。每块都是自然的句群，接缝落在停顿处。

### 6. 松开冲刷 + 插入

- 松开（hotkey-up）：停止采集/VAD，把上一刀之后残留的语音作为**最终块**入队，等待整个队列排空。
- 按序拼接所有块文本 → **一次** `type-text` 插入到聚焦的 app（插入模型不变，无剪贴板回退）。像今天一样把拼好的文本存入 History。

### 7. Cancel 语义

- Cancel（现有 `cancel-transcription` + 热键取消）置一个会话中止标志：停止派发新块、取消在解的那块（现有 `cancel_transcription` → `kill_on_drop`）、清空队列、丢弃 partial、拆除采集/VAD。不插入。

### 8. 错误处理

- 某块解码失败不中止整个会话：记录日志、保留其他块，松开时插入成功部分的拼接。75s
  上限具有实测 ctx 余量，但不声称能排除退化的 decoder 重复循环。
- 纯静音块 → 空文本（现有 `parse_mtmd_output` 行为）→ 不贡献内容。

## IPC 改动（"改三处"规则）

- `commands.rs`：`transcribe_audio` 从 raw-body request 读取可选 `session-id`、`chunk-index`
  header，并透传进千问 partial 事件。
- `lib.rs`：沿用已经注册的 command。
- `ipc-bridge.js`：`tauriRawBody` 映射二进制 body 和两个 header；partial 消费方按
  `sessionId`、`chunkIndex` 路由。

## 平台说明

- **Metal（主平台）：** 第一刀和录音中解码已验证；松手尾巴受最后一个 ≤75s 块约束，
  准确 p50/p95 仍待测量。
- **纯 CPU（Windows/Linux，未验证）：** upstream runtime 不能跨音频请求安全复用。每块仍走
  chat 协议，但完成该块后会立即杀掉 worker，而不是放回 resident slot；`--audio` 兼容
  one-shot 路径只用于 chat 启动或协议失败。分块仍限制 ctx 和单次解码长度，但进程启动与
  录音/解码争核需要真机数据。

## 测试

- **单元（纯逻辑，无 AppHandle）：** Chunker 切分决策（软/硬/无停顿/短音频单块）；组装器排序 + 连接；按 `chunkIndex` 的 partial 路由。仿照现有 `vad-decision.test.mjs` / `local_asr.rs` `#[test]` 风格。
- **后端：** Rust 测试锁定 75s/2048 不变量；事件 payload 测试覆盖 session/chunk 路由。
- **集成 / 回归：** 第一刀和 272.47s 合成音频 whole-vs-chunked 接缝对照已验证。真实麦克风
  多分钟、>13 分钟、松手尾延迟和接缝标点仍是 release gate。

## 实现顺序

1. AudioWorklet Float32 采集：复用已经交付的 Nemotron 采集基础设施，已实现。
2. Chunker 与 ctx 不变量测试：55s/75s，已实现。
3. 串行队列、IPC 路由、组装器、preview、松开冲刷、cancel、错误处理：已实现。
4. 受控合成音频接缝 A/B 已完成；剩余是多分钟真实听写的延迟/质量 gate。

## 待定问题

- Joiner 已采用 CJK 感知规则：接缝任一侧是 CJK/全角字符则不加空格；拉丁文本块之间加一个空格。
- 悬浮窗显示已定稿块加当前 partial，不增加独立的“处理中”标记。
