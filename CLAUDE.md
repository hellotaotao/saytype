# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Branch note:** This branch is the **Tauri** implementation and is **Tauri-only** — there is no Electron code here. The legacy Electron version lives on the `main` branch and is kept as the shipping/production app until Tauri is proven stable. Do not reintroduce Electron dependencies on this branch.

## Development Commands

```bash
npm install            # Install JS tooling (only @tauri-apps/cli)
npm run dev            # Run the app in dev mode (tauri dev)
npm start              # Alias for tauri dev

npm run build          # Bump build patch + tauri build (current host target)
npm run build:mac      # Build for macOS (aarch64-apple-darwin) → archives dmg to dist/
npm run build:mac:install  # Same as build:mac, then install the app into /Applications
npm run build:win      # Build for Windows (x86_64-pc-windows-msvc)
npm run build:linux    # Build for Linux (x86_64-unknown-linux-gnu)
```

Building requires a **Rust toolchain** (`rustup`) in addition to Node + `@tauri-apps/cli`.
`npm run version:tauri:patch` (run automatically by the build scripts) bumps the patch
version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` via
`scripts/bump-tauri-version.js`.

The mac build scripts set `CI=true` (so tauri skips the Finder-prettifying AppleScript that
fails in non-interactive shells) and run `scripts/collect-artifacts.js`, which **always copies
the built `.dmg` into `dist/`** — `dist/` is the kept archive of every version's installer, so
this step must not be skipped. `build:mac:install` additionally mounts that dmg and copies
`SayType.app` into `/Applications` over the old version, then relaunches it.

## Architecture Overview

SayType is a Tauri 2 voice-input app: a **Rust backend** (`src-tauri/src/`) hosting a
**web frontend** (`src/views/`). It runs in the system tray with a global hold-to-record
hotkey, transcribes speech via a cloud Whisper API, and inserts the text into the focused app.

### Rust backend (`src-tauri/src/`)

- `main.rs` — thin entry, calls `whispline_lib::run()`.
- `lib.rs` — builds the Tauri app: manages `AppState`; on `setup` runs migration, creates the
  tray, reads config, checks Accessibility, and starts the hotkey listener; on window close
  hides `main`/`settings` instead of quitting; on page load **injects the per-window entry
  script** (`main.js` / `settings.js` / `input-prompt.js`) into the webview; registers all
  `#[tauri::command]` handlers.
- `commands.rs` — all Tauri commands: settings get/save, window control, microphone cleanup,
  `transcribe_audio` (reqwest multipart → Groq/OpenAI, model/translate handling),
  `cancel_transcription`, `type_text` (macOS CGEvent Unicode insert → clipboard + osascript
  Cmd+V fallback), permission checks (microphone via AVFoundation, Accessibility via
  `AXIsProcessTrustedWithOptions`), history, and dictionary.
- `hotkey.rs` — global hold-to-record. On macOS uses a CGEventTap (only when Accessibility is
  trusted); elsewhere falls back to `rdev::listen`. Parses the modifier-only shortcut
  (default `Ctrl+Shift`) and emits start/stop/cancel recording events.
- `settings.rs` — JSON config read/write in the app data dir, shortcut normalization,
  auto-launch, API-key selection.
- `migration.rs` — one-time import of legacy WhispLine (Electron) `electron-store` config and
  history JSON into the new location; also the history read/write helpers used by commands.
- `tray.rs`, `state.rs` — system tray and shared app state (Accessibility status, hotkey handle).

### Frontend (`src/views/`)

- HTML/CSS/JS for three windows: `main`, `settings`, `input-prompt` (declared in
  `src-tauri/tauri.conf.json`, served from `frontendDist: ../src/views`, no bundler).
- `ipc-bridge.js` — the IPC abstraction. Exposes `window.__WHISPLINE_IPC__` with
  `invoke(channel, ...args)` and `on(channel, handler)`, mapping renderer channel names
  (e.g. `transcribe-audio`) to Tauri commands (`transcribe_audio`) and Tauri event listeners.
- `i18n.js` — UI strings (add new copy here).

### IPC contract

Renderer → Rust: `bridge.invoke("type-text", text)` → Tauri `invoke("type_text", { text })`.
Rust → Renderer: `app.emit("shortcut-updated", …)` / `"ui-theme-updated"` /
`"accessibility-permission-changed"`, received via `bridge.on(...)`.

**When adding a new IPC command, update three places:** the `#[tauri::command]` in
`commands.rs`, its registration in the `invoke_handler!` list in `lib.rs`, and the
`tauriCommands` (and `tauriArgs` if it takes arguments) maps in `ipc-bridge.js`.

## Platform-Specific Considerations

- **macOS**: requires Microphone and Accessibility permissions; entitlements at
  `build/entitlements.mac.plist` (referenced by `tauri.conf.json`). Text insertion and the
  global hotkey are implemented for macOS; **Windows/Linux insertion is not yet implemented**
  in the Rust backend.
- Reset macOS permissions when re-testing:
  ```
  tccutil reset Accessibility com.tao.saytype
  tccutil reset Microphone com.tao.saytype
  ```

## Development Notes

- Global shortcut is hold `Ctrl+Shift` to record (hardcoded default); Shift+Alt triggers
  translate mode. Text insertion falls back to clipboard + auto-paste when direct insert fails.
- There is no JS runtime dependency: the frontend is plain static HTML/CSS/JS. All business
  logic (transcription, settings, history, hotkey, insertion) lives in Rust.
- Rust unit tests exist (e.g. `migration.rs`, `settings.rs`); run with `cargo test` in `src-tauri/`.
