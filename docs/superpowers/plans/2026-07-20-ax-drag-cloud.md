# 辅助功能授权「拖拽小云朵」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AX 引导流程中弹出一个含 app 图标的置顶小浮窗,用户可直接把它拖进系统设置的辅助功能列表,把"找到 + 添加 + 开启"压缩成一个手势。

**Architecture:** 第四个 Tauri 窗口(照搬 input-prompt 的无边框/透明/置顶/`focus:false` 配置)渲染 HTML 云朵;在它的 `ns_view()` 上叠一个用 `objc::declare::ClassDecl` 运行时声明的 NSView 子类,`mouseDragged:` 里发起 `public.file-url` 拖拽,负载是自己的 `.app` bundle。生命周期由主窗现有的 AX 引导流程驱动。

**Tech Stack:** Rust / Tauri 2.10.3 / `objc 0.2.7`(已在用)/ AppKit FFI / 无打包器的静态 HTML+CSS+JS

## Global Constraints

- **平台**:仅 macOS 实现;`platform/fallback.rs` 提供空实现,非 macOS 编译必须通过。
- **IPC 三处同步**:每个新命令必须同时改 `commands.rs` 的 `#[tauri::command]`、`lib.rs` 的 `generate_handler!`、`ipc-bridge.js` 的 `tauriCommands`(带参数的还要 `tauriArgs`)。`scripts/ipc-contract.test.mjs` 会在 CI 拦截漏登记。
- **事件广播**:Rust→前端一律用 `app.emit`(广播),**不要用 `emit_to`** —— 前端监听器注册的 target 是 `{ kind: "Any" }`,`emit_to` 会被静默丢弃。
- **文案**:所有用户可见字符串进 `src/views/i18n.js`,英文 + 中文两套,不得硬编码进 HTML。
- **窗口 `focus:false` 是硬要求**:用户正在「系统设置」里点开关,浮窗抢焦点会打断他。因此**键盘事件收不到,Escape 不可用**。
- **测试命令**:Rust `cargo test --manifest-path src-tauri/Cargo.toml`(**从仓库根目录跑,不要管道接 `tail`**,那会掩盖退出码);Node `node --test src/views/*.test.mjs scripts/*.test.mjs`。
- **提交信息**结尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## 对 spec 的一处修正(实现前已确认)

Spec 里把"先 spike 便宜的 `dragFile:`"的风险写成"异步 IPC 上下文拿不到有效 NSEvent"。**这个担心不成立**:覆盖层本来就必须是一个实现了 `mouseDragged:` 的自定义 NSView,而在那个回调里 NSEvent 是现成参数,不经过 IPC。两条 API 路线因此都从同一个 `mouseDragged:` 里发起,成本差别只有"要不要实现 `NSDraggingSource` 协议方法"(约 20 行),不是 50 行 vs 200 行。计划按 `dragFile:` 优先、失败退到 `beginDraggingSessionWithItems:` 组织,两条都给出完整代码。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src-tauri/src/platform/macos.rs`(改) | 新增 `app_bundle_of` / `app_bundle_path`,并让既有 `finder_reveal_target` 复用前者 |
| `src-tauri/src/platform/drag_cloud.rs`(**新**) | 全部 unsafe objc:运行时声明 NSView 子类、拖拽发起、`hitTest:` 穿透。独立成文件,避免把已近 400 行的 `macos.rs` 撑爆 |
| `src-tauri/src/platform/fallback.rs`(改) | 非 macOS 空实现 |
| `src-tauri/src/platform/mod.rs`(改) | 模块声明与契约注释 |
| `src-tauri/src/ax_cloud.rs`(**新**) | 云朵窗口的显示/隐藏/定位,不含 objc |
| `src-tauri/src/commands.rs`(改) | 两个新命令 |
| `src-tauri/src/lib.rs`(改) | 模块声明、命令注册、入口脚本注入 |
| `src-tauri/tauri.conf.json`(改) | 第四个窗口 `ax-cloud` |
| `src/views/ax-cloud.{html,css,js}`(**新**) | 云朵 UI |
| `src/views/i18n.js`(改) | 文案 |
| `src/views/ipc-bridge.js`(改) | 命令映射 |
| `src/views/main.js`(改) | 接进 AX 引导流程的生命周期 |

---

### Task 1: bundle 路径解析(拖拽负载的来源)

拖拽负载必须是 `.app` bundle。dev 构建跑的是裸二进制,没有 bundle——那时云朵**不显示**,而不是拖一个没用的二进制过去。既有的 `finder_reveal_target` 解析同一个东西但语义不同(它回退到 exe),两者共用底层逻辑。

**Files:**
- Modify: `src-tauri/src/platform/macos.rs`(`finder_reveal_target` 在第 79 行附近;测试模块在文件末尾 `mod tests`)
- Modify: `src-tauri/src/platform/fallback.rs`
- Modify: `src-tauri/src/platform/mod.rs`(契约注释)

**Interfaces:**
- Produces: `platform::app_bundle_path() -> Option<std::path::PathBuf>` —— 安装态返回 `Some(/path/to/SayType.app)`,裸二进制返回 `None`。非 macOS 恒为 `None`。

- [ ] **Step 1: 写失败的测试**

加到 `src-tauri/src/platform/macos.rs` 末尾的 `mod tests` 里,紧挨着既有的 `finder_reveal_prefers_the_app_bundle_over_the_binary`:

```rust
  #[test]
  fn app_bundle_is_some_only_inside_a_real_bundle() {
    use std::path::Path;
    // 安装态:exe = SayType.app/Contents/MacOS/saytype,上溯三级即 bundle。
    assert_eq!(
      app_bundle_of(Path::new("/Applications/SayType.app/Contents/MacOS/saytype")),
      Some(Path::new("/Applications/SayType.app"))
    );
    // dev 裸二进制:没有 .app 祖先 → None(云朵据此不显示)。
    assert_eq!(
      app_bundle_of(Path::new("/Users/tao/code/SayType/target/debug/saytype")),
      None
    );
    // 上溯三级存在但不是 .app,同样不算。
    assert_eq!(
      app_bundle_of(Path::new("/a/b/c/d/saytype")),
      None
    );
  }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml app_bundle_is_some`
Expected: 编译失败,`cannot find function 'app_bundle_of' in this scope`

- [ ] **Step 3: 实现,并让既有函数复用它**

在 `src-tauri/src/platform/macos.rs` 里,把既有的 `finder_reveal_target` 整块替换成下面三个函数(注意保留它上面那段解释性注释):

```rust
/// 上溯三级找 `.app` bundle(exe = SayType.app/Contents/MacOS/x)。
/// 裸二进制(dev 构建)返回 None。
fn app_bundle_of(exe: &std::path::Path) -> Option<&std::path::Path> {
  exe
    .ancestors()
    .nth(3)
    .filter(|path| path.extension().is_some_and(|ext| ext == "app"))
}

