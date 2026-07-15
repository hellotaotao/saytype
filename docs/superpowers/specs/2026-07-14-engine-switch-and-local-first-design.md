# 转写引擎快切 + 本地优先 — 设计

日期:2026-07-14 · 来源:用户真机验收本地 Qwen3-ASR 后的两点反馈(切换入口太深 + 本地应作主力)

## 背景与目标

本地 Qwen3-ASR 已上线且真机验收好用(标点正确、识别率好、Metal RTF~0.1)。用户提出两件事:

1. **切换引擎的入口太深**:改 provider 要进设置翻三层,想要显眼、方便的快捷入口。
2. **本地应作主力**:云端上手摩擦其实很大(注册账号、绑支付、申请 API key,5–15 分钟),而本地只是等一个下载。**能跑本地的机器就该本地优先。**

本设计交付:**托盘子菜单 + 主窗首页两处引擎快切**,**下载完成后提示切换本地**,以及**向导(onboarding)在 Apple Silicon 上把本地作为推荐首选**。

## 已定决策(2026-07-14 brainstorm)

- **性能坎 = Apple Silicon**(`cfg!(macos) && cfg!(aarch64)`):M1+ 有统一内存 + Metal,实测 RTF~0.1、零风险,且是唯一真机验证平台。Intel Mac / Win / Linux 默认云端、本地仍可手动开。**不做脆弱的运行时跑分检测。**
- **快切两处都做**:系统托盘子菜单 + 主窗首页切换器。
- **下载完成 → 提示切换,不静默切**:设置里下完弹确认;向导里选了本地路径下完则直接就是 local(选择已在点"下载"时表达)。
- **向导轻量改**:只改第 5 页(连接服务),不重写向导。

## 修订(2026-07-15 追加,用户确认)

- **范围确认**:一次性完整实现本 spec(托盘 + 首页切换器 + set_provider + 向导),不拆分。
- **推翻"只改第 5 页"**:向导**第 2 页(隐私)一并更新**。原第 2 页示意图写死"This Mac → Groq/OpenAI(用你自己的 key)"、第 5 页导语"you use your own API key",与"本地为主打"矛盾;且本地模式的隐私故事更强(音频完全不出本机),应当领跑叙事。改法见 §6b——纯文案/示意图调整,静态 i18n,不加运行时分支(本地 provider 在所有平台的设置里都可选,文案在非 Apple Silicon 上同样成立)。

## 架构总览

一个核心简化:**"智能默认"不做"感知硬件的默认值函数"**(会污染 serde 默认 / 测试 / 逻辑),而是靠**明确时刻的动作**——下载成功后提示、用户确认即切。`default_provider()` 保持 `"openai"` 不动,真正的 provider 选择由**向导**和**下载后确认切换**驱动。硬件坎(Apple Silicon)只决定一件事:**向导是否把本地当推荐首选**。

## 设计

### 1. 能力判定(后端)

- `platform::supports_local_first() -> bool`,mod.rs 契约 + `#[cfg(...)]` 实现:
  macOS+aarch64 返回 `true`,其余 `false`(macos.rs / fallback.rs 各一)。
- `SettingsPayload` 新增 `local_capable: bool`(`= platform::supports_local_first()`),
  前端据此决定向导/切换器是否主推本地。编译期常量,零运行时开销。

### 2. 轻量 provider 切换命令 + 广播

- 新增 `#[tauri::command] set_provider(app, provider: String)`(三处同步注册):
  - 校验:`local` 需 `local_asr::assets_ready()`,否则返回 Err(前端据此引导下载)。
  - provider 变化时把 `model` 重置为该 provider 默认(沿用 `save_onboarding_api_key`
    的现有逻辑:groq→whisper-large-v3-turbo,openai→gpt-4o-mini-transcribe,
    local→qwen3-asr-0.6b-q8_0);写配置(保留 dictionary / onboarding_completed /
    api keys,如现有 save 流程)。
  - 广播:复用现有 `shortcut-updated`(已带 provider+model),让 settings 徽章、
    input-prompt 徽章、主窗 readiness 全部实时更新;并触发托盘菜单重建(见 §3)。
- 托盘(Rust 直调)与首页(IPC)汇流到同一 `commands::apply_provider_change(app, provider) -> Result<()>`;
  `set_provider` 命令是它的薄封装。

### 3. 托盘引擎子菜单

- `tray.rs` `build_menu` 增加 "Engine ▸" 子菜单,含三个 `CheckMenuItem`
  (`engine-groq` / `engine-openai` / `engine-local`),勾选当前 config.provider 对应项。
  托盘文案沿用英文(与现有托盘一致)。
- 菜单事件:选中某引擎 → `apply_provider_change`;
  - 选 `local` 但 `assets_ready()==false` → **不切**,改为 `show_main_window` +
    发事件引导到设置的模型下载面板(不静默切到不可用后端)。
- provider 变化后重建托盘菜单以更新勾选态(复用 `set_update_ready` 的 `tray.set_menu`
  路径,抽出 `refresh_tray_menu(app)`;与"更新就绪"态叠加时都读当前状态重建)。

### 4. 主窗首页引擎切换器

- 在 `#home-page` 的 readiness 卡片顶部加一个分段控件
  `[ Groq | OpenAI | Local ]`(`main.html` + `main.css`),当前 provider 高亮;
  `local_capable` 为真时 Local 项带"推荐"小标。
