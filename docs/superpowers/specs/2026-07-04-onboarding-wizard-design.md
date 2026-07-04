# 首启 Onboarding 向导(六页)— 设计

日期:2026-07-04 · 前置:同日的 Accessibility onboarding(`00ad7e3`,readiness 卡引导面板)。
用户看过三页版 mockup 后拍板:**信息密度是第一原则** —— 拆成更多页、每页只做一件事、留足呼吸感;
Groq 明确作推荐(免费额度宽松,对绝大多数用户等于免费);练习框很重要,保留并做收尾主角。

## 结构:主窗首启接管视图,六页

不开新窗(延续 6/30 原则)。`settings.onboardingCompleted === false` 时主窗被
`#onboarding` 全窗 overlay 接管;完成**或跳过**都置位落盘,以后正常进首页;
「帮助」按钮改为重新打开向导(它涵盖了旧快捷键 toast 的全部信息且可随时跳过)。
readiness 卡保留,作为日常兜底(权限中途被撤等)。

1. **欢迎**:一句主张(说话,就是打字)+ 三步图示(按住 {快捷键} → 开口说话 → 文字上屏)。
2. **隐私**:「你的声音,只去你指定的地方」+ 流向图(这台 Mac → 你的 key 直连 → Groq/OpenAI)+
   两行事实(无中转 / 历史只在本机)。放在要权限**之前**,先建立信任框架。
3. **麦克风**:一句话 + 「启用麦克风」按钮 —— 点击做一次瞬时 `getUserMedia`(立即 stop)主动触发
   TCC 弹窗,而不是等首次听写时突袭;拒绝态给「打开麦克风设置」深链(新增
   `open_microphone_settings`,Privacy_Microphone pane)+ 窗口 focus 时重查。
4. **辅助功能**:与 readiness 卡引导面板**共享同一套 i18n 文案和一键流程**
   (`startAccessibilityFlow` + 1s/90s 轮询 + 授权自动继续);状态(等待/超时/已就绪)由
   `refreshReadiness` 统一汇入(所有 AX 状态变化都经过它)。
5. **连接服务**:Groq(推荐 · 免费)/ OpenAI 二选一卡片 + key 输入 + 保存。
6. **说第一句**:练习输入框(placeholder 带真实快捷键)+ 翻译模式作为「进阶」tip 在此引入
   (在动手场景里学)。练习框走真实插入链路 —— 主窗此刻是前台聚焦窗口,CGEvent 会把转写
   打进这个框(待真机确认;有坑则只留文字引导,不影响其余页面)。

页面骨架是 main.html 静态 markup(data-i18n),动态部分(keycaps、权限状态、provider/key 表单、
圆点/按钮)由 main.js 渲染。已满足的项显示 ✓(不自动跳页);正在看的页面上刚完成的项
900ms 后自动进下一页。快捷键均从 settings 实时取(`{keys}` 模板 + keycap chips)。

## 持久化与安全(关键决策)

- `AppConfig` / `SettingsPayload` 增加 `onboarding_completed`(serde default false —— 老配置文件
  缺字段 → 向导恰好显示一次)。
- **`save_settings` 必须显式保留该字段**(同 dictionary):settings 表单不带它,缺字段反序列化为
  false,否则每次保存设置都会重新触发向导。已加注释 + 测试。
- 向导不用 `save_settings` 存 key:它要求完整 AppConfig,主窗构造它就得先拿到全部 key,破坏
  eb9dc38 的「key 只发给 settings 窗」。改为两个专用读-改-写命令:
  - `set_onboarding_completed()` —— 置位。
  - `save_onboarding_api_key(provider, api_key)` —— 设 provider + 对应 key 字段,**key 只进不出**;
    provider 实际变化时把 model 重置为该 provider 默认(groq→whisper-large-v3-turbo,
    openai→gpt-4o-mini-transcribe),否则新配置会把 OpenAI 默认模型名发给 Groq 报错;
    provider 没变则不动 model(重跑向导不覆盖自选模型);完了 `broadcast_settings_updates`
    让小窗模型徽章实时更新。

## 验证

- `cargo test` 28 通过(含新增 `onboarding_completed_roundtrips_and_defaults_false`)。
- 静态服务 + 浏览器真实渲染(无 Tauri → IPC 超时 → 首启态):六页、麦克风三态、AX
  等待/超时/就绪态、provider 切换(placeholder/帮助文案跟随)、页脚导航(开始/下一步/完成、
  跳过在末页隐藏、上一步在首页隐藏)、完成关闭 overlay、中英文案、明暗主题 —— 全部截图确认。
- 真机验收(用户):`tccutil reset` 两个权限 + 删/改 config 的 `onboardingCompleted` → 首启走完
  整个流程,重点确认:mic 弹窗时机、AX 授权自动继续、练习框能接住真实听写插入。
