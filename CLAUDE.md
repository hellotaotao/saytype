# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Note:** SayType is a **Tauri 2 + Rust** desktop app (migrated from Electron, which has been fully removed). Don't reintroduce Electron dependencies.

## Development Commands

```bash
npm install            # Install JS tooling (only @tauri-apps/cli)
npm run dev            # Run the app in dev mode (tauri dev)
npm start              # Alias for tauri dev

npm run build          # tauri build (current host target)
npm run build:mac      # Build for macOS (aarch64-apple-darwin) → archives dmg to dist/
npm run build:mac:install  # Same as build:mac, then install the app into /Applications
npm run build:win      # Build for Windows (x86_64-pc-windows-msvc)
npm run build:linux    # Build for Linux (x86_64-unknown-linux-gnu)
```

Building requires a **Rust toolchain** (`rustup`) in addition to Node + `@tauri-apps/cli`.
`npm run version:tauri:patch` bumps the **patch** version (no arg), or pass an explicit
version for a minor/major — `node scripts/bump-tauri-version.js 1.2.0` — across all four:
`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`
(via `scripts/bump-tauri-version.js`). Run it **manually** when cutting a release — builds no
longer auto-bump (that made the version climb on every local build).

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

## Release signing & notarization (macOS)

Releases are built, signed, **and notarized** entirely in CI — see
[`.github/workflows/release.yml`](.github/workflows/release.yml). Pushing a `v*`
tag (e.g. `v1.0.108`) runs a **3-platform matrix** of `tauri-apps/tauri-action`:
macOS builds a universal DMG, signs it with Developer ID, submits it to Apple's
notary service and staples the ticket; Windows (NSIS/MSI) and Linux
(AppImage/deb/rpm) build unsigned installers (both platforms remain unverified
on real machines). Every leg also emits **minisign-signed auto-update artifacts**
plus a merged `latest.json` manifest (via `tauri.release.conf.json`'s
`createUpdaterArtifacts` — kept out of the main config so local builds never
need the updater key). Everything lands on a **draft** GitHub Release.
Notarization is intentionally CI-only: it uploads the build to Apple and waits
minutes, whereas local signing is instant (local builds skip it).

> **Signing is optional in CI.** The release workflow's "Configure Apple signing"
> step injects the `APPLE_*` secrets into the environment **only when
> `APPLE_CERTIFICATE` is set**. If the signing secrets are not yet configured, no
> `APPLE_*` vars are passed to tauri-cli, so it produces an **unsigned,
> un-notarized** DMG and the release still succeeds (a workflow warning is
> emitted). Adding the six secrets below later enables signing + notarization
> automatically — no workflow changes needed.

> **Release notes are AI-generated in CI** (also optional). After the build, the
> workflow runs `scripts/generate-release-notes.mjs` — commits from the previous
> `v*` tag to the current one → Claude API (`claude-sonnet-5`) → bilingual
> (EN + 中文) user-facing notes written into the draft release via `gh release
> edit`. Requires the `ANTHROPIC_API_KEY` secret; if it's absent or the call
> fails, the step warns and the release keeps the default body — never blocks.
> Debug locally with `node scripts/generate-release-notes.mjs <tag> --dry-run`
> (prints the prompt, no API call). Design:
> `docs/superpowers/specs/2026-07-12-ai-release-notes-design.md`.

Notarization = Apple scans the signed app and returns a ticket that gets
**stapled into the bundle**, so Gatekeeper lets *other* Macs run it without the
"unidentified developer" warning. Prereqs: Hardened Runtime (already on) **and a
Developer ID Application signature** — the local `Apple Development` cert is
rejected by the notary service.

### One-time setup (then every `v*` tag is automatic)

1. **Developer ID Application certificate** — a *different cert type* than the
   `Apple Development` one used locally, generated from the same paid account:
   Xcode → Settings → Accounts → (team) → Manage Certificates → `+` →
   *Developer ID Application* (or developer.apple.com → Certificates). Then
   Keychain Access → export it as a password-protected `.p12`.
2. **App-specific password** (for the notary login) — appleid.apple.com →
   Sign-In and Security → App-Specific Passwords. NOT your Apple ID password.
3. **Base64 the cert** for the secret: `base64 -i DeveloperID.p12 | pbcopy`.

### GitHub repo secrets (Settings → Secrets and variables → Actions)

