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