- 点击 → `set_provider` → 广播回来后重渲染高亮。
- 选 Local 但未就绪 → 跳设置的模型下载面板(`open_settings` + 定位 Models 区,
  或直接在首页给"去下载"引导)。
- `main.js` 监听现有 `shortcut-updated` 已会刷新;切换器高亮读 `cachedSettings.provider`。

### 5. 下载完成 → 提示切换

- **设置窗**:`local-model-download-progress` 收到 `state==="ready"` 时,若当前
  provider 非 local,弹确认"本地模型已就绪,切换到本地转写?[切换 / 稍后]";
  点"切换" → `set_provider("local")`。(settings.js,复用现有事件,不新增通道。)
- **向导第 5 页本地路径**:用户点了"下载本地模型"即表达了选择,下载 `ready` 后
  直接 `set_provider("local")` 并放行到第 6 页练习,**不再弹确认**。

### 6. 向导第 5 页(仅 Apple Silicon 改版)

- `local_capable === true` 时,第 5 页置顶醒目选项
  **"本地 Qwen3 · 推荐 · 免账号 · 离线"**:点击就地下载(复用 `download-local-model`
  + 进度事件 + 现有进度条 UI),进度可见;下载完成 → provider=local、可进第 6 页。
  下方折叠"或连接云端服务" → 现有 Groq/OpenAI 卡片 + key 输入(原样)。
- `local_capable === false`:第 5 页原样(云端为主),本地不在向导出现,仅设置里可选。
- 向导内下载与设置内下载共用后端命令与事件,互不冲突(单飞守卫已在 Task 4 实现)。
- 资产已就绪时(从 Help 重开向导 / 设置里下过):本地卡直接显示"就绪 ✓",点击即 `set_provider("local")`,不再走下载。
- 第 5 页导语随之改写:不再预设"you use your own API key",改为"默认在这台电脑上本地转写,免账号;也可连接你自己的云服务"。
- 第 6 页 checklist 的"API key"行改叫"转写引擎"(readiness 语义已是"所选 provider 可用",local 下 = 资产就绪,复用现有 hasApiKey)。

### 6b. 向导第 2 页(隐私)本地优先叙事(2026-07-15 修订新增)

静态文案 + 示意图小调,无 JS 分支(所有平台成立):

- 标题保留"Your voice goes only where you point it";lead 保留"no servers of its own"。
- 示意图:节点一"This Mac"的描述从"recording · history"升级为"local model · recording · history";箭头标签改为"cloud mode only — direct, with your own key"之意(明确云端是可选路径);节点二 Groq/OpenAI 不变。
- 要点行改为三条:①"用本地模型时,音频不离开这台 Mac";②"云端模式下,音频直达你选择的服务——中间没有任何环节";③"历史记录只存在这台 Mac 上"(原 line2 保留)。

### 7. 边界与复用(均不改动既有行为)

- **翻译模式**照旧回退云端(Qwen3-ASR 只转写);local 下留着云 key。
- **has_api_key / readiness**:local 下 = 资产就绪(已实现)。首页 readiness pill 与
  新切换器并存:pill 表"就绪与否",切换器表"选哪个引擎"。
- **单飞下载守卫 / 断点续传 / sha256**:Task 4 现成,不动。
- **model 字段**跨 provider 重置逻辑:与 `save_onboarding_api_key` 一致,抽公用不重复。

### 8. 测试

- Rust 单测:`set_provider` 校验(local 未就绪被拒;切换重置 model 到该 provider 默认;
  保留 dictionary/keys)、`supports_local_first()` 平台判定(macos+aarch64 真,其余假,
  以 `cfg` 门控的测试表达)、`apply_provider_change` 写配置正确性。
- 前端:`node vad-decision.test.mjs` 保持绿(不碰纯函数);静态冒烟驱动首页切换器三态
  + 向导第5页 local_capable 真/假两种渲染 + 下载完成确认弹窗。
- 真机 E2E(手动):托盘切三引擎(勾选态跟随)、首页切换器、选未就绪 local 的引导、
  设置下完弹确认切换、向导本地路径全程、非能力平台向导退回云端(用 fallback 构建或
  临时改 cfg 验证渲染分支)。

### 9. 涉及文件

- `src-tauri/src/platform/{mod,macos,fallback}.rs` — `supports_local_first()`
- `src-tauri/src/settings.rs` — `SettingsPayload.local_capable`
- `src-tauri/src/commands.rs` — `set_provider` + `apply_provider_change`
- `src-tauri/src/lib.rs` — 注册命令
- `src-tauri/src/tray.rs` — 引擎子菜单 + `refresh_tray_menu`
- `src/views/ipc-bridge.js` — `set-provider` 映射
- `src/views/main.{js,html,css}` — 首页切换器 + 向导第5页本地路径
- `src/views/settings.js` — 下载完成确认切换
- `src/views/i18n.js` — en + zh 新文案

### 10. 不做(YAGNI / 已记 TODO)

- 运行时 RAM/核数跑分检测(Apple Silicon 坎已够;其余平台未验证,过早)。
- 静默自动切换(改为提示确认)。
- 引擎切换器不含"provider 内选具体 model"——那仍留在设置(快切只切 provider 档位)。
