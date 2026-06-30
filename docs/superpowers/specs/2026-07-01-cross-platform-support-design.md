# Cross-platform (Windows + Linux) support — design

**Status:** Phase 0 (platform abstraction) + CI scaffold implemented. Later
phases not started.
**Date:** 2026-07-01
**Scope:** Make SayType — today a macOS-only Tauri 2 + Rust app — run on Windows
and Linux, starting with a behavior-preserving abstraction layer, then filling
platforms one at a time (Windows first, Linux next, native Wayland out of scope
for v1).

## Decisions (locked)

1. **Abstraction layer first.** Collect every `#[cfg(target_os)]` capability
   behind `src-tauri/src/platform/` with a clear contract; macOS behavior stays
   identical; non-macOS keeps its current stub behavior. Then fill platforms.
2. **Pragmatic implementation style.** Prefer mature cross-platform crates when
   filling platforms — `enigo` for synthetic input, `tauri-plugin-autostart`
   for the login item — over hand-rolled per-OS FFI.
3. **Windows before Linux.** Windows is low-risk and ships fast. Linux X11 is
   medium. **Native Wayland is explicitly out of scope for v1** (run under
   XWayland); it breaks both the global hold-hotkey and synthetic insertion at
   once, with no clean cross-compositor solution.
4. **Mac-only development is viable.** Code, compile-checking (`cargo-xwin` for
   Windows, Docker for Linux), and producing installers (CI matrix) all happen
   on the Mac / in CI. Only final behavioral QA needs the target OS (VM / cloud
   / borrowed machine), and it can be deferred.

## What's already portable (verified, zero work)

Transcription, HTTP (`reqwest` + `rustls-tls`, no system OpenSSL at runtime),
settings, history, dictionary, `dirs` paths + atomic writes, the tray, the
windows, the single-instance plugin, and the platform-agnostic hotkey state
machine all compile and run cross-platform unchanged. macOS-only crates
(`core-foundation`, `objc`) are already `cfg`-gated.

## Phase 0 — platform abstraction (DONE)

New module `src-tauri/src/platform/`:

- `mod.rs` — the contract + compile-time selection (`macos` vs `fallback`) +
  the shared `InsertResult` enum.
- `macos.rs` — the existing macOS implementation, moved verbatim: Accessibility
  / Microphone checks, CGEvent Unicode insertion with the focused-field guard,
  `pbcopy` clipboard write, opening the Accessibility pane, the LaunchAgent
  login item.
- `fallback.rs` — current non-macOS behavior (permissions "not required" /
  "granted", insertion `Unsupported`, clipboard error, autostart no-op). Splits
  into `windows.rs` / `linux.rs` when those platforms are filled.

### Contract

```rust
fn accessibility_required() -> bool;          // macOS: true;  others: false
fn accessibility_granted(prompt: bool) -> bool; // macOS: AX;  others: true
fn microphone_status() -> String;             // macOS: AVFoundation; others: "granted"
fn open_accessibility_settings();             // macOS: open pane; others: no-op
fn copy_to_clipboard(text: &str) -> Result<()>; // macOS: pbcopy; others: Err
fn insert_text(text: &str) -> InsertResult;   // macOS: focus+CGEvent; others: Unsupported
fn set_auto_launch(enabled: bool) -> Result<()>; // macOS: plist; others: no-op
```

`InsertResult` = `Inserted { method }` | `NoEditableTarget` | `Failed` |
`Unsupported`; `commands::type_text` maps each to the user-facing response, so
all copy stays in the command layer.

### Call sites rewired

`commands.rs` (`type_text`, `show_permission_dialog`, `copy_to_clipboard`,
`check_microphone_permission`, `accessibility_status`,
`current_accessibility_granted`), `settings.rs` (`update_auto_launch` delegates
to `platform::set_auto_launch`), `hotkey.rs` (the macOS listener's permission
gate now calls `platform::accessibility_granted(false)`; the duplicate
`AXIsProcessTrusted` FFI is gone). The hotkey **event source** (CGEventTap /
`rdev`) intentionally stays in `hotkey.rs` — it is cohesive and already
`cfg`-split; only its permission gate moved.

