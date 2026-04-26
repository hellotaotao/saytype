# macOS Swift Helper Plan

## Executive Summary

WhispLine may become SayType, but the core product promise stays the same: hold a global shortcut, speak, transcribe, and insert text into the currently focused macOS app. The weakest part of that promise is not transcription; it is reliable insertion into arbitrary target apps after the user grants macOS permissions.

A native Swift helper is worth adding because it can concentrate macOS-specific input, focus, Accessibility, clipboard, and fallback behavior in a small, testable binary. It does not bypass Accessibility permission. Instead, after permission is granted, it should make focused-target detection, direct insertion, paste-based insertion, clipboard restore, focus recovery, and app-specific behavior more predictable than spreading those concerns across Rust FFI, AppleScript, web UI fallbacks, and legacy Electron code.

Competitor signal from Wispr Flow supports this direction: an app shell can remain Electron or web-based while a native Swift helper owns Accessibility, event taps and hotkeys, focused element detection, paste or direct insertion, clipboard restore, focus recovery, and app-specific insertion behavior.

## Current Architecture Observed in the Repo

This plan is based on the current repository paths and code shape, not on a production-code change.

### `src-tauri/src/hotkey.rs`

- Owns global hold-to-record shortcut state.
- Parses modifier-only shortcuts such as `Ctrl+Shift`.
- Tracks modifier press/release state, debounce windows, recording start, recording stop, and Escape cancellation.
- On macOS, starts a Core Graphics event tap only when Accessibility is trusted.
- Uses a listen-only event tap for key down and flags-changed events, then emits Tauri events such as start, stop, and cancel recording.
- On non-macOS, falls back to `rdev::listen`.

### `src-tauri/src/commands.rs`

- Exposes Tauri commands for settings, permissions, transcription, dictionary/history, and text insertion.
- `transcribe_audio` performs remote transcription using the selected provider and API key. This is outside the Swift helper scope for now.
- `type_text` is the current insertion command.
- On macOS, it checks Accessibility with `AXIsProcessTrustedWithOptions`.
- If Accessibility is granted, it first tries Unicode text insertion via `CGEventKeyboardSetUnicodeString`.
- If direct insertion fails, or if Accessibility is not granted, it uses clipboard insertion.
- Clipboard auto-paste currently uses `osascript` to send Cmd+V when Accessibility is available, then attempts to restore the original clipboard text.
- Permission commands include microphone status, Accessibility status, Accessibility prompt, and recheck flows.

### `src-tauri/src/lib.rs`

- Builds the Tauri app, injects renderer entry scripts for the main, settings, and input prompt windows.
- Runs migration, creates the tray, stores initial Accessibility state, starts the hotkey listener, and registers command handlers.
- Registers `commands::type_text` as the bridge from renderer transcription flow into native insertion behavior.

### `src/views/*`

- Contains the web UI for main window, settings, and the floating input prompt.
- `src/views/ipc-bridge.js` maps renderer IPC names such as `type-text` and `transcribe-audio` to Tauri command names.
- `src/views/input-prompt.js` records audio, calls `transcribe-audio`, then calls `type-text`.
- The renderer distinguishes direct insertion methods such as `cgevent_unicode` from clipboard methods such as `clipboard_textinsert` and `clipboard`.
- It has a final renderer-side clipboard fallback using `navigator.clipboard.writeText`.
- `src/views/settings.js` checks and requests Accessibility and microphone permissions through Tauri commands.
- UI strings live in `src/views/i18n.js`.

### `src/macos-text-inserter-koffi.js`

- Appears to be a legacy or older Electron path.
- Uses `koffi` to call Core Graphics APIs from JavaScript.
- Sends Unicode keyboard events via `CGEventKeyboardSetUnicodeString`.
- Mirrors the current Rust direct-insertion idea, but it is not the right long-term place for macOS-specific insertion policy in the Tauri branch.

## Scope Boundaries

### In Scope

- macOS-only input, focus, permission, and insertion behavior.
- Accessibility trust checks and user-facing permission status data.
- Focused application and focused UI element detection.
- Direct text insertion through Accessibility or Core Graphics where appropriate.
- Clipboard-safe paste insertion with bounded clipboard restore.
- Focus recovery after WhispLine/SayType UI hides.
- App-specific insertion strategies and fallback selection.
- Local helper diagnostics that avoid transcript content.

### Out of Scope for the Swift Helper