These names are exactly what `release.yml` consumes:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Tao Wang (CU3VTR9MRH)` |
| `APPLE_ID` | your Apple ID (`hellotaotao@gmail.com`) |
| `APPLE_PASSWORD` | the app-specific password from step 2 |
| `APPLE_TEAM_ID` | `CU3VTR9MRH` |
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.tauri/saytype-updater.key` (updater minisign key; **back up — lost key = installed clients can never auto-update again**) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the updater key password (also in local `scripts/sign.env`) |

`tauri-action` imports the cert into a temporary keychain and signs; because the
`APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` trio is also present it then
notarizes and staples — no extra YAML steps. (Alternative to the Apple-ID trio:
an App Store Connect API key via `APPLE_API_ISSUER`/`APPLE_API_KEY`/
`APPLE_API_KEY_PATH`.)

### Cutting a release

The workflow builds whatever version is in the **tagged commit's**
`tauri.conf.json`/`Cargo.toml`, so bump + commit first, then tag:

```bash
npm run version:tauri:patch        # bump package.json/tauri.conf.json/Cargo.toml
git commit -am "chore(release): bump version to X.Y.Z"
git tag vX.Y.Z && git push origin main --tags
```

Then review the draft Release on GitHub and click Publish (or set
`releaseDraft: false` to auto-publish). **Publishing is also the auto-update
rollout gate**: installed clients (v1.3.6+) poll
`releases/latest/download/latest.json` on startup + daily, auto-download in the
background, and offer "Restart to update" in the tray + settings — the endpoint
only serves *published* releases, so a draft is invisible to clients.

### Verify a notarized build

- `spctl -a -t exec -vv SayType.app` → `accepted … source=Notarized Developer ID`
- `xcrun stapler validate SayType.app` → `The validate action worked!`

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
  `cancel_transcription`, `type_text` (delegates to `platform::insert_text`; **no clipboard
  fallback by design** — a failed insert points the user to History, since every transcription
  is already saved there; an explicit `copy_to_clipboard` command backs the manual "Copy"
  button), permission checks, history, and dictionary. The actual per-OS implementations
  (insertion, permission checks, clipboard, autostart) live behind `platform/` (see below).
- `platform/` — the platform abstraction layer (`mod.rs` contract + `macos.rs` / `fallback.rs`).
  All `#[cfg(target_os)]` capabilities — synthetic text insertion, Accessibility/Microphone
  checks, clipboard write, login-item autostart — live here. macOS is fully implemented.
  Non-macOS (`fallback.rs`, shared by Windows/Linux): text insertion is **implemented** via
  `enigo` (SendInput on Windows, XTEST/libxdo on Linux/X11), permission checks report
  "not required"; clipboard write and autostart are still stubs. See
  `docs/superpowers/specs/2026-07-01-cross-platform-support-design.md`.
- `local_asr.rs` — the local transcription backend (provider `"local"`): Qwen3-ASR-0.6B
  Q8_0 GGUF run by a **per-transcription `llama-mtmd-cli` subprocess** (pinned llama.cpp
  release, `LLAMA_BUILD`); the process exits after each decode, so idle memory is
  unchanged and cancel = kill (kill_on_drop). Owns the asset manifest (2 GGUFs +
  per-platform llama.cpp zip, ~1GB under `<app-data>/local-asr/`), the resumable
  sha256-gated downloader, and the stdout parser (`language <lang><asr_text>` prefix).
  **Invocation invariants:** `-c 2048` is mandatory (the model metadata's ctx 65536
  otherwise preallocates a 7GiB KV cache) and `-p "a"` is mandatory (empty prompt hangs
  in interactive mode). Translate mode never runs locally — it falls back to a
  configured cloud key (Groq preferred). The frontend always uploads 16 kHz mono WAV in
  local mode (`vad-gate.js` forceWav/encodeFullWav) because mtmd's miniaudio decoder
  doesn't read AAC/m4a. `SettingsPayload.has_api_key` means "assets downloaded" when
  provider is local. The language setting and dictionary do not apply to the local
  provider (auto-detect only; documented v1 limits). Engine benchmarks and the
  sherpa-onnx retreat path live in docs/superpowers/specs/2026-07-12-local-asr-qwen3-design.md.
