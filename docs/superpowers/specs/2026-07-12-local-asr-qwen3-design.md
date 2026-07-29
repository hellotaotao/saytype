# 本地 Qwen3-ASR 转写后端(第三 provider)— 设计

日期:2026-07-12 · 来源:用户提议(试用千问 Transcribe 后认可 0.6B 本地效果)
**修订 2026-07-13:引擎定案从 sherpa-onnx 改为 llama.cpp 子进程**(两轮真机实测后用户拍板;
sherpa 版设计见本文件 git 历史)。

## 目标与定位

给 SayType 增加一个**本地转写后端**:Qwen3-ASR-0.6B(阿里 2026-01-29 开源,Apache-2.0,
52 语言,中文方言/歌词均可),作为 Groq/OpenAI 之外的**第三个可选 provider**。

- **定位(已拍板)**:可选项,默认仍是云端;想用的人在设置里自行启用并下载模型。
  先验证真实效果,再谈是否升级定位(零配置默认 / 离线兜底都留作将来)。
- **明确不做**:本地润色小 LLM(标点/断句修饰)。第一步架构 = 本地 ASR 出文字 →
  照旧插入;将来的 insights/待办提取/润色交给云端大模型(TODO.md #1 方向不变;
  llama.cpp 落地后本地润色的边际成本极低,已在 TODO.md #1 记录触发条件)。
- **"轻"的守护**:模型与推理二进制都不进安装包(启用时按需下载);推理在**独立子进程**
  里进行。**2026-07-30 性能修订**:利用 b9960 原生 chat mode 在连续听写之间保温,
  空闲 60 秒后自动杀进程并释放约 1.3GB;取消、切换到云端、删除模型和退出应用也会杀
  worker。chat 协议异常时自动退回原来的一次性子进程路径。

## 引擎选型(已拍板:llama.cpp 子进程;两轮真机实测)

| 候选 | 结论 |
|---|---|
| **llama.cpp 子进程**(官方 `ggml-org/Qwen3-ASR-0.6B-GGUF` Q8_0,`llama-mtmd-cli` chat worker,60 秒 idle retirement) | ✅ **选它**。M4 实测:Metal 解码 RTF 0.05–0.18(sherpa CPU ~0.30),峰值 RSS ~1.34GB 恒定,**CPU 满载时性能不受影响**。M1 实测每次新进程约有 0.99s 模型加载成本;b9960 的 `/audio` chat 命令可在同一进程连续转写,两段固定音频总耗时 4.56s,对照独立进程约 5.64s。取消 = 杀 worker;协议失败 = 一次性进程 fallback。 |
| sherpa-onnx 进程内(官方 Rust crate,int8) | ❌ 降级为备选。spike 已验证可用(质量达标、API 零偏差),但 CPU-only:RTF ~0.30、解码峰值 2.1GB、常驻 1.6GB 需自管闲置卸载、机器忙时严重劣化。撤退路线保留:git 历史里有完整 sherpa 版计划。 |
| antirez/qwen-asr(纯 C + BLAS) | ❌ BF16-only 静态内存 2.77 GiB、无 Windows |
| second-state/qwen3_asr_rs(纯 Rust) | ❌ 底层 libtorch/MLX,动态库巨大不利打包 |

实测报告:`.superpowers/sdd/task-1-report.md`(sherpa spike)、
`.superpowers/sdd/llamacpp-benchmark-report.md`(llama.cpp 对照,本地文件不入库)。

### 关键实测事实(2026-07-12/13,M4 24GB)

1. **⚠️ ctx-size 脚枪(必须显式设置)**:`llama-mtmd-cli` 默认 `--ctx-size 0` 会按模型
   元数据(65536)预分配 **7 GiB KV cache**,RSS 冲到 8.2GB;显式 `-c 2048` 后 KV 224MiB、
   RSS ~1.34GB,**输出逐字节一致**。集成必须带 `-c 2048`。
2. **调用形态**:`llama-mtmd-cli -m <gguf> --mmproj <mmproj.gguf> --audio <wav> -p "a" -c 2048`
   —— `-p` 必须给非空占位串,否则 CLI 进交互模式挂住;输出带 `language <lang><asr_text>` 前缀,
   需解析剥离。
3. **量化现状**:官方 GGUF 仓库只有 Q8_0 / bf16,**没有 Q4**。Q8_0 两个文件共
   1,019,141,728 B(~972MB):`Qwen3-ASR-0.6B-Q8_0.gguf` 804,749,248 B +
   `mmproj-Qwen3-ASR-0.6B-Q8_0.gguf` 214,392,480 B。HF 直连实测顺畅。
4. **质量**:干净语音上与 sherpa int8 持平(60s 长句双方 100% 内容正确、标点 23 个);
   困难内容上错误模式各异(sherpa 在噪声音频上稳定复现多一句幻觉;llama Q8 偶有同音字
   替换如 轮胎→轮台)。标点表现双双完胜 Groq Whisper 的零标点。真实使用是最终裁判。
5. **静音**:≥5s 的纯静音/白噪输入干净返回空;但 **≤2s 的纯数字零静音会幻觉出"嗯。"**
   (时长相关,Task 3 实测复现;真实环境底噪静音各时长均干净)。VAD 门保留——它在上传前
   就拦掉无语音片段,恰好把这条路径盖死(便宜的保险 + 已有件)。
6. **llama.cpp 版本锁定**:用 ≥ b9173 的版本(修复了 Qwen3-ASR 重复循环 bug #22357);
   实测用 build 9960。锁定一个 release build,升级须回归。
7. **无语言指定参数**(与 sherpa 相同的 v1 限制):模型自动检测语言,设置里的"语言"
   选项对 local provider 不生效(实测中英自动识别均正确)。文档注明。

### 跨平台架构结论(回答最初的担忧,修订后仍成立)

**不需要每平台一套,更不需要为 Mac 另写 Swift 原生版**(用户曾提议,已否决——Metal
提速来自 llama.cpp 子进程自身,与宿主语言无关;Swift 重写=数月重踩已解决的坑 + 永久双
代码库,收益≈0;行业证据:Wispr Flow 也是 Electron + 小 helper,未走全原生)。

应用代码三平台同一条路径:`spawn(llama-mtmd-cli, args)`。平台差异只体现在**下载哪个
预编译二进制包**(macOS arm64 = Metal 版;Windows x64 / Linux x64 = CPU 版,官方
release 均有)。Win/Linux 上 CPU 解码没有 Metal 红利(速度约回到 sherpa 档),但两平台
本就是"能编译、未真机验证"档,不受影响。

## 设计

### 1. 数据模型与设置

- `provider` 枚举新增 `"local"`(`groq`/`openai` 不动)。
- local 时 `model` 固定 `qwen3-asr-0.6b-q8_0`(保留字段,将来换量化/上 1.7B 不改结构)。
- local 不需要 API key;设置 UI 在资产(模型+二进制)就绪前不允许保存 local。

### 2. 新模块 `src-tauri/src/local_asr.rs`

职责三件(仍由子进程隔离模型;增加一个短时保温生命周期):

1. **资产清单与就绪检查**:app data dir 下 `local-asr/`——`models/` 放两个 GGUF
   (精确字节数 + sha256 校验),`bin/<llama-build>/` 放解压后的 `llama-mtmd-cli`
   (+ 随包动态库)。就绪 = 两个 GGUF 尺寸精确匹配 + 当前平台二进制存在可执行。
2. **下载**:reqwest 流式 + 进度事件 + 断点续传(HTTP Range),复用一套机制下载三个
   工件:两个 GGUF(HF `ggml-org` 直连,主源;镜像可用性实现时探测)+ 一个官方
   llama.cpp release zip(GitHub,锁定 build,sha256 校验后解压到 `bin/<build>/`,
   unix 置可执行位)。由我们的 app 下载 → 无浏览器 quarantine 属性 → 无 Gatekeeper
   拦截问题;二进制不进安装包,安装包体积不变。
3. **子进程转写**:`transcribe_wav(wav_bytes) -> Result<String>`——写临时 WAV →
   复用同 context size 的 chat worker(`/clear`→`/audio <path>`→`a`)→解析 stdout
   (剥 `language <lang><asr_text>` 前缀)→清理临时文件。`--fit off` 避免每次重复
   device fitting;local-only semaphore 保证全入口最多一个 Metal decode。worker 空闲
   60 秒卸载;取消会因 `kill_on_drop` 杀掉正在运行的 worker。chat 协议错误或超时后
   丢弃 worker,并用原有 `--audio ... -p "a"` 一次性子进程重试,保留详细 stderr 诊断。

### 3. 转写路径(`commands.rs` 改动最小化)

- `transcribe_audio` 加路由层:provider==local 且非翻译 → `local_asr::transcribe_wav`,
  仍包在现有 `tokio::select!` 里(取消 = 子进程被杀,真正中止,比云端 fetch-abort 还干净)。
- 下游 scrub 清洗、历史保存、插入管线**零改动复用**。
- **音频输入**:local 模式下前端 vad-gate **强制输出 16k mono WAV**(裁剪路径的编码器
  现成;VAD 失败时走无 VAD 的纯 WebAudio 解码+编码回退)。mtmd 的 miniaudio 解码器
  不吃 AAC/m4a,所以 WAV 前置转换是硬要求。非 WAV 到达 → 明确报错(不猜格式)。

### 4. 下载 UX(settings 窗)

provider 区新增"Local · Qwen3-ASR"项 + 状态行:

- **未下载**:按钮"下载模型(约 1 GB)"(GGUF ~972MB + llama 二进制包 ~数十 MB);
- **下载中**:进度条 + 取消(断点续传,zip 解压为最后一步);
- **已就绪**:显示磁盘占用 + "删除模型"(连 bin 一起删)。

新增 IPC 命令(老规矩三处同步):`download_local_model`、`cancel_local_model_download`、
`get_local_model_status`、`delete_local_model`。进度走事件 `local-model-download-progress`。

### 5. 边界行为

- **翻译模式(Shift+Alt)**:Qwen3-ASR 只转写不翻译。local 下若配过云端 key,翻译照旧
  走云端(Groq 优先);没 key 则明确报错。(已拍板)
- **dictionary**:第一版本地不支持(mtmd 的 prompt 通道对 ASR 是模板占位,context
  biasing 待后续调研),设置里注明"仅云端模型生效"。
- **语言选择**:local 下不生效(自动检测),文档注明。
- **小窗徽章**:显示"Qwen3 · Local";local+翻译时显示云端回退("Cloud Whisper")。
- **SEED_ZH 标点种子**:Whisper 家族的 prompt 通道,local 分支不适用、不发送
  (Qwen3 自己标点就好)。

### 6. 错误处理

- 资产缺失/损坏(sha256 不符)→ 转写报错并指引重新下载(**不静默回退云端**——用户显式
  选了本地,静默换后端违反预期)。
- 子进程非零退出/输出不可解析 → 报错并把 stderr 摘要入日志(计数与关键行,不含转写文本)。
- 下载网络中断 → 断点续传重试;取消 → 保留 .part 供续传。
- 转写失败的既有 UX(不自动关窗、复制按钮、指向历史)全部复用。

### 7. 测试与验证

- 单测:资产清单/就绪检查/下载状态机(tempdir 固件)、stdout 解析(真实输出样本)、
  路由决策表;子进程冒烟测试标 `#[ignore]`(需真实资产,本地跑,CI 不跑)。
- 真机验证:从零下载 → 听写 → 插入全链路;取消中途下载再续传;转写中取消(进程被杀);
  Activity Monitor 确认转写间隙内存归零;机器高负载下转写速度不劣化。
- **sherpa spike 遗留清理**:移除 `sherpa-onnx`/`hound` 依赖与 `examples/qwen3_spike.rs`
  (数据已沉淀在报告与本 spec;git 历史可回溯)。

### 8. CI / 构建影响

- **归零**:llama.cpp 是运行时按需下载的外部工件,不参与编译链接——CI 三条腿完全不变,
  连 sherpa 方案的"build.rs 联网拉静态库"都省了。二进制体积回到基线(+`zip`/`sha2` 等
  纯 Rust 小依赖)。
- Windows CRT 冲突风险(sherpa 方案的遗留担忧)随 sherpa 一起消失。

## 已核实的细节(2026-07-12/13 两轮实测定案)

1. **引擎**:llama.cpp 官方预编译 release(锁 build,如 b9960),`llama-mtmd-cli` 每次
   转写一个子进程。sherpa-onnx 撤退路线完整保留在 git 历史。
2. **模型**:`ggml-org/Qwen3-ASR-0.6B-GGUF` Q8_0 两文件共 972MB(字节数见上),HF 直连;
   无 Q4 变体。
3. **必带参数**:`-c 2048`(否则 8.2GB RSS 脚枪)、`-p "a"`(否则挂交互模式)。
4. **性能**(M4):RTF 0.05–0.18、加载 0.2–0.33s、峰值 RSS ~1.34GB 恒定、CPU 满载免疫。
5. **无语言指定、无词典通道**(v1 限制,文档注明)。
6. **每平台工件**:macos-arm64(Metal)/ win-x64(CPU)/ linux-x64(CPU)官方 zip;
   应用代码零分叉。