- Transcription provider selection.
- Audio capture.
- API key storage.
- Dictionary or prompt management.
- Activity history.
- Cross-platform insertion behavior for Windows or Linux.
- Renaming the product from WhispLine to SayType.

### Explicit Non-Goal

The Swift helper does not bypass macOS Accessibility permission. It should use standard macOS APIs and make the permission dependency clearer and more reliable. If Accessibility is denied, the helper can report that state and support manual clipboard copy flows, but it cannot silently control other apps.

## Phased Architecture

### Phase 1: Small Swift CLI Helper Invoked by Tauri/Rust

Add a small signed Swift command-line helper bundled inside the Tauri app. Rust invokes it as a subprocess for narrowly scoped operations:

- `status`
- `focused-target`
- `insert-text`
- `paste-text`
- `restore-clipboard`
- optional combined `clipboard-safe-insert`

Phase 1 should keep orchestration in `src-tauri/src/commands.rs`. The helper is a native macOS capability adapter. It returns structured JSON, never logs transcript text, and exits quickly.

Why this phase first:

- Low integration risk.
- Easy to inspect and test manually from Terminal.
- Keeps app behavior behind the existing `type_text` command.
- Allows direct comparison against current Rust CGEvent and clipboard behavior.

Tradeoff:

- Process startup cost per insertion.
- Harder to maintain state such as previous focus, per-app strategy cache, or clipboard ownership windows.

### Phase 2: Long-Running Helper Process

Promote the helper to a long-running local process managed by the Tauri app.

Transport options:

- JSON-RPC over stdin/stdout.
- Unix domain socket under the app container or user runtime directory.

Responsibilities:

- Maintain last focused target before WhispLine/SayType UI appears.
- Keep a short-lived clipboard restore token.
- Cache target app metadata and insertion strategy.
- Provide lower-latency insert and paste calls.
- Emit local status events for permission changes and target changes.

Phase 2 should still be local-only and app-owned. It should not become a network service.

### Phase 3: App-Specific Insertion Engine and Context Capture

Add app-specific strategy selection and richer context capture.

Examples:

- Cursor and VS Code: prefer paste for multi-line or code-like text; direct insertion may work for short text but can be less reliable in Monaco editors.
- Safari and Chrome: use focused element role and URL/browser process metadata to choose direct insertion vs paste.
- Slack and Teams: prefer paste with focus recovery because rich text editors often intercept synthetic key events.
- Notes and Word: support paste-first for formatted editors, then direct insertion fallback for simple text fields.
- Terminal: avoid direct Unicode event batching for shell-sensitive content; paste with newline handling policy.

Context capture should be minimal:

- bundle identifier
- process name
- focused element role/subrole
- whether the focused element appears editable
- selected text length if needed and safe
- no transcript body
- no full document text

## Phase 1 Command/API Contract

All Phase 1 commands should accept JSON on stdin and return one JSON object on stdout. Stderr is reserved for non-sensitive diagnostics and should not include transcript text, clipboard contents, API keys, environment dumps, or focused document content.

Common request envelope:

```json
{
  "id": "req_2026_04_26_001",
  "command": "status",
  "payload": {}
}
```

Common success envelope:

```json
{
  "id": "req_2026_04_26_001",
  "ok": true,
  "result": {}
}
```

Common error envelope:

```json
{
  "id": "req_2026_04_26_001",
  "ok": false,
  "error": {
    "code": "accessibility_denied",
    "message": "Accessibility permission is required for this operation.",
    "recoverable": true
  }
}
```

### `status`

Purpose: report helper availability and macOS permission state.

Request:

```json
{
  "id": "req_status_001",
  "command": "status",
  "payload": {
    "promptForAccessibility": false
  }
}
```

Response:

```json
{
  "id": "req_status_001",
  "ok": true,
  "result": {
    "helperVersion": "0.1.0",
    "accessibility": {
      "granted": true,
      "status": "granted"
    },
    "clipboardAvailable": true,
    "supportsFocusedTarget": true,
    "supportsDirectInsert": true,
    "supportsClipboardPaste": true
  }
}
```

### `focused-target`

Purpose: identify the focused app and editable target without collecting document content.

Request:

```json
{
  "id": "req_focus_001",
  "command": "focused-target",
  "payload": {}
}
```

Response:

