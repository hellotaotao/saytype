# Neural VAD (gate-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skip transcription entirely when a hold-to-talk recording contains no speech, killing Whisper's silence-hallucination / prompt-echo, without dropping quiet-but-real speech.

**Architecture:** Pure-frontend gate. After recording stops and before invoking `transcribe-audio`, decode the blob to mono PCM and run **Silero (legacy) via `@ricky0123/vad-web`'s `NonRealTimeVAD`** (onnxruntime-web / WASM) in the existing WKWebView; vad-web resamples to 16 kHz internally. Skip the upload if total detected speech is under a threshold. The Rust backend and the recording pipeline are untouched. Assets are **vendored** (no bundler, no npm runtime dep).

**Tech Stack:** Plain static HTML/JS (no bundler), `@ricky0123/vad-web` 0.0.30 (`NonRealTimeVAD`) + `onnxruntime-web` 1.27.0 as vendored static assets, `node:test` for the pure decision logic. Design spec: `docs/superpowers/specs/2026-06-21-neural-vad-design.md`.

## Global Constraints

- **No bundler, no npm runtime dependency in the app.** VAD ships as vendored static files under `src/views/vendor/vad/`. This is the one accepted exception to the project's "frontend is plain static HTML/CSS/JS" rule (see spec); it must NOT introduce a build step or a `package.json` app dependency.
- **Backend untouched.** No changes to `src-tauri/` (no `transcribe_audio` change, no `AppConfig` change). The gate lives entirely in the frontend and simply does not call `transcribe-audio` when there is no speech.
- **Fail-open.** Any VAD error (load failure, decode failure, runtime error) MUST fall through to normal transcription. A VAD bug must never eat a real recording.
- **Existing classic-script world.** Frontend files are classic scripts (no ES modules) except the one new pure-logic module, which is `.mjs`. Cross-file calls go through `window.*` globals, matching the existing code.
- **Reuse existing copy.** The no-speech UI string `inputPrompt.noSpeech` already exists (`src/views/i18n.js`, used at `src/views/input-prompt.js:793`). Do NOT add a new string.
- **Threshold default:** `MIN_SPEECH_MS = 250` (start/end are milliseconds — verified in vad-web source). VAD positive-speech threshold left at the vad-web default. No user-facing config in v1 (hardcoded consts; a settings toggle is a deferred follow-up).

---

## File Structure

- `src/views/vendor/vad/` — **created (Task 0.1, committed).** Vendored static assets:
  `ort.wasm.min.js` (onnxruntime-web UMD → `window.ort`), `ort-wasm-simd-threaded.wasm` + `.mjs` (ort runtime),
  `bundle.min.js` (+ `.LICENSE.txt`) (vad-web UMD → `window.vad`, externalizes ort), `silero_vad_legacy.onnx`
  (model `NonRealTimeVAD` loads), and `PROVENANCE.md` (exact versions + load recipe — the source of truth).
- `src/views/vad-decision.mjs` — **new.** Pure decision logic (no DOM, no WASM): given speech segments, decide speech/no-speech. ES module: `export`s the functions AND assigns `window.SayTypeVad` for the browser. The only unit-tested unit.
- `src/views/vad-decision.test.mjs` — **new.** `node:test` unit tests for the above.
- `src/views/vad-gate.js` — **new, classic script.** `window.SayTypeVadGate.hasSpeech(blob)`: lazy-loads the two vendored scripts (ort then vad), decodes the blob to mono Float32, runs `NonRealTimeVAD`, and applies the pure decision. Browser-only; verified by smoke harness + manual recording.
- `src/views/input-prompt.html` — **modify.** Load `vad-decision.mjs` (module) and `vad-gate.js` (classic) so their globals exist before recording.
- `src/views/input-prompt.js` — **modify** (`processRecording`, after the `audioBlob` at line 775, before the `transcribe-audio` invoke at line 779): insert the fail-open gate; on no-speech, reuse the existing no-speech UI path and return.

Two parts. **Part 0 de-risks the runtime (the one real unknown: does onnxruntime-web run in this WKWebView?) and pins the exact asset list. Do not start Part 1 until Part 0 is green** — if Part 0 fails, stop and fall back to spec Route A (`ort`) or C (`webrtc-vad`) and re-plan.

---

## Part 0 — De-risk the runtime + vendor assets

### Task 0.1: Vendor the VAD assets ✅ DONE (committed `1e13fd1`)

Vendored via `npm pack @ricky0123/vad-web onnxruntime-web`. Inspected the packages' source to pin the recipe (recorded in `PROVENANCE.md`):

