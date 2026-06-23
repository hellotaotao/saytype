# SayType 神经网络 VAD — 设计文档（中文版）

**日期:** 2026-06-21 · **分支:** `feat/neural-vad` · **状态:** 设计中,待评审
> 本文为便于阅读的中文版,与 [`2026-06-21-neural-vad-design.md`](2026-06-21-neural-vad-design.md) 同步;如有出入**以英文版为准**。

## 问题

Whisper 在静音 / 近静音音频上会产生幻觉。由于我们把用户词典当成 Whisper 的 `prompt` 传过去
(`src-tauri/src/commands.rs:500`),最典型的退化输出就是**把 prompt 原样吐回来**。已证实的痛点
(场景 A):一次误触、或一大段没说话,会产出严重的幻觉 / prompt 回吐,然后被当成正常听写插进输入框。

按住说话(push-to-talk)的语义是"按住键 = 我要说话",所以主要的坏情况是**整段(近乎)静音**,
而不是"有语音、中间夹着停顿"。

## 目标 / 非目标

- **目标:** 当一段录音**不含语音**时,直接跳过转录(gate-only)—— 消灭静音幻觉 + prompt 回吐,
  且**不误杀**"声音轻但确实在说话"的录音。
- **目标:** 神经网络级别的检测质量(对电平鲁棒)、跨平台打包干净。
- **非目标(v1):** 对**含有**语音的录音裁剪内部 / 首尾静音。推迟到 Phase 2,且很可能根本不需要 ——
  Whisper 会以前后真实语音作锚点,内部停顿很少触发幻觉。
- **非目标:** 实时 / 流式 VAD。我们是离线的:先录完整段,再处理。

## 决策:路线 B —— 前端 WASM 神经网络 VAD

三个想要的属性 **{neural-Silero、跨平台干净、纯 Rust/无 JS}** 不可能同时拥有(见"Spike 结论")。
我们**放弃纯 Rust**,保住另外两个。

- 在**已有的 WKWebView** 里,用 **`@ricky0123/vad-web`**(onnxruntime-web,WASM)跑 **Silero VAD v5**。
  一次打包、三端 webview 各自运行;**无 native dylib、不动签名/notarization 流程**;**Rust 后端完全不动**。
- **为何不用纯 Rust `tract`:** Phase-0 spike 已证明 tract 无法把 Silero v5 构建成可运行图(形状推理穿不过
  模型的嵌套 `If` 控制流 + LSTM `decoder/Squeeze`)。所有在维护的 Rust Silero crate 都用 `ort`,无一用 tract。
- **为何不用 Rust `ort`:** 需要每平台一个 native onnxruntime 库 + macOS 对该 `.dylib` 的 notarization ——
  这正是我们最想躲开的跨平台税(跨平台是第一优先级)。
- **接受的代价:** 引入 JS/WASM 依赖,破了项目"无 JS 运行时 / 无 bundler"的惯例。**缓解:** 把资源
  **vendored**(无 bundler、无 npm 运行时步骤)放到 `src/views/vendor/`,用 `<script type="module">` 引入,
  保住静态服务。

## 架构与数据流

采集不变(`getUserMedia` → `MediaRecorder` → `Blob`,macOS 上是 mp4/AAC)。

**新增前端 gate** —— 在 `input-prompt.js` 里,录音停止后、调用 `transcribe-audio` 之前:

1. `Blob` → `AudioContext.decodeAudioData` → `AudioBuffer`。
2. `OfflineAudioContext` 渲染 → **单声道 Float32 PCM @ 16 kHz**(重采样;**仅 VAD 内部用** —— 见下方说明)。
3. `NonRealTimeVAD.run(pcm16k, 16000)` → 语音段 `[{start, end}, …]`。
4. 累加语音时长。**若总时长 < `vad_min_speech_ms`(默认 250 ms)→ 无语音:** 不调 `transcribe-audio`;
   显示一个简短的 **"未检测到语音"** 状态(新 i18n 串 `inputPrompt.noSpeech`,约 1 秒),然后清理麦克风、
   回到 idle;且**不写 history**。否则 → 跟现在完全一样,上传**原始、未改动**的 blob。