```json
{
  "id": "req_focus_001",
  "ok": true,
  "result": {
    "app": {
      "bundleId": "com.todesktop.230313mzl4w4u92",
      "name": "Cursor",
      "processId": 12345
    },
    "element": {
      "role": "AXTextArea",
      "subrole": null,
      "editable": true
    },
    "recommendedStrategy": "clipboard-paste",
    "confidence": "medium"
  }
}
```

Failure when no editable target is found:

```json
{
  "id": "req_focus_001",
  "ok": false,
  "error": {
    "code": "no_editable_target",
    "message": "No focused editable target was detected.",
    "recoverable": true
  }
}
```

### `insert-text`

Purpose: insert text directly without using the clipboard when the focused target supports it.

Request:

```json
{
  "id": "req_insert_001",
  "command": "insert-text",
  "payload": {
    "text": "Hello from WhispLine.",
    "target": {
      "bundleId": "com.apple.Notes"
    },
    "options": {
      "allowSyntheticKeyboard": true,
      "maxBatchCharacters": 20,
      "restoreFocus": true
    }
  }
}
```

Response:

```json
{
  "id": "req_insert_001",
  "ok": true,
  "result": {
    "method": "accessibility-insert",
    "inserted": true,
    "targetBundleId": "com.apple.Notes",
    "focusRestored": true,
    "clipboardTouched": false
  }
}
```

Expected error when direct insertion is inappropriate:

```json
{
  "id": "req_insert_001",
  "ok": false,
  "error": {
    "code": "direct_insert_unsupported",
    "message": "Direct insertion is not supported for the focused target.",
    "recoverable": true,
    "suggestedFallback": "paste-text"
  }
}
```

### `paste-text`

Purpose: paste text through the system clipboard and Cmd+V, with optional restore.

Request:

```json
{
  "id": "req_paste_001",
  "command": "paste-text",
  "payload": {
    "text": "Paste this text.",
    "options": {
      "restoreClipboard": true,
      "restoreDelayMs": 500,
      "restoreFocus": true,
      "preserveClipboardTypes": ["public.utf8-plain-text"],
      "newlinePolicy": "preserve"
    }
  }
}
```

Response:

```json
{
  "id": "req_paste_001",
  "ok": true,
  "result": {
    "method": "clipboard-paste",
    "pasted": true,
    "clipboardRestored": true,
    "clipboardRestoreCompleteness": "text-only",
    "focusRestored": true
  }
}
```

### `restore-clipboard`

Purpose: restore clipboard from a short-lived token created by a previous clipboard-safe operation. Phase 1 can either expose this as a separate operation or fold it into `paste-text`.

Request:

```json
{
  "id": "req_restore_001",
  "command": "restore-clipboard",
  "payload": {
    "restoreToken": "clip_8f37c8e2",
    "maxAgeMs": 5000
  }
}
```

Response:

```json
{
  "id": "req_restore_001",
  "ok": true,
  "result": {
    "restored": true,
    "restoreCompleteness": "text-only"
  }
}
```

### `clipboard-safe-insert`

Purpose: one-shot command for the most common Phase 1 path: capture minimal target state, write clipboard, paste, wait, restore clipboard, and return result.

Request:

```json
{
  "id": "req_safe_001",
  "command": "clipboard-safe-insert",
  "payload": {
    "text": "One-shot clipboard-safe insert.",
    "options": {
      "restoreDelayMs": 500,
      "restoreFocus": true,
      "newlinePolicy": "preserve"
    }
  }
}
```

Response:

```json
{
  "id": "req_safe_001",
  "ok": true,
  "result": {
    "method": "clipboard-safe-insert",
    "targetBundleId": "com.microsoft.VSCode",
    "pasted": true,
    "clipboardRestored": true,
    "focusRestored": true
  }
}
```

## Fallback Matrix

The matrix below is a starting policy. It should be validated manually before becoming default behavior.

| Target app | Direct insertion | Clipboard paste | Simulated keypress | Recommended default | Notes |
| --- | --- | --- | --- | --- | --- |
| Cursor / VS Code | Medium for short plain text; lower for multi-line/code | High | Medium | Clipboard paste | Monaco editors often handle paste more predictably than synthetic Unicode batches. Preserve newlines exactly. |
| Safari / Chrome | Medium to high for simple inputs | High | Medium | Focus-aware direct insert, then clipboard paste | Browser pages vary. Use Accessibility role/editability and fall back quickly. |
| Slack / Teams | Low to medium | High | Low | Clipboard paste | Rich text editors can ignore or transform synthetic key events. Restore focus before paste. |
| Notes | Medium | High | Medium | Clipboard paste, direct insert fallback | Rich text behavior makes paste more predictable for multi-line text. |
| Word | Low to medium | High | Low | Clipboard paste | Word has complex document and selection behavior. Avoid relying on direct Unicode insertion. |
| Terminal | Low | Medium to high with policy | Low | Clipboard paste with newline policy | Newlines can execute commands. Consider "preserve", "strip-final-newline", or confirmation for risky text. |