- **vad-web 0.0.30**, **onnxruntime-web 1.27.0** (latest 1.x satisfying vad-web's `^1.17.0`).
- `bundle.min.js` is a UMD that **externalizes ort as `window.ort`** (`e.vad=t(e.ort)`), so ort must load first.
- `NonRealTimeVAD` loads **`silero_vad_legacy.onnx`** (1536-sample / 96 ms frames), and `run(pcm, sampleRate)` **resamples internally**, yielding `{audio, start, end}` with **start/end in ms** (`(frameIndex*1536)/16`).

- [x] **Step 1–3:** packed, copied the lean set into `src/views/vendor/vad/`, wrote `PROVENANCE.md`.
- [x] **Step 4: Commit** — `feat(vad): vendor @ricky0123/vad-web + onnxruntime-web assets` (`1e13fd1`).

Vendored files: `ort.wasm.min.js`, `ort-wasm-simd-threaded.wasm` (13 MB), `ort-wasm-simd-threaded.mjs`, `bundle.min.js` (+`.LICENSE.txt`), `silero_vad_legacy.onnx` (1.8 MB), `PROVENANCE.md`. Total ~15 MB (dominated by the ort wasm runtime).

### Task 0.2: Smoke-test that onnxruntime-web runs in WKWebView

The gate. Proves the runtime loads in WebKit and `NonRealTimeVAD` returns sane segments. Done as a **Safari smoke** (Safari = same WebKit engine as the app's WKWebView), which avoids touching Rust / dev-build permissions; the Tauri asset-protocol nuance (wasm MIME) is exercised for free when integrating into the dev app in Task 1.3 (ort falls back to arraybuffer if streaming/MIME fails).

- [ ] **Step 1: Build a standalone smoke page** in a temp dir: copy the 6 vendored files + a `say`-generated `speech16k.wav`; an `index.html` that loads `ort.wasm.min.js` (→`window.ort`; set `ort.env.wasm.wasmPaths=""`, `numThreads=1`) then `bundle.min.js` (→`window.vad`), constructs `NonRealTimeVAD.new({ modelURL: "silero_vad_legacy.onnx" })`, and runs it over (a) 3 s synthetic silence, (b) the decoded speech wav. Display results.

- [ ] **Step 2: Serve + open in Safari**

```bash
python3 -m http.server 8348 --directory /tmp/vad-smoke   # background
open -a Safari http://127.0.0.1:8348/
```

- [ ] **Step 3: Verify (read the page)**

Expected: `window.ort`/`window.vad` = object; `NonRealTimeVAD ready`; **SILENCE → 0 segments, SPEECH → ≥1 segment** with sane ms ranges; verdict `✅ SMOKE OK`.

- **PASS** → onnxruntime-web runs in WebKit. Continue to Part 1.
- **FAIL** (e.g. `unsupported`, wasm instantiate error) → STOP. Capture the exact error; fall back to spec Route A (`ort`) or C (`webrtc-vad`); re-plan.

- [ ] **Step 4: Tear down** the temp page + server (it is throwaway; nothing to commit).

---

## Part 1 — Gate integration (only after Part 0 is green)

### Task 1.1: Pure decision logic (TDD)

**Files:**
- Create: `src/views/vad-decision.mjs`
- Test: `src/views/vad-decision.test.mjs`

**Interfaces:**
- Produces: `decideSpeech(segments, minSpeechMs) -> { speech: boolean, totalSpeechMs: number }` and `totalSpeechMs(segments) -> number`, where `segments` is `Array<{ start: number, end: number }>` in **milliseconds** (vad-web yields ms). Also assigns `window.SayTypeVad = { decideSpeech, totalSpeechMs }`.

- [ ] **Step 1: Write the failing test**

`src/views/vad-decision.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSpeech, totalSpeechMs } from "./vad-decision.mjs";

test("no segments -> no speech, zero duration", () => {
  assert.deepEqual(decideSpeech([], 250), { speech: false, totalSpeechMs: 0 });
});

test("totalSpeechMs sums positive durations and ignores invalid ones", () => {
  assert.equal(totalSpeechMs([{ start: 100, end: 400 }, { start: 1000, end: 1500 }]), 800);
  assert.equal(totalSpeechMs([{ start: 500, end: 500 }, { start: 900, end: 800 }]), 0);
});

test("below threshold -> no speech", () => {
  assert.deepEqual(decideSpeech([{ start: 0, end: 100 }], 250), { speech: false, totalSpeechMs: 100 });
});

test("at/above threshold -> speech", () => {
  assert.deepEqual(decideSpeech([{ start: 0, end: 250 }], 250), { speech: true, totalSpeechMs: 250 });
  assert.deepEqual(decideSpeech([{ start: 0, end: 200 }, { start: 300, end: 400 }], 250), { speech: true, totalSpeechMs: 300 });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
node --test src/views/vad-decision.test.mjs
```

Expected: FAIL — `Cannot find module './vad-decision.mjs'`.

- [ ] **Step 3: Write the minimal implementation**

`src/views/vad-decision.mjs`:

```js
// Pure VAD decision logic. No DOM, no WASM — unit-tested with node:test.
// A "segment" is { start, end } in milliseconds (vad-web NonRealTimeVAD yields ms).

export function totalSpeechMs(segments) {
  let total = 0;
  for (const s of segments) {
    const d = s.end - s.start;
    if (d > 0) total += d;
  }
  return total;
}

export function decideSpeech(segments, minSpeechMs) {
  const ms = totalSpeechMs(segments);
  return { speech: ms >= minSpeechMs, totalSpeechMs: ms };
}

if (typeof window !== "undefined") {
  window.SayTypeVad = { decideSpeech, totalSpeechMs };
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
node --test src/views/vad-decision.test.mjs
```

Expected: PASS — 4 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/views/vad-decision.mjs src/views/vad-decision.test.mjs
git commit -m "feat(vad): pure speech/no-speech decision logic + tests"
```

### Task 1.2: Browser gate module `vad-gate.js`

**Files:**
- Create: `src/views/vad-gate.js`
- Modify: `src/views/input-prompt.html`

**Interfaces:**
- Consumes: `window.ort` + `window.vad` (from the two vendored scripts), `window.SayTypeVad.decideSpeech` (Task 1.1).
- Produces: `window.SayTypeVadGate.hasSpeech(blob) -> Promise<{ speech: boolean, totalSpeechMs: number }>`. Lazy-loads ort then the vad bundle, constructs `NonRealTimeVAD` once (cached). Throws on load/decode/runtime failure (caller fails open).

- [ ] **Step 1: Write `src/views/vad-gate.js`**

```js
// Frontend VAD gate. Classic script. Exposes window.SayTypeVadGate.hasSpeech(blob).
// Lazy-loads the vendored onnxruntime-web + vad-web bundles on first use; decodes the
// recording to mono Float32 and lets NonRealTimeVAD resample to 16 kHz internally.
(function () {
  const VENDOR = "vendor/vad/";        // relative to input-prompt.html
  const MIN_SPEECH_MS = 250;           // start/end are milliseconds (vad-web source)
  let vadPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("failed to load " + src));
      document.head.appendChild(s);
    });
  }

  async function getVad() {
    if (!vadPromise) {
      vadPromise = (async () => {
        if (!window.ort) await loadScript(VENDOR + "ort.wasm.min.js");   // -> window.ort
        window.ort.env.wasm.wasmPaths = VENDOR;
        window.ort.env.wasm.numThreads = 1;                              // avoid SharedArrayBuffer/COOP-COEP
        if (!window.vad) await loadScript(VENDOR + "bundle.min.js");     // -> window.vad (externalizes ort)
        return window.vad.NonRealTimeVAD.new({ modelURL: VENDOR + "silero_vad_legacy.onnx" });
      })().catch((e) => { vadPromise = null; throw e; });                // allow retry on next recording
    }
    return vadPromise;
  }

  async function blobToMonoFloat32(blob) {
    const buf = await blob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    try {
      const audio = await ctx.decodeAudioData(buf);
      return { pcm: Float32Array.from(audio.getChannelData(0)), sampleRate: audio.sampleRate };
    } finally {
      try { ctx.close(); } catch {}
    }
  }

  async function hasSpeech(blob) {
    const vad = await getVad();
    const { pcm, sampleRate } = await blobToMonoFloat32(blob);
    const segments = [];
    for await (const seg of vad.run(pcm, sampleRate)) {
      segments.push({ start: seg.start, end: seg.end });
    }
    return window.SayTypeVad.decideSpeech(segments, MIN_SPEECH_MS);
  }

  window.SayTypeVadGate = { hasSpeech };
})();
```

- [ ] **Step 2: Load both new scripts from `input-prompt.html`**

Add, before the existing `input-prompt.js` is loaded/injected (so the globals exist first):

```html
<script type="module" src="vad-decision.mjs"></script>
<script src="vad-gate.js"></script>
```

- [ ] **Step 3: Verify in the dev app (manual)**

```bash
npm run dev
```

Minimum bar: `npm run dev` builds and loads with no console error from the two new scripts, and `window.SayTypeVadGate` is defined. Defer behavioral verification to Task 1.3.

- [ ] **Step 4: Commit**

```bash
git add src/views/vad-gate.js src/views/input-prompt.html
git commit -m "feat(vad): browser gate module (ort + NonRealTimeVAD)"
```

### Task 1.3: Wire the gate into the recording flow

**Files:**
- Modify: `src/views/input-prompt.js` (`processRecording`, after the `audioBlob` at line 775, before the `ipc.invoke("transcribe-audio", ...)` at line 779)

**Interfaces:**
- Consumes: `window.SayTypeVadGate.hasSpeech` (Task 1.2). Reuses existing `this.removePendingInsertion`, `t("inputPrompt.noSpeech")`, `this.scheduleHidePrompt`, `allowUi`, `sessionId`.

- [ ] **Step 1: Insert the fail-open gate**

In `src/views/input-prompt.js`, immediately after:

```js
      const audioBlob = new Blob(chunks, {
        type: mimeType || "audio/webm", // Use actual recording format
      });
