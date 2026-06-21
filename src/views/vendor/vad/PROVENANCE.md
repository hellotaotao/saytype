# Vendored VAD assets — provenance

Vendored 2026-06-22 for the neural-VAD gate (Route B: frontend WASM Silero).
Obtained via `npm pack` — these are static files served from `src/views/vendor/vad/`,
no bundler, no app-level npm runtime dependency.

## Versions
- `@ricky0123/vad-web` @ **0.0.30** (declares `onnxruntime-web: ^1.17.0`)
- `onnxruntime-web` @ **1.27.0** (latest 1.x satisfying `^1.17.0`, what a fresh install resolves)

## Files & roles
| File | Role |
|---|---|
| `ort.wasm.min.js` | onnxruntime-web CPU/wasm build (UMD; sets `window.ort`). **Load FIRST.** |
| `ort-wasm-simd-threaded.wasm` | ort wasm runtime (~13 MB). Loaded at runtime from `ort.env.wasm.wasmPaths`. |
| `ort-wasm-simd-threaded.mjs` | ort wasm JS glue for the above. |
| `bundle.min.js` | `@ricky0123/vad-web` UMD build (sets `window.vad`; externalizes ort as `window.ort`). **Load SECOND.** |
| `bundle.min.js.LICENSE.txt` | license banner. |
| `silero_vad_legacy.onnx` | Silero model `NonRealTimeVAD` loads by default (~1.8 MB). |

## Load order & config (see `src/views/vad-gate.js`)
1. `<script ort.wasm.min.js>` → `window.ort`
2. `window.ort.env.wasm.wasmPaths = "vendor/vad/"; window.ort.env.wasm.numThreads = 1;`
   (`numThreads = 1` avoids the SharedArrayBuffer / COOP-COEP requirement under WKWebView's asset protocol)
3. `<script bundle.min.js>` → `window.vad`
4. `await window.vad.NonRealTimeVAD.new({ modelURL: "vendor/vad/silero_vad_legacy.onnx" })`
   `run(float32, nativeSampleRate)` → async generator of `{ audio, start, end }`, **start/end in milliseconds**
   (verified in source: `(frameIndex * 1536) / 16`).

## Notes
- `NonRealTimeVAD` uses **Silero legacy** (1536-sample / 96 ms frames), not v5 — legacy is the model the
  offline API loads; fine for a speech-presence gate.
- Total ~15 MB, dominated by the 13 MB ort wasm runtime — inherent to onnxruntime-web; no leaner official
  build runs Silero. Still far below an Electron/Chromium bundle.

## Updating
Re-run `npm pack @ricky0123/vad-web onnxruntime-web`, re-copy the files above, bump the versions here.
