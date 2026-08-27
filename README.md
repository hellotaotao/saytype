# SayType

**English** · [中文说明 ↓](#中文)

A voice input method built with **Tauri** that lets you dictate text in any application using a global hotkey and AI transcription.

## Features

- **Hold-to-Record Hotkey**: Hold down Ctrl+Shift to start recording, release to stop and transcribe
- **Real-time Audio Visualization**: Waveform animation while recording
- **AI Transcription**: Cloud (Groq / OpenAI) or two **local** choices: Qwen3-ASR for batch quality and Nemotron 3.5 for live on-device transcription on Apple Silicon
- **Auto-typing**: Inserts transcribed text into the active application (macOS; Windows/Linux experimental, untested)
- **Background Operation**: Runs silently in the system tray
- **Automatic Updates**: New releases download in the background; restart from the tray when you're ready
- **Customizable Settings**: Configure API key/provider, microphone, and language

## Requirements

- Node.js 16 or higher
- A Rust toolchain (`rustup`) — required to build the Tauri app
- A Groq or OpenAI API key — **only for the cloud providers**; the local engine needs no key (recommended on Apple Silicon)
- Microphone access permission (and Accessibility permission on macOS)

## Download

Grab the latest installer from the [Releases page](https://github.com/hellotaotao/saytype/releases/latest):

- **macOS** — the `.dmg`
- **Windows** — the `_x64-setup.exe` (or `.msi`)
- **Linux** — the `.AppImage` (portable), `.deb` (Debian/Ubuntu), or `.rpm` (Fedora/RHEL)

Once installed, SayType keeps itself up to date. The other files on the Releases page (`*.sig`, `latest.json`, `*.app.tar.gz`) are used by the built-in auto-updater — you don't need to download them.

## Installation / Development

```bash
# Install JS tooling (only @tauri-apps/cli)
npm install

# Run in development mode
npm run dev        # = tauri dev

# Build for production
npm run build      # current host target
npm run build:mac  # macOS (aarch64)
npm run build:win  # Windows
npm run build:linux
```

Then open Settings to configure your API key.

To publish a signed macOS `.dmg` to GitHub Releases (built automatically on a
`v*` tag), see [RELEASING.md](RELEASING.md).

## Usage

1. Launch SayType
2. Pick a transcription engine in Settings: download the local model, or enter a Groq/OpenAI API key
3. Hold down Ctrl+Shift to start recording
4. Speak while holding the keys
5. Release to stop recording and transcribe
6. Text is inserted into the active application (macOS; Windows/Linux experimental, untested)
7. Press Escape to cancel recording or an in-progress transcription

## Configuration

Access settings through the tray menu or main window to configure:
- Transcription engine: Qwen3-ASR or Nemotron 3.5 local model (no key; Nemotron requires Apple Silicon), or Groq / OpenAI with API key
- Default microphone
- Transcription language and custom dictionary (cloud providers only; the local engine auto-detects)

## Reset macOS permissions for repeated testing

```
tccutil reset Accessibility com.tao.saytype
tccutil reset Microphone com.tao.saytype
```

## License

PolyForm Noncommercial 1.0.0
https://polyformproject.org/licenses/noncommercial/1.0.0/

---

<a id="中文"></a>

# SayType(中文)

[↑ English](#saytype)

一款基于 **Tauri** 构建的语音输入法,让你通过全局快捷键和 AI 转写,在任意应用中用口述输入文字。

## 功能特性

- **按住录音快捷键**:按住 Ctrl+Shift 开始录音,松开即停止并转写
- **实时音频可视化**:录音时显示波形动画
- **AI 转写**:云端(Groq / OpenAI)或两种**本地**选择:偏批量质量的 Qwen3-ASR,以及在 Apple Silicon 上边说边显示的 Nemotron 3.5
- **自动输入**:将转写结果插入到当前活动应用(macOS;Windows/Linux 为实验性支持,未经真机验证)
- **后台运行**:静默驻留在系统托盘
- **自动更新**:新版本后台自动下载,你随时从托盘重启完成升级
- **可自定义设置**:配置 API key / 服务商、麦克风和语言

## 环境要求

- Node.js 16 或更高版本
- Rust 工具链(`rustup`)—— 构建 Tauri 应用所需
- Groq 或 OpenAI API key——**仅云端服务商需要**;本地引擎无需 key(Apple Silicon 上推荐)
- 麦克风访问权限(macOS 上还需辅助功能权限)

## 下载

从 [Releases 页面](https://github.com/hellotaotao/saytype/releases/latest) 下载对应平台的安装包:

- **macOS** — `.dmg`
- **Windows** — `_x64-setup.exe`(或 `.msi`)
- **Linux** — `.AppImage`(免安装)、`.deb`(Debian/Ubuntu)或 `.rpm`(Fedora/RHEL)

安装后 SayType 会自动保持更新。Releases 页面上其余文件(`*.sig`、`latest.json`、`*.app.tar.gz`)是自动更新用的,无需下载。

## 安装 / 开发

```bash
# 安装 JS 工具链(仅 @tauri-apps/cli)
npm install

# 以开发模式运行
npm run dev        # = tauri dev

# 构建生产版本
npm run build      # 当前主机架构
npm run build:mac  # macOS(aarch64)
npm run build:win  # Windows
npm run build:linux
```

然后打开「设置」配置你的 API key。

要把签名后的 macOS `.dmg` 发布到 GitHub Releases(打 `v*` tag 时自动构建),见 [RELEASING.md](RELEASING.md)。

## 使用方法

1. 启动 SayType
2. 在「设置」中选择转写引擎:下载本地模型,或填入 Groq/OpenAI API key
3. 按住 Ctrl+Shift 开始录音
4. 按住按键的同时说话
5. 松开按键停止录音并转写
6. 文字会插入到当前活动应用(macOS;Windows/Linux 为实验性支持,未经真机验证)
7. 按 Escape 取消录音或正在进行的转写

## 配置

通过托盘菜单或主窗口进入「设置」,可配置:

- 转写引擎:Qwen3-ASR 或 Nemotron 3.5 本地模型(无需 key;Nemotron 需要 Apple Silicon),或云端服务商(Groq / OpenAI)+ API key
- 默认麦克风
- 转写语言和自定义词典(仅云端服务商;本地引擎为自动检测)

## 重复测试时重置 macOS 权限

```
tccutil reset Accessibility com.tao.saytype
tccutil reset Microphone com.tao.saytype
```

## 许可证

PolyForm Noncommercial 1.0.0
https://polyformproject.org/licenses/noncommercial/1.0.0/