```

insert:

```js
      // Neural VAD gate: if the clip contains no speech, skip transcription
      // entirely (no API call, no history) and reuse the no-speech UI. Fail
      // OPEN — any VAD error falls through to normal transcription so a VAD
      // bug can never drop a real recording.
      try {
        if (window.SayTypeVadGate) {
          const verdict = await window.SayTypeVadGate.hasSpeech(audioBlob);
          if (!verdict.speech) {
            this.removePendingInsertion(sessionId);
            if (allowUi) {
              this.statusText.textContent = t("inputPrompt.noSpeech");
              this.scheduleHidePrompt(2000);
            }
            return;
          }
        }
      } catch (vadError) {
        console.warn("VAD gate failed; proceeding to transcription:", vadError);
      }
```

(The `return` exits `processRecording`; the existing `finally` block still runs its cleanup. `transcribe-audio` is never called, so no history entry is written — the gate is purely additive to the backend.)

- [ ] **Step 2: Verify end-to-end in the dev app (manual)**

```bash
npm run dev
```

Run three recordings via the record hotkey:
1. **Silence / no speech** (hold the key, stay silent ~2s, release). Expected: the prompt shows the no-speech text and hides; **no** transcription request; nothing inserted; no new History entry.
2. **Real speech** (hold the key, say a sentence, release). Expected: transcribes and inserts exactly as before.
3. **Quiet / far** real speech (sit back from the mic). Expected: NOT dropped (the core worry from the spec).

Confirm no request fired for case 1 by tailing the log:

```bash
tail -f ~/Library/Logs/com.tao.saytype/SayType.log
```

- [ ] **Step 3: Commit**

```bash
git add src/views/input-prompt.js
git commit -m "feat(vad): gate transcription on speech presence (skip silent clips)"
```

---

## Self-Review

- **Spec coverage:** gate-only skip on no-speech (Task 1.3) ✓; frontend WASM Silero via vad-web, vendored, no bundler (Task 0.1, 1.2) ✓; decode → VAD with internal resample (Task 1.2) ✓; no-speech UI + no history (Task 1.3, reuses existing `inputPrompt.noSpeech`) ✓; backend untouched (no `src-tauri` changes) ✓; runtime de-risk first (Task 0.2 Safari smoke) ✓; tests = node:test for pure logic + manual for the rest ✓. Deferred per spec: silence-trimming (Phase 2), user-facing config/toggle — intentionally out of scope.
- **Placeholder scan:** Task 0.1's asset list is concrete (done + in PROVENANCE); `start`/`end` = ms is settled (vad-web source), not a Part-0 unknown. No "TBD"/"handle errors"/"similar to" placeholders.
- **Type consistency:** `hasSpeech(blob) -> {speech,totalSpeechMs}` and `decideSpeech(segments,minSpeechMs) -> {speech,totalSpeechMs}` match across Tasks 1.1/1.2/1.3; `segments` shape `{start,end}` is consistent; globals `window.SayTypeVad` (decision) and `window.SayTypeVadGate` (gate) are defined before use (loaded in `input-prompt.html` before `input-prompt.js`).

## Notes / risks carried from the spec

- **The one real risk is Task 0.2.** If onnxruntime-web can't instantiate in WebKit, fall back to Route A/C. `ort.env.wasm.numThreads = 1` pre-empts the SharedArrayBuffer/COOP-COEP requirement.
- `decodeAudioData` must decode the app's `audio/mp4`(AAC) blob in WKWebView — exercised in Task 1.3 Step 2.
- Tune `MIN_SPEECH_MS` only toward **keeping** real speech (the quiet/far case) if Task 1.3's manual pass shows false drops.
- App size grows ~15 MB (onnxruntime-web wasm runtime) — accepted.
