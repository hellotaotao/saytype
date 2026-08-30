# Dictation Lifecycle Repair and Review Follow-up

## Scope and status

Implementation and isolated validation: PASS. The changes were developed from `3b77cd6` (1.9.0), reviewed, and committed on the existing `main` checkout for the 1.9.1 release. No local application installation was performed by this task.

This document describes the final contract after the external review. It supersedes the first pass's choices to keep recovery cards visible indefinitely and to fail all batch recorders after 2 seconds. The original intermittent production stall has not been naturally reproduced; missing/late events and stalled promises are injected in regression tests.

## Final behavior

### Session completion and cancellation

- Recorder completion is separate from transcription completion. Each session owns its microphone resources, lifecycle state, stop timers, and one finalization promise. Duplicate or late events cannot automatically insert the same dictation twice.
- Chunked and live paths finalize immediately after release closes their PCM capture queues; they do not wait for the MediaRecorder Blob or its stop event. Empty recorder chunks do not invalidate complete captured PCM. A separate 2-second watch only diagnoses a missing stop callback and never changes transcription or insertion behavior.
- Batch paths log a warning at 2 seconds and keep waiting until a 15-second hard deadline. A stop event within that grace period processes normally. Periodic or first data events are not, by themselves, proof of a finalized media container.
- A batch hard timeout releases its FIFO position and reports failure. A later complete local, non-translation recording is encoded to 16 kHz WAV and saved to pending History for manual retry. It is not automatically inserted and does not repaint a newer session. Missing/reordered data, duplicate events, cancellation during encoding, and cancellation after the hard timeout are covered.
- Active Escape cancels the selected recording or latest transcription without discarding older valid work. Escape on an idle recovery card only dismisses the card; already obtained text awaiting persistence is retained. It still cancels unfinished late-audio recovery for that session.
- Native text insertion remains irreversible once dispatched. Only its real reply releases the insertion FIFO lock; no JavaScript timeout may allow a later insertion to overtake it.

### Recovery is storage, not a window-liveness condition

- Only a failure belonging to the current session may show its Copy card. The card auto-hides after 15 seconds. A newer successful dictation closes normally; old recovery text never automatically reopens the card.
- Hiding, Copy, and idle Escape do not delete unacknowledged text. New recording/result opportunities retry background persistence without blocking transcription or insertion.
- `save-recovered-transcription` accepts a strict `{id, text, kind}` payload from the input-prompt window. Kinds are `incomplete` and `insert-failed`; IDs are stable, text is nonempty and capped at 1 MiB, and unknown fields are rejected. This is a content-storage command, separate from content-free diagnostics.
- A successful persistence response is an actual History write acknowledgement. Errors do not become successful acknowledgements. After a renderer timeout, a late acknowledgement can release only the exact recovery object it belongs to, never a replacement or newer session's content.
- Text writes are idempotent under the History lock. Complete failed-insertion text can reuse the most recent matching successful History row instead of creating a duplicate. Incomplete text is stored separately, with `success:false` and recovery metadata. Existing 100-entry retention and associated audio cleanup remain in effect.
- Late local audio uses an optional stable `recovery-id` on `save-pending-transcription`. Retrying an unacknowledged save reuses the pending row/audio rather than duplicating them. Different bytes or MIME under the same ID are rejected; a failed History write rolls back its unreferenced audio. Legacy two-argument callers retain their existing behavior.
- Late recovery audio is adopted on `dataavailable`, independently of `onstop`. The recorder currently uses neither a timeslice nor `requestData`, so recovery expects one final container. WAV encoding checks that the container can be decoded; decode success is not a general proof that every possible recording is complete. Encoding or persistence failure retains the original Blob/text in memory for later retry. An explicitly cancelled active transcription may discard its unfinished result, as before.

### Deadlines and diagnostics

- Resampling/encoding waits: 30 seconds. Individual transcription IPC waits: 450 seconds. Best-effort History/recovery IPC waits: 5 seconds. A healthy multi-chunk dictation may drain serially without an arbitrary aggregate deadline.
- Native Qwen requests: 420-second outer deadline covering inference queue acquisition, worker startup, decode/fallback, and child exit. Prewarm: 30 seconds. Existing 180-second per-attempt and no-progress watchdogs remain.
- Dropping a timed-out native future releases its semaphore permit and owned child/temporary WAV resources. Tests include a real child process whose output pipes close before it exits.
- Lifecycle logs contain fixed phase/event labels and numeric IDs/counts/timings, not transcripts or arbitrary renderer errors. Release enables this dedicated target at Info; other logging remains Warn. Release-triggered finalization does not report a recorder-stop completion. A timeout without a later callback only establishes that the frontend did not observe that callback; it does not, by itself, identify a WebKit root cause.
- Native phase changes now use one line containing the new phase plus the previous phase's duration, instead of separate leave/start lines. Rotation uses 2 MB per file with two archived files plus the active file, approximately 6 MB total for the configured plugin version. No fixed number of retention days is promised. The in-app diagnostic viewer still shows a bounded tail of the active log.

