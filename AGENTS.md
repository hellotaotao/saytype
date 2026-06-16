# Repository Guidelines

## Project Structure & Module Organization
SayType is a **Tauri 2** app. This branch is **Tauri-only** (the legacy Electron build is on `main`). The Rust backend lives in `src-tauri/src/` (`lib.rs`, `commands.rs`, `hotkey.rs`, `settings.rs`, `migration.rs`, `tray.rs`, `state.rs`). The web frontend (HTML/CSS/JS for the `main`, `settings`, and `input-prompt` windows) lives in `src/views/`, served directly with no bundler. App config is in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`; macOS entitlements are in `build/`; icons in `src-tauri/icons/` and `assets/`.

## Build, Test, and Development Commands
- `npm install` installs JS tooling (only `@tauri-apps/cli`). Building also needs a Rust toolchain (`rustup`).
- `npm run dev` (or `npm start`) launches `tauri dev`.
- `npm run build` builds for the host; use `npm run build:mac`, `npm run build:win`, or `npm run build:linux` for targeted builds.
- `cd src-tauri && cargo test` runs the Rust unit tests; `cargo check` verifies compilation.

## Coding Style & Naming Conventions
There is no enforced lint/format config. In Rust, match the existing 2-space-indent style and run `cargo fmt` if available. In the frontend, match existing patterns: 2-space indentation, semicolons, descriptive action-oriented names. Keep UI strings in `src/views/i18n.js`. Renderer↔backend communication goes through `src/views/ipc-bridge.js` (`window.__SAYTYPE_IPC__`) — do not call Tauri APIs directly from window scripts.

## Testing Guidelines
Rust logic should have `cargo test` coverage (see `migration.rs`, `settings.rs`). For UI/behavior changes do a manual pass: `npm run dev`, then verify tray/menu actions, the recording flow, permission prompts, and text insertion. Note platform-specific behavior in the PR (insertion and the global hotkey are macOS-only today).

## Commit & Pull Request Guidelines
History uses short, imperative messages, often with conventional prefixes (`feat:`, `fix(tauri):`, `refactor(ui):`). Follow that pattern. PRs should include a concise summary, testing notes, and screenshots/clips for UI changes. Call out permission-related updates (macOS Accessibility/Microphone) explicitly.

## Security & Configuration Tips
API keys are entered in-app and stored in the app's JSON config via `settings.rs`; never commit secrets. When adding an IPC command, wire it in `commands.rs`, register it in `lib.rs`, and add it to the `ipc-bridge.js` maps. If you change permissions or entitlements, update `build/entitlements.mac.plist` and document any new OS prompts in `README.md`.
