# SayType

**English** · [中文说明 ↓](#中文)

A voice input method built with **Tauri** that lets you dictate text in any application using a global hotkey and AI transcription.

Project direction: [Product pathway](docs/PRODUCT_PATHWAY.md) · [Reliability acceptance](docs/RELIABILITY_ACCEPTANCE.md).

## Features

- **Hold-to-Record Hotkey**: Hold down Ctrl+Shift to start recording, release to stop and transcribe
- **Real-time Audio Visualization**: Waveform animation while recording
- **Local-first AI Transcription**: Qwen3-ASR runs on-device for batch quality (0.6B by default, 1.7B as an experimental option); Nemotron 3.5 adds live local transcription on Apple Silicon and Windows x64. Groq and OpenAI remain optional cloud choices
- **Translation**: Hold Shift+Alt to dictate and get English text from a cloud provider: your cloud engine, or, while you use a local engine, the provider you pick for translation (needs its API key and your consent)
- **Auto-typing**: Inserts transcribed text into the active application (macOS; Windows/Linux experimental, untested)
- **Background Operation**: Runs silently in the system tray
- **Automatic Updates**: New releases download in the background; restart from the tray or Settings when you're ready
- **Customizable Settings**: Configure the engine, API keys, translation, and language

## Requirements

- No account or API key is needed for local transcription. A Groq or OpenAI API key is required only for a cloud provider or translation
- Microphone access permission (and Accessibility permission on macOS)
- To build from source: Node.js 22 or newer and a Rust toolchain (`rustup`)

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

# Run tests
npm test                                          # frontend and scripts
cargo test --manifest-path src-tauri/Cargo.toml   # Rust

# Build for production
npm run build      # current host target
npm run build:mac  # macOS (aarch64)
npm run build:win  # Windows
npm run build:linux
```

Then open Settings and pick a transcription engine: download a local model (no key needed) or enter a Groq/OpenAI API key.

Releases are built, signed, and published automatically when a `v*` tag is pushed; see [RELEASING.md](RELEASING.md).

## Usage

1. Launch SayType
2. Pick a transcription engine in Settings: download the local model, or enter a Groq/OpenAI API key
3. Hold down Ctrl+Shift to start recording
4. Speak while holding the keys
5. Release to stop recording and transcribe
6. Text is inserted into the active application (macOS; Windows/Linux experimental, untested)
7. Press Escape to cancel recording or an in-progress transcription

To translate into English, hold Shift+Alt instead. With a local engine, choose a translation provider in Settings first.

## Configuration

Access settings through the tray menu or main window to configure:
- Transcription engine: Qwen3-ASR (0.6B, or experimental 1.7B) or Nemotron 3.5 local model (no key; Nemotron supports Apple Silicon and Windows x64), or optional Groq / OpenAI with an API key
- Translation provider (Groq or OpenAI), used while a local engine is selected; SayType asks for your consent before uploading that audio
- Transcription language (Nemotron and cloud providers); custom dictionary (cloud providers only)

SayType records from the system's default input device; change it in your OS sound settings.

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

项目方向:[产品路径](docs/PRODUCT_PATHWAY.md) · [可靠性验收](docs/RELIABILITY_ACCEPTANCE.md)。

## 功能特性

- **按住录音快捷键**:按住 Ctrl+Shift 开始录音,松开即停止并转写
- **实时音频可视化**:录音时显示波形动画
- **本地优先 AI 转写**:Qwen3-ASR 在本机提供高质量批量转写(默认 0.6B,1.7B 为实验选项);Nemotron 3.5 在 Apple Silicon 和 Windows x64 上提供本地实时转写。Groq 和 OpenAI 作为可选云端方案
- **翻译**:按住 Shift+Alt 口述,由云端服务得到英文:用云端引擎时就是当前服务;用本地引擎时是你为翻译选的服务(需要它的 API key 并经你同意)
- **自动输入**:将转写结果插入到当前活动应用(macOS;Windows/Linux 为实验性支持,未经真机验证)
- **后台运行**:静默驻留在系统托盘
- **自动更新**:新版本后台自动下载,你随时从托盘或设置里重启完成升级
- **可自定义设置**:配置转写引擎、API key、翻译和语言

## 环境要求

- 本地转写无需账号或 API key;只有选择 Groq 或 OpenAI 云端服务、或使用翻译时才需要 API key
- 麦克风访问权限(macOS 上还需辅助功能权限)
- 从源码构建:Node.js 22 或更高版本,以及 Rust 工具链(`rustup`)

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

# 运行测试
npm test                                          # 前端与脚本
cargo test --manifest-path src-tauri/Cargo.toml   # Rust

# 构建生产版本
npm run build      # 当前主机架构
npm run build:mac  # macOS(aarch64)
npm run build:win  # Windows
npm run build:linux
```

然后打开「设置」选择转写引擎:下载本地模型(不需要 key),或填入 Groq/OpenAI API key。

推送 `v*` tag 时会自动构建、签名并发布,见 [RELEASING.md](RELEASING.md)。

## 使用方法

1. 启动 SayType
2. 在「设置」中选择转写引擎:下载本地模型,或填入 Groq/OpenAI API key
3. 按住 Ctrl+Shift 开始录音
4. 按住按键的同时说话
5. 松开按键停止录音并转写
6. 文字会插入到当前活动应用(macOS;Windows/Linux 为实验性支持,未经真机验证)
7. 按 Escape 取消录音或正在进行的转写

要翻译成英文,改为按住 Shift+Alt。用本地引擎时,先在「设置」里选好翻译服务。

## 配置

通过托盘菜单或主窗口进入「设置」,可配置:

- 转写引擎:Qwen3-ASR(0.6B,或实验性的 1.7B)或 Nemotron 3.5 本地模型(无需 key;Nemotron 支持 Apple Silicon 和 Windows x64),或可选的云端服务(Groq / OpenAI)+ API key
- 翻译服务(Groq 或 OpenAI),用本地引擎时生效;上传这段录音前 SayType 会先征得你的同意
- 转写语言(Nemotron 和云端服务商);自定义词典(仅云端服务商)

SayType 使用系统默认的输入设备录音;要换麦克风,请在系统的声音设置里修改。

## 重复测试时重置 macOS 权限

```
tccutil reset Accessibility com.tao.saytype
tccutil reset Microphone com.tao.saytype
```

## 许可证

PolyForm Noncommercial 1.0.0
https://polyformproject.org/licenses/noncommercial/1.0.0/