## Files changed

| File | Responsibility |
| --- | --- |
| `src/views/input-prompt.js` | Session lifecycle, grace periods, cancellation, recovery storage/UI separation, late-result isolation |
| `src/views/input-prompt.test.mjs` | Recorder, FIFO, timeout, recovery, persistence-ACK and cancellation regressions |
| `src-tauri/src/local_asr.rs` | Whole-request deadlines, phase diagnostics, subprocess/resource-cleanup regressions |
| `src-tauri/src/history.rs` | Locked, atomic, idempotent recovery text/audio persistence and filesystem tests |
| `src-tauri/src/commands.rs` | Strict lifecycle diagnostics and recovered-text commands; optional stable pending-audio ID |
| `src-tauri/src/lib.rs` | IPC registration and bounded multi-file release logging |
| `src/views/ipc-bridge.js` | New command mapping and optional raw-audio recovery header |
| `src/views/ipc-bridge.test.mjs` | Wire-shape and legacy-call compatibility regressions |
| `src/views/i18n.js` | Incomplete-transcription and confirmed-History recovery hints |

## Validation record (2026-08-30 to 2026-08-31)

The affected recovery, batch-grace, persistence and log-transition regressions were observed RED before implementation, then GREEN. The first-pass tests that intentionally required old recovery to keep the window open were changed to assert the approved replacement contract.

| Command / runtime check | Result |
| --- | --- |
| `node --check src/views/input-prompt.js`, `node --check src/views/ipc-bridge.js`, `node --check src/views/i18n.js` | Passed |
| `node --test src/views/*.test.mjs scripts/*.test.mjs` | 159/159 passed; 78 input-prompt tests |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 132 passed; opt-in ASR smoke and one platform documentation test ignored in the default run |
| `cargo check --manifest-path src-tauri/Cargo.toml` | Passed |
| `npm run tauri -- build --no-bundle` | Passed; release executable built without installing or changing version |
| `cargo test --manifest-path src-tauri/Cargo.toml real_subprocess_smoke -- --ignored --nocapture` | Passed using actual local Qwen assets: prewarm, repeated decode, resident reuse, idle exit and temporary-file cleanup |
| Native WKWebView review-follow-up suite | 10 scenarios passed, including actual 15-second auto-hide, batch grace, late local audio recovery, post-timeout Escape and late-cloud privacy; no uncaught JavaScript errors |
| Native WKWebView final idle-Escape suite | 3 checks passed: Escape retains unsaved text, next successful dictation closes normally, later persistence does not reopen the card |
| Prior native WKWebView long-audio check | 78 seconds of continuous synthetic capture crossed the 75-second chunk boundary, producing two chunks and one assembled result; this check preceded the recovery-display follow-up |
| Independent review | No remaining blocker identified; the missing-stop late-audio regression now passes in native WKWebView with one save and no duplicate after a late stop. Five additional live/upload/cancellation/setup checks passed. Earlier persistence, hide/ACK/Copy/provider-change checks also passed |
| `git diff --check` | Passed |

WKWebView used real MediaRecorder, AudioWorklet and OfflineAudioContext with synthetic 48 kHz input and validated 16 kHz WAV output. ASR, History and text insertion IPC were simulated in this isolated window. Separate Rust tests exercised actual temporary-file persistence, and the separate Qwen smoke exercised the real model/backend. The full Rust suite ran in a normal macOS session for the system clipboard test, with a wrapper restoring the test's clipboard mutation without overwriting a newer user change. No test inserted text into another application or modified the user's transcription History.

## Explicit boundaries and next gate

- The in-memory recovery fallback does not survive application exit. Durable recovery is guaranteed only after a persistence acknowledgement. Disk failure must not be described as successful saving.
- Cloud/translation audio that arrives after the hard recorder deadline stays in memory: it is neither newly persisted as raw audio nor silently sent through a possibly changed provider. Before the deadline, its normal transcription path is unchanged. This avoids expanding the existing cloud-audio persistence policy.
- If a pending audio entry has already been manually retranscribed in History, a stale retry of the original pending-save request returns an error rather than overwriting that completed entry. Idempotency is not a promise to undo explicit History deletion, retention eviction, or user-driven state transitions.
- No installation was performed by this task. After approval to install the test build, verify real microphone capture, global-hotkey release and insertion into a chosen editable application, including repeated dictation, long dictation, Escape and failure recovery. Isolated tests do not establish the original incident's exact trigger.