/// What to reveal in Finder for "drag SayType into the Accessibility list":
/// the .app bundle when running installed, else the bare executable.
fn finder_reveal_target(exe: &std::path::Path) -> &std::path::Path {
  app_bundle_of(exe).unwrap_or(exe)
}

/// 拖拽云朵的负载路径。**只有真正的 bundle 才有意义**——裸二进制拖进辅助功能
/// 列表不会让 SayType 获得权限,所以此时返回 None,调用方据此不显示云朵。
pub fn app_bundle_path() -> Option<std::path::PathBuf> {
  let exe = std::env::current_exe().ok()?;
  app_bundle_of(&exe).map(std::path::Path::to_path_buf)
}
```

- [ ] **Step 4: 加非 macOS 空实现**

`src-tauri/src/platform/fallback.rs`,加在既有的 `pub fn reveal_app_in_finder() {}` 旁边:

```rust
/// 非 macOS 没有辅助功能授权这回事,也就没有拖拽云朵。
pub fn app_bundle_path() -> Option<std::path::PathBuf> {
  None
}
```

- [ ] **Step 5: 更新契约注释**

`src-tauri/src/platform/mod.rs`,在既有的 `//! fn reveal_app_in_finder();` 下面加一行:

```rust
//! fn app_bundle_path() -> Option<std::path::PathBuf>;
```

- [ ] **Step 6: 跑测试确认通过(含既有测试没被 DRY 重构改坏)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 全部通过,含 `app_bundle_is_some_only_inside_a_real_bundle` 和既有的 `finder_reveal_prefers_the_app_bundle_over_the_binary`

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/platform/macos.rs src-tauri/src/platform/fallback.rs src-tauri/src/platform/mod.rs
git commit -m "feat(platform): resolve the .app bundle path for the drag payload

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 云朵窗口外壳(HTML/CSS/JS + 窗口声明)

先把看得见的部分做出来并在浏览器里验完,再碰 objc。此任务结束后云朵能被手动打开、长得对、中英/明暗都正常,但还不能拖。

**Files:**
- Create: `src/views/ax-cloud.html`, `src/views/ax-cloud.css`, `src/views/ax-cloud.js`
- Modify: `src-tauri/tauri.conf.json`(`app.windows` 数组)
- Modify: `src/views/i18n.js`

