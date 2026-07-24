# Local ASR `--no-warmup` macOS 验证 TODO

状态：待回到 Apple Silicon Mac 后执行
记录日期：2026-07-24
相关提交：`2456ee1 perf(local-asr): skip redundant CLI warmup`

## 背景

SayType 每次本地转写都会启动一个新的 `llama-mtmd-cli` 子进程，加载模型、完成一次转写，然后退出。llama.cpp 默认在真实推理前执行一次 dummy warmup；`--no-warmup` 会跳过这次额外计算，但不会跳过模型加载、后端初始化或真实推理所必需的工作。

Windows i5-7400 CPU 真机初测：

- 同一段约 3.2 秒录音：默认 warmup 为 5.40 秒，`--no-warmup` 为 4.62 秒，改善约 14%。
- 一段 31.24 秒录音使用 `--no-warmup` 为 14.14 秒，RTF 约 0.45。
- 完整 Rust 测试和真实 Qwen 子进程 smoke test 均通过。

历史 Apple Silicon M4 数据只有默认 warmup 路径：模型热缓存加载约 0.2–0.33 秒，整体 RTF 约 0.05–0.18。尚未测量 `--no-warmup` 在 Metal 后端上的收益与风险。

## 为什么可能更快

默认 warmup 会先用模型做一轮不产生用户结果的试运行，用于预热内存页、计算内核和后端路径。对于长期驻留的模型服务，这笔成本只支付一次，后续请求可以受益。

SayType 当前不是常驻模型服务：每段录音都创建新进程，warmup 后只执行一次真实转写便退出。因此 warmup 的成本无法被第二次请求摊薄，存在成为纯固定开销的可能。

但 Metal 的必要初始化也可能只是从 warmup 移到第一次真实推理，而不是被消除。所以 Mac 是否真的更快、首次 token 是否更慢，必须实测。

## Mac A/B 测试矩阵

使用相同的：

- Apple Silicon Mac、系统版本和电源模式；
- llama.cpp `b9960`；
- Qwen3-ASR 0.6B Q8_0 模型与 mmproj；
- 上下文大小计算；
- 三段固定 WAV：短音频 3–5 秒、中等音频约 30 秒、长音频 60–90 秒。

分别测试默认 warmup 与 `--no-warmup`：

1. 每个音频、每种配置至少运行 5 次。
2. 交替运行顺序，例如 `warmup → no-warmup → no-warmup → warmup`，减少文件缓存和温度变化造成的偏差。
3. 单独记录应用/系统刚启动后的第一次转写，再记录文件热缓存后的重复转写。
4. 收集：
   - 进程总耗时；
   - 首个转写字符出现时间；
   - 完整转写完成时间；
   - 峰值 RSS；
   - 输出是否一致；
   - stderr 中是否出现 Metal、GGML、内存或初始化错误。
5. 连续完成至少 20 次短录音，检查偶发失败、卡死、取消失效和温度升高后的退化。

## 验收标准

只有同时满足以下条件，才在 Mac 保留 `--no-warmup`：

- 短音频中位数至少改善 5% 或 100 ms，且不是只在单次测量中出现；
- 首次转写与热缓存转写都没有明显回退；
- 转写文本、语言识别和静音行为无回归；
- 无新增 Metal/GGML 错误、崩溃、卡死或取消问题；
- 峰值内存没有有意义的增长。

若收益不稳定、接近测量噪声或出现任何稳定性回归，则把该参数限定为 Windows：

```rust
#[cfg(target_os = "windows")]
command.arg("--no-warmup");
```

## 发布前决策

- [ ] 在 Apple Silicon Mac 完成上述 A/B 测试。
- [ ] 记录 Mac 型号、macOS 版本、每段音频的原始结果和中位数。
- [ ] 根据数据决定跨平台保留，或改为 Windows-only。
- [ ] 决策后重新运行完整 Rust 测试与真实本地模型 smoke test。
- [ ] 在 Mac 验证完成前，不宣称 `--no-warmup` 对 Mac 有性能收益。
