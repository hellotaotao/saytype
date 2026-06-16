# SayType

**English** · [中文说明 ↓](#中文)

A voice input method built with **Tauri** that lets you dictate text in any application using a global hotkey and AI transcription.

> This branch is the Tauri build. The legacy Electron build lives on the `main` branch.

## Features

- **Hold-to-Record Hotkey**: Hold down Ctrl+Shift to start recording, release to stop and transcribe
- **Real-time Audio Visualization**: Waveform animation while recording
- **AI Transcription**: Uses Groq's or OpenAI's Whisper API for speech-to-text
- **Auto-typing**: Inserts transcribed text into the active application (macOS)
- **Background Operation**: Runs silently in the system tray
- **Customizable Settings**: Configure API key/provider, microphone, and language

## Requirements

- Node.js 16 or higher
- A Rust toolchain (`rustup`) — required to build the Tauri app
- A valid Groq or OpenAI API key
- Microphone access permission (and Accessibility permission on macOS)

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
2. Configure your Groq/OpenAI API key in Settings
3. Hold down Ctrl+Shift to start recording
4. Speak while holding the keys
5. Release to stop recording and transcribe
6. Text is inserted into the active application (macOS)
7. Press Escape to cancel recording or an in-progress transcription

## Configuration

Access settings through the tray menu or main window to configure:
- API key and provider (Groq / OpenAI) for transcription
- Default microphone
- Transcription language and custom dictionary

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

> 此分支为 Tauri 版本。旧的 Electron 版本在 `main` 分支。

## 功能特性

- **按住录音快捷键**:按住 Ctrl+Shift 开始录音,松开即停止并转写
- **实时音频可视化**:录音时显示波形动画
- **AI 转写**:使用 Groq 或 OpenAI 的 Whisper API 进行语音转文字
- **自动输入**:将转写结果插入到当前活动应用(macOS)
- **后台运行**:静默驻留在系统托盘
- **可自定义设置**:配置 API key / 服务商、麦克风和语言

## 环境要求

- Node.js 16 或更高版本
- Rust 工具链(`rustup`)—— 构建 Tauri 应用所需
- 有效的 Groq 或 OpenAI API key
- 麦克风访问权限(macOS 上还需辅助功能权限)

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
2. 在「设置」中配置你的 Groq/OpenAI API key
3. 按住 Ctrl+Shift 开始录音
4. 按住按键的同时说话
5. 松开按键停止录音并转写
6. 文字会插入到当前活动应用(macOS)
7. 按 Escape 取消录音或正在进行的转写

## 配置

通过托盘菜单或主窗口进入「设置」,可配置:

- 用于转写的 API key 和服务商(Groq / OpenAI)
- 默认麦克风
- 转写语言和自定义词典

## 重复测试时重置 macOS 权限

```
tccutil reset Accessibility com.tao.saytype
tccutil reset Microphone com.tao.saytype
```

## 许可证

PolyForm Noncommercial 1.0.0
https://polyformproject.org/licenses/noncommercial/1.0.0/