**Interfaces:**
- Produces: 窗口 label `ax-cloud`;DOM 中 `#cloud`(整朵云根节点)、`#closeBtn`(右上角关闭按钮,**Task 4 的 `hitTest:` 要靠它的固定尺寸**)。
- Consumes: 无。

- [ ] **Step 1: 加窗口声明**

`src-tauri/tauri.conf.json` 的 `app.windows` 数组末尾追加(照搬 input-prompt 的浮窗配置):

```json
    {
      "label": "ax-cloud",
      "url": "ax-cloud.html",
      "width": 200,
      "height": 230,
      "decorations": false,
      "transparent": true,
      "alwaysOnTop": true,
      "focus": false,
      "skipTaskbar": true,
      "resizable": false,
      "visible": false
    }
```

- [ ] **Step 2: 写 HTML**

Create `src/views/ax-cloud.html`。CSP 照抄 `main.html` 第 5 行那条(不需要 `ipc:`,这个窗口不传原始字节):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self';">
  <title>SayType</title>
  <link rel="stylesheet" href="material-icons.css">
  <link rel="stylesheet" href="ax-cloud.css">
</head>
<body>
  <div id="cloud">
    <button id="closeBtn" type="button" aria-label="Close">
      <span class="material-icons">close</span>
    </button>
    <img id="appIcon" src="icon.png" alt="SayType" draggable="false">
    <div id="hint"></div>
  </div>
  <script src="i18n.js"></script>
</body>
</html>
```

- [ ] **Step 3: 放图标资源**

云朵里的图标不能靠 `NSWorkspace`(那是拖拽时跟手的图,不是窗口内容)。复制现有 app 图标到前端目录:

```bash
cp src-tauri/icons/128x128@2x.png src/views/icon.png
```

- [ ] **Step 4: 写 CSS**

Create `src/views/ax-cloud.css`。窗口是 `transparent:true`,所以 body 必须透明,云朵自己画背景。**关闭按钮固定 28×28 并钉在右上角** —— Task 4 的 `hitTest:` 会按这个尺寸在 AppKit 坐标系里挖洞,改尺寸必须同步改那边的常量:

```css
:root {
  --cloud-bg: rgba(252, 251, 248, 0.97);
  --cloud-border: rgba(31, 38, 38, 0.12);
  --cloud-text: #2a2a24;
  --cloud-muted: #6b635a;
}

@media (prefers-color-scheme: dark) {
  :root {
    --cloud-bg: rgba(38, 38, 46, 0.97);
    --cloud-border: rgba(255, 255, 255, 0.14);
    --cloud-text: #f2f2f5;
    --cloud-muted: rgba(255, 255, 255, 0.7);
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: transparent;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
  /* 整朵云是拖拽源,禁掉文本选中,拖动时才不会变成选字。 */
  user-select: none;
  -webkit-user-select: none;
}

#cloud {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 18px;
  border-radius: 18px;
  background: var(--cloud-bg);
  border: 1px solid var(--cloud-border);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22);
  color: var(--cloud-text);
}

/* 固定 28×28 —— 与 drag_cloud.rs 的 CLOSE_BUTTON_SIZE 必须一致。 */
#closeBtn {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--cloud-muted);
  cursor: pointer;
}

#closeBtn:hover { background: rgba(127, 127, 127, 0.16); }
#closeBtn .material-icons { font-size: 16px; }

#appIcon {
  width: 84px;
  height: 84px;
  pointer-events: none; /* 事件交给覆盖层,别被 img 吃掉 */
}

