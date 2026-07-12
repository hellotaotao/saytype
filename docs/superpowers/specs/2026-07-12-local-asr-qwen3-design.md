# 本地 Qwen3-ASR 转写后端(第三 provider)— 设计

日期:2026-07-12 · 来源:用户提议(试用千问 Transcribe 后认可 0.6B 本地效果)

## 目标与定位

给 SayType 增加一个**本地转写后端**:Qwen3-ASR-0.6B(阿里 2026-01-29 开源,Apache-2.0,
52 语言,中文方言/歌词均可),作为 Groq/OpenAI 之外的**第三个可选 provider**。

- **定位(已拍板)**:可选项,默认仍是云端;想用的人在设置里自行启用并下载模型。
  先验证真实效果,再谈是否升级定位(零配置默认 / 离线兜底都留作将来)。
- **明确不做**:本地润色小 LLM(标点/断句修饰)。第一步架构 = 本地 ASR 出文字 →
  照旧插入;将来的 insights/待办提取/润色交给云端大模型(TODO.md #1 方向不变)。
- **"轻"的守护**:模型不进安装包(按需下载);内存靠加载策略管住(见下),
  平时常驻仍是几十 MB。

## 引擎选型(已拍板:sherpa-onnx 进程内)

| 候选 | 结论 |
|---|---|
| **sherpa-onnx**(官方 Rust 绑定,静态链接,官方 int8 模型包) | ✅ **选它**:进程内、无进程管理、macOS/Win/Linux 官方全覆盖、与"第三 provider 分支"架构天然吻合。定案用官方 crate `sherpa-onnx = "1.13.4"`(与原生版本同步周更;社区 `sherpa-rs` 已于 2026-06 归档弃维护、无 Qwen3 支持) |
| llama.cpp sidecar(官方 `ggml-org/Qwen3-ASR-0.6B-GGUF`,llama-server 本地 HTTP) | 备选/撤退路线:Q4 下载更小、Mac 有 Metal,但进程生命周期 + 三平台 sidecar 打包,对短听写片段是过剩的 |
| antirez/qwen-asr(纯 C + BLAS) | ❌ BF16-only 静态内存 2.77 GiB、无 Windows |
| second-state/qwen3_asr_rs(纯 Rust) | ❌ 底层 libtorch/MLX,动态库巨大不利打包 |

性能参照:antirez 纯 C 实现在 M3 Max **单线程 8–13× 实时**(11s 音频 1.4s 转完)。
听写片段(几秒~一分钟)延迟与云端往返同量级,且不受网络抖动影响。CPU 推理足够,
不需要 GPU。

### 跨平台架构结论(回答最初的担忧)

**不需要每平台一套。**`platform/` 层管的是 OS 能力(插入/权限/剪贴板)——那些天生
per-OS;本地推理是**平台无关的纯计算**,sherpa-onnx 自己完成了跨平台(连安卓/iOS/
树莓派都支持)。本地后端 = `commands.rs` 转写路径的又一个分支 + 一个新模块,
一份代码三平台编译。跨平台成本只落在 CI 构建(cmake/静态库),不落在代码结构。

## 设计

### 1. 数据模型与设置

- `provider` 枚举新增 `"local"`(`groq`/`openai` 不动)。
- local 时 `model` 固定 `qwen3-asr-0.6b-int8`(保留字段,将来上 1.7B 不改结构)。
- local 不需要 API key;设置 UI 在模型下载完成前将"本地"选项置灰。

### 2. 新模块 `src-tauri/src/local_asr.rs`

职责四件:

1. **模型文件管理**:app data dir 下 `models/qwen3-asr-0.6b-int8/`,sha256 完整性校验。
   模型 6 个文件共约 955 MB(decoder.int8.onnx 721 MiB + encoder.int8.onnx 174 MiB +
   conv_frontend.onnx 42 MiB + tokenizer 三文件)。
2. **下载**:reqwest 流式下载 + 进度事件 + **断点续传**(HTTP Range);**逐文件下载**
   (免 tar.bz2 解压依赖)。**主源 ModelScope**(国内直连实测 200,文件与官方包逐字节
   相同),备用 HuggingFace `csukuangfj2`(hf-mirror 对该仓库 308 回跳 HF,不可用)。
3. **Recognizer 生命周期**(本设计最值钱的一条):
   - **录音开始时预加载**——模型加载需 1–3s,用户说话的时间足够热身,转写时零等待;
   - **闲置 10 分钟自动卸载**——常驻托盘 app 平时不占那 ~1GB;
   - 两个时长都是常量,不做设置项。
4. **`transcribe(samples) -> String`**:sherpa `OfflineRecognizer`,16k mono f32 输入。

状态挂 `AppState`:`Mutex<Option<LoadedRecognizer>>` + `last_used: Instant`。

### 3. 转写路径(`commands.rs` 改动最小化)

- `transcribe_audio` 新增 provider==local 分支:不走 reqwest,`spawn_blocking` 进
  sherpa 推理,仍包在现有 `tokio::select!` 里(cancel = 丢弃结果;推理不可中断,
  短片段可接受)。
- 下游 scrub 清洗、历史保存、插入管线**零改动复用**。
- **音频输入**:local 模式下前端 vad-gate **强制输出 16k mono WAV**(裁剪路径的
  编码器现成,只是去掉"省不足 500ms 就不重编码"的跳过条件);Rust 端解析 WAV 喂
  f32 采样,零新增解码依赖。非 WAV 到达 → 明确报错(不猜格式)。

### 4. 下载 UX(settings 窗)

provider 区新增"本地 Qwen3-ASR(0.6B)"项 + 状态行:

- **未下载**:按钮"下载模型(约 1 GB)"(实际磁盘占用 955 MB);
- **下载中**:进度条 + 取消;
- **已就绪**:显示磁盘占用 + "删除模型"。

新增 IPC 命令(老规矩三处同步:`commands.rs` / `lib.rs` `invoke_handler!` /
`ipc-bridge.js` 映射表):`download_local_model`、`cancel_local_model_download`、
`get_local_model_status`、`delete_local_model`。进度走事件
`local-model-download-progress`。

### 5. 边界行为

- **翻译模式(Shift+Alt)**:Qwen3-ASR 只转写不翻译。local 下若配过云端 key,
  翻译照旧走云端(沿用现有模型选择逻辑);没 key 则明确报错"本地模型不支持翻译"。
  (已拍板)
- **dictionary**:第一版本地不支持。Qwen3 的 context biasing 存在但 antirez 实测
  "very soft",效果待验,留待后续;设置里 dictionary 区注明"仅云端模型生效"。
- **小窗模型徽章**:显示"本地 Qwen3"(缩写表加一行)。
- **SEED_ZH 标点种子**:那是 Whisper 家族的 prompt 通道,local 分支不适用、不发送。

### 6. 错误处理

- 模型文件缺失/sha256 不符 → 转写报错并指引去设置重新下载(不静默回退云端——
  用户显式选了本地,静默换后端违反预期)。
- 加载失败(内存不足等)→ 同上,报错指引。
- 下载网络中断 → 断点续传重试;取消 → 清理半截文件(保留续传数据)。
- 转写失败的既有 UX(不自动关窗、复制按钮、指向历史)全部复用。

### 7. 测试与验证

- **第一个任务是 spike(带撤退线)**:cargo example 十几行跑通 sherpa+Qwen3-int8,
  用真实听写音频对比 Groq large-v3 的准确率/标点/速度/内存。两个风险一次排掉:
  ① sherpa 的 Qwen3 支持 2026-03 才加(有 fp32 init 修复记录,说明在活跃踩坑);
  ② int8 相对用户试用的全精度可能有退化。不达标 → 撤退到 llama.cpp sidecar 路线,
  沉没成本约半天。
- 单测:下载状态机、WAV 解析、路径/校验逻辑(纯逻辑,CI 可跑)。
- 推理冒烟测试标 `#[ignore]`(需模型文件,本地跑,CI 不跑)。
- 真机验证:真实听写走完整链路(录音 → 本地转写 → 插入),Activity Monitor 观察
  加载/卸载内存曲线。

### 8. CI / 构建影响

- **不需要 cmake**(原设计假设有误):`sherpa-onnx-sys` 的 build.rs 默认 `static`
  feature,构建时自动从 GitHub release 下载对应平台的**预编译静态库**并静态链接
  (macOS arm64/x64、Windows x64、Linux x64/aarch64 全有)。CI 腿零改动,但构建
  有网络依赖;`SHERPA_ONNX_ARCHIVE_DIR` 可指向本地压缩包离线构建。
- 二进制体积增加(macOS 静态库压缩包 19.5 MB;链接后增量待实测)。
- ⚠️ Windows 已知风险:sherpa 的 win 静态库是 **MT Release**,与 Rust MSVC 默认
  /MD CRT 可能链接冲突;若 CI 红,退路是 Windows 腿改 `shared` feature + 资源打包
  dll。Windows 本就是"编译通过但未真机验证"档,不阻塞本特性。
- Linux:代码同样编译,照常出安装包;真机验证状态与现状一致(未验)。

## 已核实的细节(2026-07-12 调研定案,原"待核实"清单)

1. **crate**:官方 `sherpa-onnx = "1.13.4"`(crates.io,k2-fsa 维护,周更);
   `sherpa-rs` 已归档,排除。config 字段:`model_config.qwen3_asr =
   OfflineQwen3ASRModelConfig { conv_frontend, encoder, decoder, tokenizer(目录), … }`。
2. **模型体积**:下载共约 983 MB(6 文件,decoder 755,914,231 B / encoder
   182,491,662 B / conv_frontend 44,148,281 B + tokenizer 三小文件);sha256 逐文件
   校验(HF LFS 元数据可取)。UI 文案"约 1 GB"。
3. **镜像**:ModelScope `zengshuishui/Qwen3-ASR-onnx`(`model_0.6B/` 下,与官方包
   逐字节相同)为主源;HF `csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25`
   备用。官方 GitHub tar.bz2(838 MB)不用(要解压依赖且单文件断点续传更难)。
4. **线程安全**:`OfflineRecognizer`/`OfflineStream` 均 `unsafe impl Send + Sync`
   ("thread-safe for single-object usage")。**recognizer 创建一次跨转写复用**
   (创建即加载全部权重,秒级);**每次转写新建 stream**,`accept_waveform` 每流
   最多一次、整段一次性喂入;采样率不符时 sherpa 内部自动重采样。
5. **性能参考**:int8 0.6B CPU RTF ≈ 0.08–0.15(官方文档/PR 基准);内存无官方
   数字,权重 955 MB,常驻估 1.2–1.8 GB(mmap 对加载延迟无改善,PR #3484)。
   Apple Silicon 实测数字留给 spike。
6. **生成长度风险(spike 必验)**:默认 `max_new_tokens=128` 对一分钟级密集中文
   听写可能截尾;计划显式设 `max_total_len: 2048, max_new_tokens: 512`,spike 用
   60–90s 长句验证无截断后定稿。
