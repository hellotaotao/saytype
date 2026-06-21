# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Note:** SayType is a **Tauri 2 + Rust** desktop app (migrated from Electron, which has been fully removed). Don't reintroduce Electron dependencies.

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

For **local code signing**, the mac build scripts source an untracked `scripts/sign.env`
(copy from `scripts/sign.env.example`) if present, exporting `APPLE_SIGNING_IDENTITY`. Signing
with a stable identity makes macOS keep the Accessibility/Microphone grants across rebuilds —
ad-hoc signing (the default when the file is absent) changes the cdhash each build and re-prompts.
Notarized release builds additionally set `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` and require a
*Developer ID Application* cert; local builds skip notarization.

## Architecture Overview

SayType is a Tauri 2 voice-input app: a **Rust backend** (`src-tauri/src/`) hosting a
**web frontend** (`src/views/`). It runs in the system tray with a global hold-to-record
hotkey, transcribes speech via a cloud Whisper API, and inserts the text into the focused app.

### Rust backend (`src-tauri/src/`)

- `main.rs` — thin entry, calls `saytype_lib::run()`.
- `lib.rs` — builds the Tauri app: manages `AppState`; on `setup` creates the
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
- `history.rs` — transcription-history store: read/append/write the recent-activities list
  (JSON `{ "activities": [...] }`) used by the history commands.
- `tray.rs`, `state.rs` — system tray and shared app state (Accessibility status, hotkey handle).

### Frontend (`src/views/`)

- HTML/CSS/JS for three windows: `main`, `settings`, `input-prompt` (declared in
  `src-tauri/tauri.conf.json`, served from `frontendDist: ../src/views`, no bundler).
- `ipc-bridge.js` — the IPC abstraction. Exposes `window.__SAYTYPE_IPC__` with
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

### Audio capture: echo cancellation off, and the missing NS/AGC (macOS WebKit)

Mic capture runs in the webview via `getUserMedia` (`AUDIO_CONSTRAINTS` in
`input-prompt.js`). **All processing constraints are pinned `false`**
(`echoCancellation`/`noiseSuppression`/`autoGainControl`) — this is a deliberate fix for
dropped first words on external/USB mics, not a style choice:

- On macOS, Tauri's webview is **WKWebView (WebKit)**. WebKit maps `echoCancellation: true`
  onto macOS's **VoiceProcessingIO** audio unit, which cold-starts in **~1–2s on a USB/
  external mic** (a Mac mini has no built-in mic) and emits silence during that window — so
  `MediaRecorder` captures dead air and the first second(s) of speech are lost. Laptops' built-in
  mics hide it because that voice path is pre-warmed.
- WebKit only **supports `echoCancellation`**: `getSupportedConstraints()` reports
  `noiseSuppression`/`autoGainControl` as `false` and `getSettings()` reports them `undefined`
  — they never applied even when requested. So NS/AGC were never active on macOS; only EC was,
  and EC is useless for dictation (Whisper handles raw audio). Disabling EC drops getUserMedia +
  first-audio from ~1100ms to ~180ms with no quality change. (Verified with a per-recording
  constraint sweep that logged the mode + `getSettings()`.)

The ~1s is **WebKit-specific** — same Mac mini + USB mic, measured per engine:

| Engine | Used by | EC cost | NS / AGC |
|---|---|---|---|
| WebKit (macOS) | this app's WKWebView, Safari | **~1–2s** (VoiceProcessingIO) | unsupported (`undef`) |
| Chromium | Tauri **Windows** WebView2, Chrome, Electron | **~65ms** (software AEC3) | supported, ~0ms, not additive |

So the limitation is **macOS-only**:

- **Windows** — Tauri uses **WebView2 (Chromium)** → EC/NS/AGC all supported and cheap, same as
  Chrome/Electron; no 1s penalty.
- **Linux** — Tauri uses **WebKitGTK** (WebKit family). The 1s is a macOS VoiceProcessingIO
  artifact and does not apply, but WebKitGTK's getUserMedia processing support is limited/variable
  — verify if ever targeted.
- (Text insertion + hotkey are macOS-only today, so Windows/Linux aren't live targets yet.)

### Decision: do NOT add NS/AGC, and do NOT pre-denoise (researched 2026-06-22)

This was previously framed as "NS/AGC are marginal, add if needed." **Research overturns that:
pre-processing audio with noise suppression or AGC before a cloud transcription model is
neutral-to-harmful — so don't.**

- Modern end-to-end ASR have *learned* noise/level robustness (not a bolt-on denoiser): Whisper was
  trained on 680k hr of noisy audio; gpt-4o-mini-transcribe is OpenAI-positioned as "optimized for
  noisy backgrounds." Whisper also normalizes its input level, so external **AGC is largely redundant**.
- Pre-denoising tends to **hurt**: the systematic study *When De-noising Hurts*
  ([arXiv 2512.17562](https://arxiv.org/abs/2512.17562)) found speech enhancement degraded ASR in
  **all 40 configs** (4 models × 10 noise conditions), +1.1–46.6% absolute semWER, with a penalty even
  on clean audio; Whisper was the most sensitive (*When Denoising Hinders*,
  [arXiv 2603.04710](https://arxiv.org/html/2603.04710v1)). Cause: denoiser artifacts + mismatch with
  the noisy distribution the model trained on + removal of cues the ASR actually uses.
- **Corollary:** WebKit's inability to do NS/AGC in `getUserMedia` is **not a real deficiency** for
  this app, and is **not** a reason to reconsider Electron or native Rust capture. EC is separately
  useless for dictation (no echo source). Only extreme far-field / very-low-level capture could matter
  — and post-hoc AGC can't rescue a near-noise-floor recording anyway.

If a real, *measured* quality problem ever shows up in noisy/far conditions (test first: feed the
**same** clip raw vs processed through the actual model and compare), the lowest-cost lever would be
RNNoise NS in a frontend AudioWorklet (`@jitsi/rnnoise-wasm`, or Rust `nnnoiseless`); the full Chrome
stack (`webrtc-audio-processing`, C++ build) and native-Rust VoiceProcessingIO capture are heavier and
only worth it if that fails. Default, evidence-backed stance: **don't**.

### Recording format & bitrate (measured 2026-06-22)

WKWebView records **AAC-LC, 48 kHz, stereo, ~155 kbps** (a ~10 s clip ≈ 200 KB). **WebKit's
MediaRecorder ignores `audioBitsPerSecond`** — requesting 32 kbps still produced ~155 kbps, so upload
size can't be cheaply lowered from the recorder. Real reduction would need re-encoding (WebCodecs, or
a backend encoder) — extra CPU/complexity, not worth it for short dictation clips. Sample rate is moot
too: Whisper resamples to 16 kHz server-side regardless. (Windows WebView2 = Chromium *does* honor
`audioBitsPerSecond`, so this is WebKit-specific, like the NS/AGC gap above.)

## Development Notes

- Global shortcut is hold `Ctrl+Shift` to record (hardcoded default); Shift+Alt triggers
  translate mode. Text insertion falls back to clipboard + auto-paste when direct insert fails.
- There is no JS runtime dependency: the frontend is plain static HTML/CSS/JS. All business
  logic (transcription, settings, history, hotkey, insertion) lives in Rust.
- Rust unit tests exist (e.g. `history.rs`, `settings.rs`); run with `cargo test` in `src-tauri/`.