General fallback order for Phase 1:

1. If Accessibility is denied, return `accessibility_denied` and let the app show explicit permission UX or manual clipboard fallback.
2. If focused target is unavailable, attempt focus recovery to the last non-helper app, then retry once.
3. If app policy prefers direct insertion, try direct insertion first and return method-specific failure without transcript logging.
4. If direct insertion fails or policy prefers paste, use clipboard-safe insertion.
5. If automatic paste fails, leave text on clipboard only if the app explicitly chooses that fallback and tells the user to press Cmd+V.

## Privacy and Security Constraints

- Do not log transcript text.
- Do not log clipboard contents.
- Do not persist clipboard contents beyond a short restore window.
- Do not dump environment variables, process environment, keychain data, API keys, or app settings.
- Keep the helper local-only. It must not open network sockets. If Phase 2 uses a socket, use a local Unix domain socket with restrictive file permissions.
- Treat focused-target metadata as sensitive. Keep it minimal and avoid document titles, page contents, selected text, URLs, or full Accessibility tree dumps unless a future explicit diagnostic mode redacts them.
- The helper should have explicit, understandable permission UX through the main app. It should report that Accessibility is required for global control and automatic insertion.
- All debug modes must be opt-in and must redact transcript text by default.
- Use structured error codes instead of free-form dumps from macOS APIs.

## Packaging, Signing, and Notarization

The current Tauri config uses:

- product name `WhispLine`
- bundle identifier `com.tao.whispline`
- hardened runtime enabled
- macOS entitlements at `build/entitlements.mac.plist`
- DMG target
- minimum macOS version 10.15

Future helper packaging should account for:

- Bundle the helper inside the `.app`, for example under `Contents/MacOS/` or `Contents/Resources/helpers/`.
- Ensure Rust resolves the helper path relative to the app bundle, not the working directory.
- Sign the helper binary with the same Developer ID identity as the app.
- Sign nested code before signing the outer app bundle.
- Notarize the complete app bundle/DMG after the helper is included.
- Verify Gatekeeper assessment on a clean machine.
- Confirm whether the helper itself or the main app appears in Accessibility settings. The intended user experience should be documented before release.
- Keep Info.plist permission descriptions aligned with the product name, especially if WhispLine is renamed to SayType.
- Revisit entitlements only if the helper requires new capabilities. Do not broaden entitlements preemptively.
- Build universal or per-architecture helper binaries consistently with the Tauri macOS build target.

Open packaging question:

- If the helper is executed as a separate process, macOS TCC behavior may attribute Accessibility trust to the helper binary rather than only the parent app. The implementation phase must test whether users need to grant permission to WhispLine/SayType, the helper, or both. This is one reason Phase 1 should include explicit permission verification before shipping.

## Verification and Manual Test Plan

This repo does not currently have an automated test framework for this behavior. Verification should be manual and OS-focused.

### Preflight

- Build a development helper locally without network calls.
- Confirm helper exists in the expected app-relative path.
- Confirm `status` returns valid JSON with Accessibility denied and granted.
- Confirm no transcript text appears in stdout/stderr logs except inside the intended JSON request/response during direct CLI testing.

### Permission UX

- Reset Accessibility permission with `tccutil reset Accessibility com.tao.whispline`.
- Launch the app and confirm hotkey/insertion status clearly reports denied permission.
- Request permission through the app and confirm macOS opens the expected Privacy & Security pane.
- Grant permission, relaunch if needed, and confirm status changes to granted.
- Revoke permission and confirm the helper and app return recoverable errors.

### Focused Target

For each target app below:

- Put the cursor in an editable field.
- Run `focused-target`.
- Confirm bundle id, app name, editable state, and recommended strategy are plausible.
- Move focus to a non-editable area and confirm a recoverable no-target response.

Target apps:

- Cursor or VS Code
- Safari
- Chrome
- Slack
- Teams
- Notes
- Word
- Terminal

