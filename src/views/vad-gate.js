// Frontend VAD gate. Classic script. Exposes window.SayTypeVadGate.hasSpeech(blob).
// Lazy-loads the vendored onnxruntime-web + vad-web bundles on first use; decodes the
// recording to mono Float32 and lets NonRealTimeVAD resample to 16 kHz internally.
//
// Asset paths MUST be absolute URLs: onnxruntime-web loads its wasm glue via dynamic
// import(), which rejects bare/relative specifiers like "vendor/vad/" (verified failing
// then passing in the WebKit smoke). So derive an absolute base from document.baseURI.
(function () {
  const VENDOR = new URL("vendor/vad/", document.baseURI).href;
  const MIN_SPEECH_MS = 250; // start/end are milliseconds (vad-web NonRealTimeVAD source)
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
        if (!window.ort) await loadScript(VENDOR + "ort.wasm.min.js"); // -> window.ort
        window.ort.env.wasm.wasmPaths = VENDOR; // absolute URL (import() needs it)
        window.ort.env.wasm.numThreads = 1; // avoid SharedArrayBuffer / COOP-COEP
        if (!window.vad) await loadScript(VENDOR + "bundle.min.js"); // -> window.vad (externalizes ort)
        return window.vad.NonRealTimeVAD.new({ modelURL: VENDOR + "silero_vad_legacy.onnx" });
      })().catch((e) => {
        vadPromise = null; // allow retry on the next recording
        throw e;
      });
    }
    return vadPromise;
  }

  async function blobToMonoFloat32(blob) {
    const buf = await blob.arrayBuffer();
    const ctx = new AudioContext();
    try {
      const audio = await ctx.decodeAudioData(buf);
      return { pcm: Float32Array.from(audio.getChannelData(0)), sampleRate: audio.sampleRate };
    } finally {
      try { ctx.close(); } catch (_) {}
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
