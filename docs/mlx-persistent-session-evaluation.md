# MLX persistent Session 可行性评估

日期：2026-07-30
机器：MacBook Air（M1，7-core GPU，16 GB）

## 结论

暂不把 MLX 加入 SayType 的产品代码。

MLX 路线已有可试的社区实现，但当前机器和 SayType 已下载资产不足以做可复现的
性能、内存和准确率验收。先上线已经真机验证的 llama.cpp chat worker；只有 MLX
通过下面的准入 benchmark，才值得承担第二套运行时、模型格式和跨平台 fallback。

## 已验证事实

- 本机没有 `mlx`、`mlx_lm`、`transformers` Python module，也没有 `mlx`/`mlx_lm`
  命令。
- 本机没有缓存的 MLX Qwen3-ASR 权重。
- SayType 当前资产是
  `Qwen3-ASR-0.6B-Q8_0.gguf` + `mmproj-Qwen3-ASR-0.6B-Q8_0.gguf`；它们是
  llama.cpp GGUF/mmproj，不能直接交给 MLX model loader。
- Qwen 官方 Qwen3-ASR 仓库当前文档列出的本地 Python 后端是 Transformers 和
  vLLM，没有 MLX 后端：
  <https://github.com/QwenLM/Qwen3-ASR>
- Apple 官方 `mlx-examples` 当前列出的语音识别示例是 Whisper，没有列出
  Qwen3-ASR：
  <https://github.com/ml-explore/mlx-examples>
- 社区 `mlx-audio` 已列出 Qwen3-ASR，并给出
  `mlx-community/Qwen3-ASR-0.6B-8bit` 的加载示例：
  <https://github.com/Blaizzy/mlx-audio>

因此 MLX spike 至少需要安装新的 Python/MLX 运行时，并下载一套独立的 MLX 权重。
本次工作不安装或下载任何东西，无法对该候选作公平 benchmark。

## 进入产品代码前的准入条件

在独立 spike 目录中完成，不先修改 SayType：

1. 锁定 `mlx-audio`、MLX 和模型 revision；记录许可证、下载字节数和 SHA-256。
2. 使用与 M1 llama.cpp 诊断完全相同的 16 kHz mono WAV。
3. 对比：
   - 首次模型加载时间；
   - persistent session warm wall-clock；
   - 首个 partial text 延迟；
   - 峰值和 idle RSS；
   - 60 秒 idle unload 后是否归零；
   - 连续 20 次是否有内存增长。
4. 使用一组经授权的中英真实录音比较逐字输出、WER/CER、标点和静音幻觉；合成
   `say` 音频只能用于速度，不能用于质量结论。
5. 验证取消、超时、模型损坏、进程崩溃和应用退出都不会遗留 Python/MLX worker。
6. 明确 Windows/Linux 继续使用 llama.cpp；MLX 必须是 macOS 可选后端，不能影响
   当前约 1 GB 的默认下载体验。

## 建议的通过门槛

只有同时满足以下条件才继续集成：

- warm 中位数至少比 llama.cpp chat worker 快 20%；
- 首个 partial text 延迟至少改善 20%；
- 输出质量不劣于当前 Q8_0；
- idle RSS 能按时释放，无孤儿进程；
- 新增下载体积和打包/更新策略可接受。

当前 llama.cpp 已能原生复用同一进程内的模型，MLX 不再是消除固定加载成本的必要
条件，而是一个需要用更高门槛证明价值的替代后端。
