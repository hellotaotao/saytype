# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Development
npm start              # Run in production mode
npm run dev           # Run in development mode with --dev flag
npm install           # Install dependencies

# Building
npm run build         # Build for all platforms
npm run build:mac     # Build for macOS
npm run build:win     # Build for Windows  
npm run build:linux   # Build for Linux
```

## Architecture Overview

SayType (formerly SayType) is an Electron-based voice input application that transcribes speech to text using AI. The app runs in the system tray and provides global hotkey support.

### Core Components

- **Main Process** (`src/main.js`): Electron main process handling windows, system tray, global hotkeys, and IPC
- **Permission Manager** (`src/permission-manager.js`): Client-side permission handling for microphone access
- **UI Views** (`src/views/`): HTML interfaces for main window, settings, and input prompt overlay

### Key Architecture Patterns

1. **Multi-Window Architecture**: 
   - Main window (hidden by default, shows on tray click)
   - Settings window (modal dialog)
   - Input prompt window (overlay for recording visualization)

2. **Global Hotkey System**: Uses `uiohook-napi` for cross-platform global keyboard shortcuts (Ctrl+Shift hold-to-record)

3. **Permission Flow**: Comprehensive permission checking for microphone and accessibility (macOS) with fallback to clipboard-based text insertion

4. **IPC Communication**: Extensive use of `ipcMain.handle()` and `ipcRenderer.invoke()` for main/renderer communication

### Critical Dependencies

- **uiohook-napi**: Global keyboard event capture (requires accessibility permissions on macOS)
- **groq-sdk**: AI transcription via Groq's Whisper API  
- **electron-store**: Persistent settings storage

### Platform-Specific Considerations

- **macOS**: Requires microphone and accessibility permissions, has special entitlements file
- **Windows/Linux**: Uses NSIS/AppImage packaging respectively
- Permission dialogs and system settings integration vary by platform

### File Structure

- `src/main.js`: Main Electron process with window management and global hotkey setup
- `src/permission-manager.js`: Browser-side permission utilities and device enumeration  
- `src/views/`: HTML/CSS/JS for each window interface
- `build/`: Platform-specific build configuration (entitlements, etc.)

### Development Notes

- App uses `electron-store` for settings persistence
- Global shortcuts are hardcoded to Ctrl+Shift (not user-configurable)
- Text insertion falls back to clipboard copy on permission failures
- Temporary audio files created in system temp directory during transcription