#hint {
  font-size: 12.5px;
  line-height: 1.45;
  text-align: center;
  color: var(--cloud-muted);
}
```

- [ ] **Step 5: 加文案**

`src/views/i18n.js`,英文块的 `inputPrompt: {` (约 311 行)那一节**之后**、与它同级加:

```javascript
      axCloud: {
        hint: "Drag me into the list",
        close: "Close",
      },
```

中文块的 `inputPrompt: {`(约 644 行)那一节**之后**、同级加:

```javascript
      axCloud: {
        hint: "把我拖进列表",
        close: "关闭",
      },
```

> **注意**:这句 `hint` 的最终措辞取决于 Task 6 实测"拖进去开关会不会自动打开"。会自动开就保持现在这句;不会的话改成 "Drag me in, then switch it on" / "把我拖进去,然后打开开关"。

- [ ] **Step 6: 写 JS**

Create `src/views/ax-cloud.js`。这个窗口极简:填文案 + 关闭按钮。**注意它是 `focus:false`,收不到键盘事件,所以没有 Escape 处理**:

```javascript
document.documentElement.setAttribute("data-ax-cloud-js-ran", "1");

const ipc = window.__SAYTYPE_IPC__;
const { initI18n, t } = window.SayTypeI18n;

async function initAxCloud() {
  await initI18n(ipc);
  document.getElementById("hint").textContent = t("axCloud.hint");
  document.getElementById("closeBtn").setAttribute("aria-label", t("axCloud.close"));
  document.getElementById("closeBtn").addEventListener("click", () => {
    // 这个窗口 focus:false,收不到键盘事件——这是唯一的手动关闭入口。
    ipc.invoke("hide-ax-cloud").catch((error) => {
      console.error("Failed to hide the drag cloud:", error);
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { void initAxCloud(); }, { once: true });
} else {
  void initAxCloud();
}
```

- [ ] **Step 7: 浏览器里验外观**

```bash
python3 -m http.server 4321 --directory src/views
```

用 Browser 工具打开 `http://localhost:4321/ax-cloud.html`。IPC 不可用是预期的(`initI18n` 会走失败路径),用注入的 inline `<script>` 直接填文案验外观:

```javascript
document.getElementById("hint").textContent = "把我拖进列表";
```

Expected:云朵居中、圆角、有阴影;图标 84px 清晰;关闭按钮在右上角且 hover 有底色;`prefers-color-scheme: dark` 下配色跟着变(用 `resize_window` 的 `colorScheme` 切)。验完 `pkill -f "http.server 4321"`。

- [ ] **Step 8: 提交**

```bash
git add src/views/ax-cloud.html src/views/ax-cloud.css src/views/ax-cloud.js src/views/icon.png src/views/i18n.js src-tauri/tauri.conf.json
git commit -m "feat(ax-cloud): floating cloud window shell

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 显示/隐藏命令与定位

**Files:**
- Create: `src-tauri/src/ax_cloud.rs`
- Modify: `src-tauri/src/commands.rs`(命令加在 `reveal_app_in_finder` 附近)
- Modify: `src-tauri/src/lib.rs`(模块声明、`generate_handler!`、入口脚本注入)
- Modify: `src/views/ipc-bridge.js`

**Interfaces:**
- Consumes: `platform::app_bundle_path()`(Task 1)
- Produces: IPC 命令 `show-ax-cloud` / `hide-ax-cloud`(前端名),Rust 侧 `show_ax_cloud` / `hide_ax_cloud`;`ax_cloud::show(&AppHandle) -> bool`(返回是否真的显示了——没有 bundle 时为 false)、`ax_cloud::hide(&AppHandle)`

- [ ] **Step 1: 写模块**

Create `src-tauri/src/ax_cloud.rs`:

```rust
//! 辅助功能授权拖拽云朵的窗口生命周期。objc 拖拽本身在
//! `platform::attach_app_drag_source`,这里只管窗口的显示/隐藏/定位。

use tauri::{AppHandle, Manager, PhysicalPosition};

const WINDOW_LABEL: &str = "ax-cloud";

/// 显示云朵。返回 false 表示**没有**显示——dev 裸二进制没有 .app bundle,
/// 拖它进列表不会让 SayType 获得权限,不如不出现。
pub fn show(app: &AppHandle) -> bool {
  if crate::platform::app_bundle_path().is_none() {
    log::info!("ax-cloud: no .app bundle (dev build?), not showing the drag cloud");
    return false;
  }

  let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
    log::error!("ax-cloud: window '{WINDOW_LABEL}' is missing from tauri.conf.json");
    return false;
  };

  position_left_of_center(&window);

  if let Err(error) = window.show() {
    log::error!("ax-cloud: failed to show: {error}");
    return false;
  }
  // focus:false 只在创建时生效;show 之后再置顶一次,确保它压在系统设置之上。
  let _ = window.set_always_on_top(true);
  true
}

pub fn hide(app: &AppHandle) {
  if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
    let _ = window.hide();
  }
}

/// 「系统设置」通常居中偏右打开,所以云朵放屏幕左侧三分之一处、垂直居中,
/// 尽量不挡住用户要点的那个列表。按显示器实际尺寸算,不硬编码像素。
fn position_left_of_center(window: &tauri::WebviewWindow) {
  let Ok(Some(monitor)) = window.current_monitor() else {
    return;
  };
  let screen = monitor.size();
  let Ok(size) = window.outer_size() else {
    return;
  };
  let x = (screen.width as i32) / 6 - (size.width as i32) / 2;
  let y = (screen.height as i32) / 2 - (size.height as i32) / 2;
  let _ = window.set_position(PhysicalPosition::new(x.max(20), y.max(20)));
}
```

- [ ] **Step 2: 加命令**

`src-tauri/src/commands.rs`,加在既有的 `reveal_app_in_finder` 命令后面:

```rust
/// 显示 AX 拖拽云朵。返回是否真的显示了(dev 裸二进制下为 false),
/// 前端据此决定要不要在流程结束时去隐藏它。
#[tauri::command]
pub fn show_ax_cloud(app: AppHandle) -> bool {
  crate::ax_cloud::show(&app)
}

#[tauri::command]
pub fn hide_ax_cloud(app: AppHandle) {
  crate::ax_cloud::hide(&app);
}
```

- [ ] **Step 3: 注册模块、命令与入口脚本**

`src-tauri/src/lib.rs` 三处:

模块声明(第 1-10 行那组 `mod` 里,按字母序放在 `mod commands;` 前):

```rust
mod ax_cloud;
```

入口脚本常量(第 14-16 行那组旁边):

```rust
const AX_CLOUD_ENTRY_SCRIPT: &str = include_str!("../../src/views/ax-cloud.js");
```

`on_page_load` 的 match(第 47-50 行),在 `"input-prompt"` 那行后加:

```rust
        "ax-cloud" => Some(("data-ax-cloud-js-ran", AX_CLOUD_ENTRY_SCRIPT)),
```

`generate_handler!` 列表里加两项:

```rust
      commands::show_ax_cloud,
      commands::hide_ax_cloud,
```

- [ ] **Step 4: 加前端映射**

`src/views/ipc-bridge.js` 的 `tauriCommands` 表里加两行(两个命令都无参数,不需要动 `tauriArgs`):

```javascript
    "show-ax-cloud": "show_ax_cloud",
    "hide-ax-cloud": "hide_ax_cloud",
```

- [ ] **Step 5: 跑契约测试确认三处齐了**

Run: `node --test scripts/ipc-contract.test.mjs`
Expected: PASS。**如果这步红了,说明三处没同步**——报错会指出哪一侧缺哪个命令,按提示补齐。

- [ ] **Step 6: 确认编译与全量测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 编译通过,既有 73 个测试仍全绿

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/ax_cloud.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/views/ipc-bridge.js
git commit -m "feat(ax-cloud): show/hide commands and screen positioning

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: objc 拖拽源(核心,唯一只能真机验的部分)

在云朵窗口的 `ns_view()` 上叠一个运行时声明的 NSView 子类。它做三件事:`mouseDragged:` 发起文件拖拽;`hitTest:` 在右上角 28×28 挖洞让关闭按钮可点;声明 `NSDraggingSource` 协议。

> **预期需要编译迭代。** 这是无法在写计划时编译的 unsafe FFI,`Encode` 实现和 selector 签名很可能第一次编不过。逐个跟着编译器报错修,不要推倒重来。

**Files:**
- Create: `src-tauri/src/platform/drag_cloud.rs`
- Modify: `src-tauri/src/platform/mod.rs`(模块声明 + 契约)
- Modify: `src-tauri/src/platform/fallback.rs`(空实现)
- Modify: `src-tauri/src/ax_cloud.rs`(show 时挂上覆盖层)

**Interfaces:**
- Consumes: `platform::app_bundle_path()`(Task 1);`ax_cloud::show`(Task 3)
- Produces: `platform::attach_app_drag_source(ns_view: *mut std::ffi::c_void) -> bool`

- [ ] **Step 1: 写 objc 模块**

Create `src-tauri/src/platform/drag_cloud.rs`:

```rust
//! AX 拖拽云朵的原生拖拽源。
//!
//! 为什么必须走 objc:macOS 的隐私列表接受拖入 `.app` 文件(等价于点 "+"),
//! 但拖拽源必须往拖拽剪贴板放 `public.file-url`,而 **WKWebView 的 HTML5
//! 拖拽做不到**(安全限制,JS 不能凭空造任意路径的 file-url 拖出)。所以在
//! webview 之上叠一个自定义 NSView 来接管拖拽手势。

use std::ffi::c_void;
use std::path::Path;
use std::sync::Once;

use objc::declare::ClassDecl;
use objc::runtime::{Class, Object, Sel};
use objc::{class, msg_send, sel, sel_impl};

/// 与 ax-cloud.css 的 `#closeBtn` 尺寸必须一致——改一处必须改另一处。
const CLOSE_BUTTON_SIZE: f64 = 28.0;
const NS_DRAG_OPERATION_COPY: u64 = 1;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct NSPoint {
  pub x: f64,
  pub y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct NSSize {
  pub width: f64,
  pub height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct NSRect {
  pub origin: NSPoint,
  pub size: NSSize,
}

unsafe impl objc::Encode for NSPoint {
  fn encode() -> objc::Encoding {
    unsafe { objc::Encoding::from_str("{CGPoint=dd}") }
  }
}

unsafe impl objc::Encode for NSSize {
  fn encode() -> objc::Encoding {
    unsafe { objc::Encoding::from_str("{CGSize=dd}") }
  }
}

unsafe impl objc::Encode for NSRect {
  fn encode() -> objc::Encoding {
    unsafe { objc::Encoding::from_str("{CGRect={CGPoint=dd}{CGSize=dd}}") }
  }
}

/// bundle 路径存在 ivar 里,拖拽时取出来构造 NSURL。
const IVAR_BUNDLE_PATH: &str = "_sayTypeBundlePath";

fn nsstring(value: &str) -> *mut Object {
  unsafe {
    let cls = class!(NSString);
    let bytes = value.as_ptr() as *const c_void;
    msg_send![cls, stringWithUTF8String: bytes]
  }
}

/// `mouseDragged:` —— 拖拽从这里发起。NSEvent 是现成参数,不经过 IPC,
/// 所以老 API `dragFile:` 需要的事件上下文在这里是有效的。
extern "C" fn mouse_dragged(this: &mut Object, _cmd: Sel, event: *mut Object) {
  unsafe {
    let path: *mut Object = *this.get_ivar(IVAR_BUNDLE_PATH);
    if path.is_null() {
      return;
    }
    let bounds: NSRect = msg_send![this, bounds];
    let _: bool = msg_send![
      this,
      dragFile: path
      fromRect: bounds
      slideBack: true
      event: event
    ];
  }
}

/// 拖拽操作类型:Copy(把 app 添加进列表,不是移动它)。
extern "C" fn source_operation_mask(
  _this: &Object,
  _cmd: Sel,
  _session: *mut Object,
  _context: i64,
) -> u64 {
  NS_DRAG_OPERATION_COPY
}

/// 右上角 28×28 返回 nil,点击穿透到底下 HTML 的关闭按钮。
/// 云朵是 focus:false 收不到键盘事件,这是唯一的手动关闭入口,必须能点。
/// 注意 AppKit 的原点在左下角,所以"右上角"是 x 大、y 大。
extern "C" fn hit_test(this: &Object, _cmd: Sel, point: NSPoint) -> *mut Object {
  unsafe {
    let bounds: NSRect = msg_send![this, bounds];
    let in_close_x = point.x >= bounds.size.width - CLOSE_BUTTON_SIZE;
    let in_close_y = point.y >= bounds.size.height - CLOSE_BUTTON_SIZE;
    if in_close_x && in_close_y {
      return std::ptr::null_mut();
    }
    let this_ptr: *const Object = this;
    this_ptr as *mut Object
  }
}

fn overlay_class() -> &'static Class {
  static REGISTER: Once = Once::new();
  static mut CLASS: *const Class = std::ptr::null();

  unsafe {
    REGISTER.call_once(|| {
      let superclass = class!(NSView);
      let mut decl = ClassDecl::new("SayTypeDragCloudOverlay", superclass)
        .expect("SayTypeDragCloudOverlay already registered");
      decl.add_ivar::<*mut Object>(IVAR_BUNDLE_PATH);
      decl.add_method(
        sel!(mouseDragged:),
        mouse_dragged as extern "C" fn(&mut Object, Sel, *mut Object),
      );
      decl.add_method(
        sel!(draggingSession:sourceOperationMaskForDraggingContext:),
        source_operation_mask as extern "C" fn(&Object, Sel, *mut Object, i64) -> u64,
      );
      decl.add_method(
        sel!(hitTest:),
        hit_test as extern "C" fn(&Object, Sel, NSPoint) -> *mut Object,
      );
      CLASS = decl.register();
    });
    &*CLASS
  }
}

/// 在给定的 NSView 上叠一个覆盖全区域的拖拽层。返回是否挂上了。
pub fn attach(ns_view: *mut c_void, bundle_path: &Path) -> bool {
  if ns_view.is_null() {
    return false;
  }
  let Some(path_str) = bundle_path.to_str() else {
    return false;
  };

  unsafe {
    let parent = ns_view as *mut Object;
    let bounds: NSRect = msg_send![parent, bounds];

    let overlay: *mut Object = msg_send![overlay_class(), alloc];
    let overlay: *mut Object = msg_send![overlay, initWithFrame: bounds];
    if overlay.is_null() {
      return false;
    }

    let path_obj = nsstring(path_str);
    let _: () = msg_send![path_obj, retain];
    (*overlay).set_ivar(IVAR_BUNDLE_PATH, path_obj);

    // 跟随父视图尺寸变化(窗口不可 resize,但 Retina 切换等仍会重排)。
    // NSViewWidthSizable(2) | NSViewHeightSizable(16)
    let _: () = msg_send![overlay, setAutoresizingMask: 18u64];
    let _: () = msg_send![parent, addSubview: overlay];
    true
  }
}
```

- [ ] **Step 2: 接进 platform 契约**

`src-tauri/src/platform/mod.rs`,在既有的 `#[cfg(target_os = "macos")] mod macos;` 旁边加:

```rust
#[cfg(target_os = "macos")]
mod drag_cloud;
```

并在 macos.rs 里加对外函数(放在 `app_bundle_path` 下面):

```rust
/// 在云朵窗口的 NSView 上挂拖拽层。没有 .app bundle 时不挂(返回 false)。
pub fn attach_app_drag_source(ns_view: *mut std::ffi::c_void) -> bool {
  match app_bundle_path() {
    Some(bundle) => super::drag_cloud::attach(ns_view, &bundle),
    None => false,
  }
}
```

`src-tauri/src/platform/fallback.rs` 加空实现:

```rust
pub fn attach_app_drag_source(_ns_view: *mut std::ffi::c_void) -> bool {
  false
}
```

`src-tauri/src/platform/mod.rs` 的契约注释加一行:

```rust
//! fn attach_app_drag_source(ns_view: *mut std::ffi::c_void) -> bool;
```

- [ ] **Step 3: 在 show 时挂上覆盖层(只挂一次)**

`src-tauri/src/ax_cloud.rs`,在 `show` 里 `window.show()` **之前**插入。用 `Once` 保证多次显示只挂一层:

```rust
use std::sync::Once;

static ATTACH_OVERLAY: Once = Once::new();

// …在 show() 里,position_left_of_center(&window) 之后:
  ATTACH_OVERLAY.call_once(|| {
    match window.ns_view() {
      Ok(view) => {
        if !crate::platform::attach_app_drag_source(view) {
          log::error!("ax-cloud: failed to attach the drag overlay");
        }
      }
      Err(error) => log::error!("ax-cloud: ns_view() unavailable: {error}"),
    }
  });
```

- [ ] **Step 4: 编译(预期要迭代)**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: 可能报 `Encode`/selector 签名相关错误。常见修法:`msg_send!` 的返回类型标注不对(加显式类型)、`Encoding::from_str` 在新版 objc 里签名不同、`static mut` 触发新版 Rust 的 `static_mut_refs` 警告(用 `addr_of!` 或 `OnceLock<usize>` 存类型指针)。**逐个按报错修,保持结构不变。**

- [ ] **Step 5: 全量测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 全绿(此任务没有新单测——objc 拖拽只能真机验,见 Task 6)

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/platform/drag_cloud.rs src-tauri/src/platform/mod.rs src-tauri/src/platform/macos.rs src-tauri/src/platform/fallback.rs src-tauri/src/ax_cloud.rs
git commit -m "feat(ax-cloud): native drag source over the cloud window

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: 接进 AX 引导流程的生命周期

云朵跟深链**同时**出现(不等超时——用户在第一秒就需要它)。三条隐藏路径:授权成功、用户点关闭、90 秒轮询停掉之后才授权(靠主窗重获焦点时的重查兜底)。

**Files:**
- Modify: `src/views/main.js`(`startAccessibilityFlow` 在 340 行附近;`stopAxPolling` 在 398 行附近;`refreshReadiness` 在 262 行附近)

**Interfaces:**
- Consumes: `show-ax-cloud` / `hide-ax-cloud`(Task 3)

- [ ] **Step 1: 流程开始时显示云朵**

`src/views/main.js` 的 `startAccessibilityFlow`,把 `beginAxPolling();` 那行前面加上显示调用:

```javascript
  // 跟深链同时出现,不等超时:卡住的用户在第一秒就需要这个入口。
  // dev 裸二进制没有 .app bundle,后端会拒绝显示并返回 false。
  ipc.invoke("show-ax-cloud").catch((error) => {
    console.error("Failed to show the drag cloud:", error);
  });

  beginAxPolling();
```

- [ ] **Step 2: 授权成功时隐藏云朵**

`refreshReadiness` 里既有的 `if (axOk) { stopAxPolling(); axGuideTimedOut = false; }` 块,补一行隐藏。**这一条同时覆盖了"90 秒轮询停掉之后用户才授权"**——那时靠主窗重获焦点触发的重查走到这里:

```javascript
  if (axOk) {
    stopAxPolling();
    axGuideTimedOut = false;
    // 也覆盖 90s 轮询停掉后才授权的情况:那时靠窗口重获焦点的重查走到这里,
    // 否则云朵会一直挂在屏幕上(轮询超时故意不关它)。
    ipc.invoke("hide-ax-cloud").catch(() => {});
  }
```

- [ ] **Step 3: 确认轮询超时**不**关云朵**

检查 `beginAxPolling` 里超时分支(约 389 行 `stopAxPolling()` 处),确认它**没有**调用 `hide-ax-cloud`。这是设计决定:用户可能只是在慢慢读、慢慢找,轮询停掉省资源但拖拽入口继续在。若发现有,删掉。

- [ ] **Step 4: 静态验证前端接线**

```bash
python3 -m http.server 4321 --directory src/views
```

打开 `http://localhost:4321/main.html`。**注意 Browser 工具的 `javascript_tool` 跑在隔离世界里,直接赋值 `window.__SAYTYPE_IPC__` 对页面无效**——必须注入 inline `<script>` 元素让补丁跑在主世界(CSP 允许 `'unsafe-inline'`)。注入这段:

```javascript
(() => {
  const el = document.createElement("script");
  el.textContent = `
    (() => {
      const bridge = window.__SAYTYPE_IPC__;
      window.__CALLS = [];
      const realInvoke = bridge.invoke;
      bridge.invoke = async (ch, ...args) => {
        window.__CALLS.push(ch);
        document.documentElement.setAttribute("data-calls", JSON.stringify(window.__CALLS));
        if (ch === "request-accessibility-permission") return { granted: false };
        if (ch === "show-permission-dialog") return null;
        if (ch === "show-ax-cloud") return true;
        return {};
      };
      void startAccessibilityFlow();
    })();
  `;
  document.documentElement.appendChild(el);
  return new Promise(r => setTimeout(
    () => r(document.documentElement.getAttribute("data-calls")), 800));
})()
```

Expected 返回值按序包含:`["request-accessibility-permission","show-permission-dialog","show-ax-cloud"]`

验完 `pkill -f "http.server 4321"`。

- [ ] **Step 5: 全量测试**

Run: `node --test src/views/*.test.mjs scripts/*.test.mjs`
Expected: 44 个测试全绿

- [ ] **Step 6: 提交**

```bash
git add src/views/main.js
git commit -m "feat(ax-cloud): drive the cloud from the Accessibility flow

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 真机验收 + 文案定稿

objc 拖拽**只能在真机验**——沙盒里发合成事件无效(既有教训)。此任务不写新代码(除非验出问题),产出是一次完整走查和 `axCloud.hint` 的最终措辞。

**Files:**
- Modify(视结果): `src/views/i18n.js`

- [ ] **Step 1: 装真机构建**

Run: `npm run build:mac:install`

- [ ] **Step 2: 重置授权,回到新用户状态**

```bash
tccutil reset Accessibility com.tao.saytype
```

然后重开 SayType。

- [ ] **Step 3: 走一遍完整流程并逐项核对**

点主窗 readiness 卡的辅助功能引导按钮,核对:

- [ ] 云朵出现,且**没有挡住**「系统设置」窗口
- [ ] 从云朵上按住拖动 → 出现跟手的 app 图标
- [ ] 拖进辅助功能列表 → SayType 条目出现
- [ ] **关键观察**:那个开关**是否自动变成开**(决定 Step 5 的文案)
- [ ] 右上角关闭按钮可点(验证 `hitTest:` 挖洞生效)
- [ ] 云朵其他任何位置按住都能发起拖拽
- [ ] 授权成功后云朵**自动消失**
- [ ] 等满 90 秒后云朵**仍在**且仍可拖(轮询停了,入口还在)
- [ ] 90 秒后才授权 → 切回主窗 → 云朵消失(Step 2 那条兜底生效)

- [ ] **Step 4: 验 dev 构建不显示云朵**

Run: `npm run dev`,走同样的流程。
Expected: 云朵**不出现**,日志里有 `ax-cloud: no .app bundle`。

- [ ] **Step 5: 按实测结果定稿文案**

若 Step 3 观察到开关自动打开,`axCloud.hint` 保持 "Drag me into the list" / "把我拖进列表"。
若没有自动打开,改成:

```javascript
        hint: "Drag me in, then switch it on",
```
```javascript
        hint: "把我拖进去,然后打开开关",
```

- [ ] **Step 6: 提交实测结论**

把 Step 3 的观察结果(尤其是开关是否自动打开)补进
`docs/superpowers/specs/2026-07-17-ax-drag-cloud-design.md` 的「待实测」一节,
改成实测结论。

```bash
git add src/views/i18n.js docs/superpowers/specs/2026-07-17-ax-drag-cloud-design.md
git commit -m "docs(ax-cloud): record the real-hardware verification results

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