- `updater.rs` — auto-update: daily background check of the GitHub Releases
  `latest.json` (startup + every 24 h; skipped entirely in debug builds), silent
  download, single `update-status` event channel
  (idle | checking | downloading | ready | upToDate | error); install + restart
  only on user action (tray "Restart to update to vX.Y.Z" entry / settings-page
  button). Updates are minisign-verified against the pubkey in
  `tauri.conf.json`; `createUpdaterArtifacts` lives only in
  `tauri.release.conf.json` (CI) and `tauri.updater-e2e.conf.json` (localhost
  e2e harness — see docs/superpowers/plans/2026-07-13-auto-update.md Task 8) so
  local builds never require the key. Design:
  docs/superpowers/specs/2026-07-13-auto-update-design.md.
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
  global hotkey are implemented for macOS (CGEvent/CGEventTap) **and** for Windows/Linux
  (`enigo`/`rdev`, commit `0807c49`) — but only macOS is verified on a real machine.
  Windows/Linux remain untested end-to-end (CI builds their installers as artifacts), and
  Linux recording is blocked on WebKitGTK `getUserMedia` support.
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
- (Windows/Linux insertion + hotkey are implemented (`enigo`/`rdev`) but unverified on real
  machines, and Linux recording is blocked on WebKitGTK `getUserMedia` — so they aren't live
  targets yet.)

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

### Whisper punctuation: prompt seed & temperature are dead ends on large-v3 (measured 2026-07-03)

Chinese transcriptions carry a punctuation seed (`SEED_ZH` in `commands.rs`, Whisper+zh only).
It is **not sufficient**, and no request-parameter tweak fixes it. A 77-call controlled sweep
(same audio → Groq/OpenAI via curl, temperature × prompt × 3–5 reps per condition) established:

- **Punctuation "instability" is per-content, not per-run.** At default temperature the same
  audio returns byte-identical text across repeats, every condition. Whether the decode lands in
  "punctuating mode" depends on the utterance itself — so no sampling knob can stabilize it.
- **Temperature is a dead end.** Groq's default ≡ explicit `temperature=0` (identical output);
  `0.4` is strictly worse (zero-punct collapse returns, plus run-to-run variance). Do NOT add a
  temperature parameter for punctuation.
- **On run-on colloquial speech the seed does nothing on `whisper-large-v3`.** A real 96-char
  zero-punct dictation (TTS-resynthesized) gives punct=0 deterministically under dict+seed,
  seed-only, and no-prompt alike; OpenAI `whisper-1`+seed is also 0. Whisper-family trait, not
  Groq-specific. The seed only helps content the model was already close to punctuating.
- **`whisper-large-v3-turbo`+seed punctuates where lv3+seed fails** (3 deterministic, well-placed
  marks on that clip; 0 without seed) — but density is ~half of `gpt-4o-mini-transcribe` (6–7
  marks, the reference), and turbo misheard a word on one real-mic clip, so its accuracy needs a
  real-use trial (settings → model) before any default change.
- **Bigger ≠ better punctuation: full `gpt-4o-transcribe` collapses like Whisper** (follow-up
  2026-07-07, same clip ×3): 0/1/0 marks vs mini's 6/8/7, identical words otherwise. The
  "High Quality" tier is about word accuracy, not punctuation — for zh dictation the mini is
  the right OpenAI recommendation, confirmed against its bigger sibling.
- **Prompt-leak is real on degenerate audio**: on a repetitive clip, `whisper-1` emitted the seed
  text ("欢迎使用听写工具。" ×15) as its entire output, and lv3 hallucinated video-spam
  boilerplate. The VAD gate already drops non-speech clips before upload, which covers the main
  (silence) case; highly repetitive real speech is the rare residual path.

**Conclusion:** within the Whisper prompt/params channel there is no reliable punctuation fix for
lv3. The seed stays (it's free and helps turbo); the real fix is the small-LLM post-processing
pass — TODO.md #1, confirmed by this experiment as the long-term direction.

## Development Notes

- Global shortcut is hold `Ctrl+Shift` to record (hardcoded default); Shift+Alt triggers
  translate mode. On insert failure there is **no automatic clipboard fallback** — the text
  stays in History and the prompt offers a manual "Copy" button (`copy_to_clipboard`).
- There is no JS runtime dependency: the frontend is plain static HTML/CSS/JS. All business
  logic (transcription, settings, history, hotkey, insertion) lives in Rust.
- Rust unit tests exist (e.g. `history.rs`, `settings.rs`); run with `cargo test` in `src-tauri/`.
