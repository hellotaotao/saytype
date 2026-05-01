# SayType

A voice input method software built with Electron that allows you to dictate text in any application using hotkeys and AI transcription.

## Features

- **Hold-to-Record Hotkey**: Hold down Ctrl+Shift to start recording, release to stop and transcribe
- **Real-time Audio Visualization**: Beautiful waveform animation while recording
- **AI Transcription**: Uses Groq's Whisper API for accurate speech-to-text
- **Auto-typing**: Automatically types transcribed text into active application (macOS)
- **Cross-platform**: Works on macOS, Windows, and Linux
- **Background Operation**: Runs silently in the system tray
- **Customizable Settings**: Configure API key, microphone, and languages

## Installation

1. Clone this repository
2. Install dependencies: `npm install`
3. Configure your Groq API key in settings
4. Start the application: `npm start`

## Usage

1. Launch SayType
2. Configure your Groq API key in Settings
3. Hold down Ctrl+Shift to start recording
4. Speak into your microphone while holding the keys
5. Release the keys to stop recording and transcribe
6. Text will be automatically typed into the active application
7. Press Escape to cancel recording or in-progress transcription

## Configuration

Access settings through the system tray menu or main window to configure:
- API Key for transcription service
- Global hotkey combinations
- Default microphone
- Transcription language

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build
```

## Console Character Encoding (Windows)

On Windows, the console may display non-English characters as garbled text due to PowerShell/CMD output encoding settings.

**Solution**:
Set UTF-8 encoding in your terminal before running the application:
```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
npm run dev
```

**Note**:
- This only affects development console output, not application functionality
- Transcribed text displays correctly in the application UI and when inserted into other software
- This is a Windows terminal limitation, not an application code issue

## Reset macOS permissions for repeated testing
```
tccutil reset Accessibility com.tao.saytype
tccutil reset Microphone com.tao.saytype
```

## Requirements

- Node.js 16 or higher
- Valid Groq API key
- Microphone access permission

## License

PolyForm Noncommercial 1.0.0
https://polyformproject.org/licenses/noncommercial/1.0.0/