### Insertion

Test text cases:

- short ASCII: `hello world`
- punctuation: `Hello, world.`
- multi-line text
- non-English text
- emoji or composed Unicode
- text with leading/trailing whitespace
- text ending with newline

For each target app:

- Test direct insertion if the matrix says it is supported.
- Test clipboard-safe insertion.
- Confirm focus returns to the target app after the floating prompt hides.
- Confirm the clipboard is restored after the configured delay.
- Confirm failed direct insertion falls back to paste without losing focus.
- Confirm manual clipboard fallback leaves the transcript on the clipboard only when automatic paste fails.

### Clipboard Restore

- Start with empty clipboard.
- Start with plain text clipboard.
- Start with rich clipboard content from Word or a browser.
- Confirm Phase 1 restore expectations are honest. If only text restore is supported, report `text-only` rather than claiming full restore.
- Confirm restore does not happen after the token max age.

### Regression Checks

- Recording shortcut still starts/stops recording through existing `src-tauri/src/hotkey.rs`.
- `src/views/input-prompt.js` still calls `transcribe-audio` then `type-text`.
- Settings permission checks still work.
- Transcription still uses existing app configuration and API key storage.
- No network behavior is introduced by the helper.

## Future Implementation Tasks

These are future work items only. They should not be implemented as part of this planning document.

1. Create helper source directory.
   - Likely new files: `src-tauri/helpers/macos-swift-helper/Package.swift`, `src-tauri/helpers/macos-swift-helper/Sources/MacOSSwiftHelper/main.swift`.
   - Purpose: Swift CLI skeleton, JSON stdin/stdout parsing, command dispatch, structured errors.

2. Add helper command models.
   - Likely new files: `src-tauri/helpers/macos-swift-helper/Sources/MacOSSwiftHelper/Protocol.swift`.
   - Purpose: request/response envelopes, error codes, status payloads, focused-target payloads, insertion payloads.

3. Add macOS permission adapter.
   - Likely new files: `src-tauri/helpers/macos-swift-helper/Sources/MacOSSwiftHelper/AccessibilityPermission.swift`.
   - Purpose: `AXIsProcessTrustedWithOptions` wrapper and permission status mapping.

4. Add focused-target adapter.
   - Likely new files: `src-tauri/helpers/macos-swift-helper/Sources/MacOSSwiftHelper/FocusedTarget.swift`.
   - Purpose: frontmost app, focused UI element, editable role detection, minimal metadata.

5. Add insertion strategies.
   - Likely new files: `src-tauri/helpers/macos-swift-helper/Sources/MacOSSwiftHelper/TextInsertion.swift`, `ClipboardInsertion.swift`, `AppStrategy.swift`.
   - Purpose: direct insertion, clipboard-safe insertion, app-specific strategy selection, focus recovery.

6. Add Rust subprocess wrapper.
   - Likely modified files: `src-tauri/src/commands.rs`.
   - Possible new file: `src-tauri/src/macos_helper.rs`.
   - Purpose: find helper binary, send JSON request, parse JSON response, map helper methods to existing `TypeTextResponse`.

7. Wire helper behind a feature flag or runtime setting.
   - Likely modified files: `src-tauri/src/commands.rs`, `src-tauri/src/settings.rs`, `src/views/i18n.js`, `src/views/settings.*` if exposed.
   - Purpose: compare helper insertion against current Rust insertion safely before making it default.

8. Add packaging integration.
   - Likely modified files: `src-tauri/tauri.conf.json`, build scripts under `scripts/`, possibly `package.json`, and signing/notarization workflow docs.
   - Purpose: build the Swift helper before Tauri packaging and include it in the app bundle.

9. Update permission copy if needed.
   - Likely modified files: `src-tauri/Info.plist`, `src/views/i18n.js`, `README.md`.
   - Purpose: accurately explain Accessibility and microphone usage, especially if product naming changes to SayType.

10. Add a manual QA checklist.
    - Likely new file: `docs/macos-swift-helper-test-plan.md` or an expanded section in this file.
    - Purpose: repeatable release testing for target apps and permission states.

## Recommended Next Action

Before implementation, validate Phase 1's TCC behavior with a tiny signed Swift CLI prototype outside production code: confirm whether Accessibility permission is attributed to the main Tauri app, the helper binary, or both. That result should decide the exact packaging and permission UX before any production integration begins.
