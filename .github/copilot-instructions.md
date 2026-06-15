# SayType – AI Coding Instructions

Concise guidance for AI agents working on this branch.

## Big picture
- **Tauri 2** tray app for hold-to-record voice dictation. **Rust backend** (`src-tauri/src/`) + **web frontend** (`src/views/`). This branch is **Tauri-only**; the legacy Electron app is on `main`.
- Global hotkey: hold `Ctrl+Shift` to record; `Shift+Alt` for English output (translate mode).
- Data flow: hotkey (Rust `hotkey.rs`, CGEventTap on macOS) → emits event → renderer shows `input-prompt.html` → `getUserMedia` + `MediaRecorder` → Blob → `bridge.invoke("transcribe-audio", buffer, translateMode, mimeType)` → Rust `commands::transcribe_audio` (reqwest multipart → Groq/OpenAI) → text → `bridge.invoke("type-text", text)` → Rust `commands::type_text` (CGEvent insert → clipboard fallback) → history appended in `migration.rs`.

## Key files
- `src-tauri/src/lib.rs`: Tauri builder, setup (migration, tray, hotkey, config), window-close-hides, per-window entry-script injection, `invoke_handler!` registration.
- `src-tauri/src/commands.rs`: every `#[tauri::command]` — settings, permissions (mic/Accessibility), `transcribe_audio`, `cancel_transcription`, `type_text`, history, dictionary.
- `src-tauri/src/hotkey.rs`: global hold-to-record; macOS CGEventTap, else `rdev`.
- `src-tauri/src/settings.rs` / `migration.rs`: JSON config + legacy-data migration + history helpers.
- `src/views/ipc-bridge.js`: `window.__WHISPLINE_IPC__` with `invoke`/`on`; maps channel names → Tauri commands/events.
- `src/views/input-prompt.html` / `.js`: recording UI + audio capture (prefers `audio/mp4`, else `audio/webm;codecs=opus`).

## Conventions and behavior
- Settings persist as JSON via `settings.rs`: `provider` (default `groq`), `model`, `language`, `dictionary`, `apiKeyGroq`, `apiKeyOpenAI`.
- Translate mode forces model: OpenAI → `whisper-1`; Groq → `whisper-large-v3`. Otherwise use stored `model`.
- Audio is not transcoded; the renderer passes the actual recording MIME with the buffer; Rust picks the file extension from it.
- IPC channel names are the contract between renderer and Rust — do not rename casually.

## Developer workflows
- Install/run: `npm install` (only `@tauri-apps/cli`); dev: `npm run dev` (= `tauri dev`). Building needs a Rust toolchain.
- Build: `npm run build` (or `build:mac` / `build:win` / `build:linux`).
- Rust tests: `cd src-tauri && cargo test`.
- macOS permission reset for re-testing:
  - `tccutil reset Accessibility com.tao.saytype`
  - `tccutil reset Microphone com.tao.saytype`

## When adding features
- New IPC command → update **three** places: `#[tauri::command]` in `commands.rs`, registration in `lib.rs`, and the `tauriCommands`/`tauriArgs` maps in `ipc-bridge.js`.
- Keep new UI strings in `src/views/i18n.js`.
- Text insertion and the global hotkey are macOS-only today; Windows/Linux insertion is not yet implemented in Rust.