### Also in Phase 0

- `SettingsPayload` gained an **`os`** field (`std::env::consts::OS`) so the
  frontend can pick OS-correct copy / modifier glyphs instead of the deprecated
  `navigator.platform`. (Frontend not yet consuming it.)

### Verification

`cargo test` → 18 passed. `cargo check` (macОС) clean. Behavior on macOS is
unchanged. The non-macOS arm is verified by the CI matrix (below); bare
`cargo check --target x86_64-pc-windows-msvc` on a Mac fails inside `ring`'s C
build (no MSVC headers) — use `cargo-xwin` for local Windows compile-checks.

## Phase 1 — build plumbing (DONE in this pass)

- `bundle.targets` → `"all"` (host-aware: dmg on macOS, nsis/msi on Windows,
  deb/rpm/appimage on Linux).
- New `.github/workflows/ci.yml`: matrix [macos-latest, windows-latest,
  ubuntu-22.04] that builds and uploads installers as artifacts. Additive — the
  signed/notarized macOS `release.yml` is untouched. This is the build farm +
  the authoritative non-macOS compile check.
- Linux build deps documented in the workflow (webkit2gtk-4.1, libxdo,
  libxtst, libayatana-appindicator, librsvg, patchelf, …).

## Phase 2 — Windows (next)

Low-risk, ships fast. WebView2 = Chromium gives getUserMedia / MediaRecorder /
WASM-VAD for free (one-time mic prompt).

- Deps: `enigo` (`cfg(not(target_os = "macos"))`), `tauri-plugin-autostart`.
- Split `fallback.rs` → `windows.rs`: `insert_text` via `enigo.text()`
  (SendInput KEYEVENTF_UNICODE); `set_auto_launch` via the autostart plugin
  (HKCU Run key — adopting the plugin also migrates macOS off the hand-rolled
  plist, verified separately).
- Enable the existing `rdev::listen` branch (WH_KEYBOARD_LL). The hotkey state
  machine needs no change.
- Frontend: generalize the `result.method === "cgevent_unicode"` success check
  (`input-prompt.js:912`) to key off `result.success`; OS-aware modifier glyphs
  / copy via the new `os` field.
- Document the UIPI caveat (a non-elevated app can't inject into elevated
  windows).

## Phase 3 — Linux X11

- `windows.rs`/`linux.rs`: `enigo` (xdo/XTEST) insertion, `rdev` (XRecord)
  hotkey, `.desktop` autostart.
- **Critical prerequisite spike:** verify/enable WebKitGTK getUserMedia
  (`-DENABLE_MEDIA_STREAM`/`-DENABLE_WEB_RTC` + gst-plugins-bad + a wry
  permission handler + `GDK_BACKEND=x11`). If stock distro WebKitGTK lacks
  media-stream, the app **cannot record at all** — this may force bundling a
  WebKitGTK (AppImage) and is the single biggest Linux blocker.
- Validate tray visibility (GNOME ships no tray by default — the app is
  tray-driven, so this needs a mitigation) and transparent-window rendering.

## Phase 4 — Linux Wayland (out of scope for v1)

Run under XWayland. If pursued later: `enigo` libei insertion (GNOME ≥ 46 /
KDE ≥ 6.1, non-ASCII reliability unverified — a real risk for Chinese
dictation), evdev/portal hotkey, and an honest "wayland-limited" status.

## Phase 5 — distribution hardening (deferred)

Windows Authenticode (Azure Trusted Signing / EV), Linux checksums/GPG,
WebView2 install-mode choice, auto-update strategy.

## Known cross-cutting risks

WebKitGTK getUserMedia (Linux blocker), Wayland (both core features), enigo
libei non-ASCII reliability, `rdev 0.5` is old/unmaintained yet carries the
Win + Linux-X11 hotkey, GNOME invisible tray, no cross-compile from Mac
(CI-dependent), transparent always-on-top input-prompt rendering on Linux.
