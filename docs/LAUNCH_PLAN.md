# TypeAloud 推广计划

维护者：Tao。更新：2026-10-13。产品方向和定位依据见 [PRODUCT_PATHWAY.md](PRODUCT_PATHWAY.md)，本文只管"怎么让人知道并装上"。

## 起点（2026-10-13 实测）

- GitHub 1 star，近 14 天 4 个独立访客，没有外部来源；Hacker News 上没有任何提及。
- 最近 10 个版本共 99 次安装包下载，绝大部分是自己和自动更新。
- 官网 `typealoud.app` 已上线，中英双语，有下载按钮。
- 还没有一个陌生人在没人指导的情况下装好并用上（产品路径里的"5–10 人试用"没做）。

## 一句话

- 中文：按住说话、松手出字的免费语音输入。转写在你自己的电脑上完成，中英混着说、一口气说几分钟都稳。
- English: Free, local-first dictation for Mac and Windows. Hold a key, speak, and the text lands at your cursor. Built for mixed Chinese–English and long dictation.

"免费 + 本地"不能单独当卖点：Handy（开源，3.2 万 star）已经占了这个位置，而且也带千问模型。对外要讲的是中文这头：**装好默认就是千问、中英混说的长段口述不丢内容**（录音中分段、中文口头禅清理）。失败留档重转 Handy 也有，不当差异讲。2026-10-13 对 Handy v0.9.8 源码的核对：千问在它的目录里排第 9、不在推荐之列；口头禅清理只有英、德、法；没找到录音中分段。所以主战场是中文渠道，英文渠道排在后面，用技术角度进。

## 每次露面换一个角度

1. **用嘴给 AI 写提示词。** 天天对着 Claude Code / Codex / ChatGPT 打长段中英混杂提示词的人，是用得最勤的一群，也最集中在 V2EX、即刻、X。TypeAloud 连 "cloud code → Claude Code" 这种误听都内置修正了。首发用这个角度。
2. **原声不出电脑，不要账号不要订阅。** 给少数派、小众软件、小红书这些非开发者人群。
3. **技术篇：把 Qwen3-ASR 跑在 llama.cpp 上踩过的坑**（上下文大小、worker 复用 bug、75 秒分段、Metal 上的实测速度）。给 r/LocalLLaMA、Hacker News、掘金。
4. **免费云端润色上线后**（改口修正、自动分段），再来一轮，Product Hunt 也留到这时候。

## 上线前要补的

| 项 | 现状 | 要做 |
|---|---|---|
| **许可证** | 10/13 已改为 GPL-3.0（`LICENSE`、README、`package.json`、`Cargo.toml`、第三方声明） | 提交并推送后确认 GitHub 仓库页显示 GPL-3.0 |
| **陌生人能自己装好**（阻塞） | 没验证过 | 10/13–10/26 微信找 5–10 个熟人试一周：只给下载链接、不讲怎么装，记下每个人卡在哪、一周后还用不用 |
| README 首屏 | 10/13 已改：一句话 + 下载 + 官网放在最上面 | 还缺一张 15 秒动图（按住→说一句中英混合的话→字出现在光标处），录好放 `assets/` 并插到首屏 |
| 仓库信息 | 没有 topics，没有官网链接 | 填 homepage、topics（speech-to-text、dictation、voice-input、qwen、tauri、macos、windows） |
| 官网（`saytype-web` 仓库） | `src/App.tsx` 第 139、173、174 行仍写云端翻译（v1.16.0 已删）；没提开源 | 删翻译字样；加"开源 · GitHub"链接 |
| 反馈入口 | 10/13 已加 issue 模板 | 建一个微信群或 Telegram 群，二维码放官网和 README |
| 数据 | 匿名用量统计已接 PostHog；GitHub 下载数和来源可查 | 每波之后跑一次 `launch-report.py hellotaotao/typealoud TypeAloud`，记到文末 |
| 平台说法 | Windows 没在真机走通全流程 | 对外写"Mac 为主，Windows 测试版"，不写三平台 |

## 渠道与时间

| 日期 | 渠道 | 角度 | 稿件 | 结果 | 教训 |
|---|---|---|---|---|---|
| 10/13–10/26 | 准备：上表各项 + 熟人试用 | | | | |
| 10/27 周二 | V2EX 分享创造；同日即刻 | 1 | `docs/launch/2026-10-27-v2ex.md` | | |
| 10/29 周四 | 小众软件 发现频道 | 2 | | | |
| 11/3–11/14 | 修首发暴露的问题；投阮一峰周刊（issue 自荐）、HelloGitHub（月刊 28 日出）、awesome-mac PR、alternativeto.net 挂到 Wispr Flow / Typeless / 闪电说名下 | 1/2 | | | |
| 11/10 起每周一条 | 小红书 / B站 短视频 | 2 | | | |
| 11/17 那周 | 少数派 Matrix 长文：一段真实的工作流（比如"我三个月没怎么打字"） | 1+2 | | | |
| 12/1 周二，美西早 8–9 点 | Show HN | 3 | | | |
| 12/2–12/4 | r/LocalLLaMA（技术帖）、r/macapps（各写各的，不复制） | 3 / 2 | | | |
| 持续 | 知乎相关问题下如实回答并注明是作者；X 上在语音输入、vibe coding 话题下回复演示视频 | | | | |
| 每个值得说的版本 | 更新说明 + 选一个渠道换角度再发 | | | | |
| 条件满足后 | 自建 Homebrew tap（现在就能做，无门槛）；官方 cask 要 225 star；winget；Product Hunt 等润色上线 | 4 | | | |

哪些是主力：中文这边 V2EX、小众软件、少数派、阮一峰周刊四个决定第一批用户；短视频是唯一能碰到非开发者的路，见效慢但池子最大，"说话→字出现"天然适合拍。英文这边只有 Show HN 可能带来大波峰，但第一次常常没水花（Handy 自己首发只有 3 分，三个月后别人重发才上首页），当成要投多次的渠道。11/24 那周是美国感恩节，所以 Show HN 排到 12/1。

所有帖子和回复由 Tao 本人账号发。发帖后头 2–3 小时守着回评论。不买 star、不拉票。

## 记录

- 2026-10-13：1 star，14 天 4 访客，最近 10 版 99 次下载。计划建立；许可证改为 GPL-3.0，README 首屏重写，加 issue 模板，起草熟人试用邀请和 V2EX 首发帖。
