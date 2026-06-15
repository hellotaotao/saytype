# SayType

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