gate 放在前端,所以本 feature **完全不动 Rust 后端**(不改 `transcribe_audio`)。*(早先设想过一个后端兜底
—— 若转录结果等于词典 `prompt` 就置空 —— 已被否决:词典内容原样出现**可能就是正确转录**,比如用户只说了
词典里的某一个词;把它压掉会让那个词"怎么都说不出来"。而 VAD gate 已经从根上消除了触发 prompt 回吐的静音。)*

**关于采样率:** 录音维持**原生采样率(~48 kHz)**,上传的是原始压缩 blob。Whisper 服务端无论如何都会
重采样到 16 kHz,所以以 16 kHz 采集对质量**毫无收益**;上面那个 16 kHz 步骤**仅供 VAD 内部使用**。而且在
WKWebView 里强制 16 kHz 采集并不可靠(`sampleRate` 约束常被忽略),你多半还是得自己重采样。**关于上传体积:** 本平台
没有便宜的办法 —— 实测 WebKit 的 MediaRecorder **会忽略 `audioBitsPerSecond`**(请求 32 kbps 仍得到
~155 kbps AAC-LC / 48 kHz / 立体声,与默认几乎一样)。真要压缩得重新编码(WebCodecs 或后端编码器)——
额外 CPU + 复杂度,对短听写片段不值,故录音保持原样。

## 组件与边界

- **`src/views/vendor/vad/`** —— vendored 的 `@ricky0123/vad-web` ESM + onnxruntime-web 的 `.wasm` +
  Silero v5 的 `.onnx`。固定版本 + 出处记录在同目录的 `PROVENANCE.md`。`onnxruntime-web` 的 `wasmPaths`
  和 vad 的模型路径都指向这些本地资源 URL。
- **`src/views/vad-gate.js`**(新增,小模块)—— 单一职责:`async hasSpeech(blob) →
  { speech: boolean, totalSpeechMs, segments }`。封装 解码 → 重采样 → VAD → 阈值。首次使用时**懒加载**
  WASM/模型(第一次录音前不付加载成本)。边界清晰、可测:输入 `Blob`,输出判定;调用方看不到 onnxruntime。
- **`input-prompt.js`** —— 在 停止→转录 的路径里调用 `hasSpeech()` 并分支;跳过分支上渲染
  `inputPrompt.noSpeech` 状态。
- **`i18n.js`** —— 新增 `inputPrompt.noSpeech` 文案。
- **配置**(`settings.rs` / 设置 JSON):`vad_enabled`(默认 `true`)、`vad_min_speech_ms`(默认 `250`)、
  `vad_threshold`(Silero 正语音阈值,默认 `0.5`)。UI 开关可选、可后补;默认值开箱即用。

Rust 后端(`commands.rs` / `transcribe_audio`)**不被本 feature 修改**。

## 阶段划分

**Phase 0 —— 先消运行时风险(最先做;对标 tract spike)。**
新的未验证假设是:*onnxruntime-web + vad-web 到底能不能在 WKWebView 里加载并运行*(Tauri 资源协议;
SIMD/线程 / SharedArrayBuffer 是否可用)?在做整套功能之前:vendored 资源后,在 input-prompt 的 webview 里
懒加载 `NonRealTimeVAD`,对一个已知 buffer(一段内置语音 + 一段静音)跑一遍;**结果通过已有的文件日志输出**,
从日志文件读,而不是 webview console(见"dev 验证坑"记忆)。
- **通过:** 在 WKWebView 里无错加载;语音 → 有段,静音 → 无段。
- 若 ort-web 需要 Tauri 不提供的 SharedArrayBuffer/COOP-COEP,确认它能回退到单线程 WASM(离线 30 s 录音足够)。
  出现硬阻塞 → 重新考虑路线 A(`ort`)/ C(`webrtc-vad`)。

**Phase 1 —— gate-only 集成。** `vad-gate.js` 模块 + `input-prompt.js` 接线(含 `noSpeech` 状态)+ 配置项 + 测试。

**Phase 2 —— 可选,仅当真实使用中观察到场景 B 时做。** 裁剪内部 / 首尾静音(重组 PCM → WAV/重编码再上传)
+ UI 灵敏度控制。

## 测试

- **`vad-gate.js` 判定逻辑:** 单测那个纯阈值函数(段 + 阈值 → `speech` 布尔 / `totalSpeechMs`),不依赖模型。
- **真模型校验:** 一个小的 dev-webview harness,对内置的 `speech`/`silence` fixture 跑真 VAD 并断言 gate 判定
  (这同时是 Phase 0 的交付物,提级复用)。
- **手测(核心担忧):** 远讲 / 轻声的真实语音**绝不能**被丢;误触 / 静音**必须**被丢。默认值要偏向**保留**。

## 风险

1. **onnxruntime-web 在 WKWebView 里** —— 由 Phase 0 解决。含 Tauri 资源协议下 `.wasm` 的 MIME/路径
   (MIME 不对时 ort-web 会从 `instantiateStreaming` 回退到 arraybuffer)。
2. **重采样正确性** —— 确认 vad-web 期望的输入采样率;我们用 `OfflineAudioContext` 喂 16 kHz Float32 并传
   `sampleRate = 16000`(若它内部重采样,则是 no-op)。
3. **阈值调参** —— 默认值要偏向保留真实语音;用远讲/轻声样本验证。
4. **包体积** —— ort-web 的 `.wasm` + Silero 的 `.onnx`(~2 MB)进 app 包。可接受。
5. **vendoring 维护** —— 固定版本、记录出处、手动更新(solo 项目)。

## Spike 结论(已敲定的事实,2026-06-21）

- `tract`(纯 Rust)**无法**运行 Silero v5(嵌套 `If` 形状推理失败)。Rust + neural ⇒ 必须带 native
  onnxruntime(`ort`)dylib —— 因此走路线 B。
- `symphonia`(纯 Rust,`isomp4`+`aac`)能干净解码本 app 的 mp4/AAC —— 仅当将来把 VAD 移回后端才相关。
- 录音是 48 kHz;VAD 路径会重采样到 16 kHz 给 Silero(仅 VAD 内部;录音本身不变)。

## 执行中的修订（Task 0.1, 2026-06-22）

实际 vendor 这个库(vad-web 0.0.30 + onnxruntime-web 1.27.0)后,上文有几处被细化;以已提交的
`src/views/vendor/vad/PROVENANCE.md` 为准(那是确切文件 + 加载配方的 source of truth):

- 离线 API `NonRealTimeVAD` 加载的是 **Silero *legacy*** 模型(`silero_vad_legacy.onnx`,1536 采样 / 96ms 帧),
  不是 v5 —— 做"有没有语音"的 gate 足够。(干掉纯 Rust 的 tract spike 是在 v5 图上做的,那个结论不变。)
- vad-web **内部自带重采样** —— 把解码出的**原生采样率(~48 kHz)**单声道 `Float32` 直接传给
  `run(pcm, nativeSampleRate)` 即可,**不需要 `OfflineAudioContext` 重采样**(数据流比上文更简)。
- `run()` 产出 `{ audio, start, end }`,**start/end 单位是毫秒**(源码确认:`(frameIndex * 1536) / 16`),
  所以 `MIN_SPEECH_MS = 250` 正确。
- 加载是**两个经典脚本**:先 `ort.wasm.min.js`(→ `window.ort`)再 `bundle.min.js`(→ `window.vad`,它把 ort
  当外部全局 `window.ort`)。设 `ort.env.wasm.numThreads = 1` 以规避 WKWebView 下的 SharedArrayBuffer / COOP-COEP 需求。
- 真实 vendored 体积 **~15 MB**(13 MB 是 onnxruntime-web 的 wasm 运行时),不是风险一节估的 ~2 MB。已接受。
