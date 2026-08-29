// Pure chunking decisions for local (Qwen) long-audio dictation. No DOM, no
// audio APIs — unit-tested with node:test, mirroring vad-decision.mjs.
//
// Why chunk at all: Qwen3-ASR is encoder-decoder, so a whole clip is encoded
// before token 1 and ALL decoding happens after the user releases the hotkey
// (~7 s for 5 min, ~27 s for 13 min, and an outright failure past ~13 min when
// audio tokens overflow the ctx cap). Cutting during recording moves every
// chunk but the last off the post-release tail.
//
// Why these numbers: the resident llama worker (local_asr.rs) is only reused
// when `cached.ctx_size == ctx_size` EXACTLY, and `ctx_size_for_wav` is
// `seconds * 20 + 512` clamped to [2048, 16384]. Anything at or under 76.8 s
// lands on the 2048 floor, so capping chunks below that pins every chunk to the
// same ctx and one warm worker serves the whole dictation. Chunks longer than
// that would each compute a different ctx, killing and respawning the ~1.3 GiB
// worker per chunk — slower than not chunking at all.
export const SOFT_TARGET_S = 55;
export const HARD_MAX_S = 75;

// A frame this far below the chunk's own speech level counts as a pause. It is
// a RATIO, not an absolute level, so the same decisions hold across mic gains
// (see the scale-invariance test). The threshold only decides whether a cut
// lands early; when no frame qualifies, the forced cut still picks the quietest
// frame available, so a mediocre threshold degrades gracefully.
export const QUIET_RATIO = 0.03;

// RMS of one worklet block. Silence is 0, a full-scale square wave is 1.
export function frameRms(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export function createChunkState() {
  // `loudRef` is a high-water RMS for the CURRENT chunk: the quiet threshold is
  // relative to how loud this speaker actually is, and it resets with each cut.
  return { frames: [], samples: 0, loudRef: 0 };
}

// Record one captured block. `length` is its sample count; `at` is the block's
// starting offset within the current chunk, which is what a cut is expressed in.
export function pushFrame(state, rms, length) {
  state.frames.push({ rms, length, at: state.samples });
  state.samples += length;
  if (rms > state.loudRef) state.loudRef = rms;
  return state;
}

// null = keep accumulating. Otherwise { cutAtSample, reason } where cutAtSample
// is an offset into the current chunk: samples before it close the chunk, the
// rest carries over as the head of the next one.
export function decideCut(state, sampleRate, opts = {}) {
  const softTarget = (opts.softTargetS ?? SOFT_TARGET_S) * sampleRate;
  const hardMax = (opts.hardMaxS ?? HARD_MAX_S) * sampleRate;
  if (state.samples < softTarget) return null;

  // Past the soft target, the first real pause wins — cutting on silence is the
  // whole point, and waiting for a "better" pause only grows the tail.
  const quiet = state.loudRef * (opts.quietRatio ?? QUIET_RATIO);
  const last = state.frames[state.frames.length - 1];
  if (last && last.rms <= quiet) {
    return { cutAtSample: state.samples, reason: "silence" };
  }

  // No pause in the whole search window (a fast talker, or steady background
  // noise keeping every frame above the threshold): cut at the quietest frame
  // in [softTarget, now] rather than blindly at the current instant, so the
  // seam still lands at the least damaging point available.
  if (state.samples >= hardMax) {
    let best = null;
    for (const frame of state.frames) {
      if (frame.at < softTarget) continue;
      if (!best || frame.rms < best.rms) best = frame;
    }
    const cutAtSample = best ? best.at + best.length : state.samples;
    return { cutAtSample, reason: "forced" };
  }

  return null;
}

// Carry the post-cut remainder into a fresh chunk. Frames are re-based to the
// new chunk's origin and loudRef is recomputed from what actually carried over,
// so a loud first chunk cannot skew the next chunk's quiet threshold.
//
// A cut landing inside a frame keeps that frame's remainder rather than dropping
// it: the caller splits the captured PCM at the exact sample, so discarding the
// whole frame would leave this state short of the audio it describes. decideCut
// only ever returns frame boundaries today, but the two must not silently
// disagree if that ever stops being true.
export function stateAfterCut(state, cutAtSample) {
  const next = createChunkState();
  for (const frame of state.frames) {
    const end = frame.at + frame.length;
    if (end <= cutAtSample) continue;
    pushFrame(next, frame.rms, end - Math.max(frame.at, cutAtSample));
  }
  return next;
}

// CJK ideographs plus the full-width punctuation Qwen emits for Chinese.
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;

// Concatenate the per-chunk transcripts in capture order. Chunks are decoded
// independently (mtmd ignores `-p`, so there is no cross-chunk context) and Qwen
// punctuates each one on its own, so the seam only needs a separator: a space
// between latin words, nothing when either side is CJK — a stray space inside
// Chinese text is the visible error, and every seam falls at a pause anyway.
// Empty chunks (silence, or one that failed to decode) drop out, leaving a gap
// rather than losing the whole dictation.
export function joinChunkTexts(texts) {
  let out = "";
  for (const raw of texts || []) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) continue;
    if (!out) {
      out = text;
      continue;
    }
    const left = out[out.length - 1];
    const right = text[0];
    out += CJK.test(left) || CJK.test(right) ? text : ` ${text}`;
  }
  return out;
}

if (typeof window !== "undefined") {
  window.SayTypeChunk = {
    SOFT_TARGET_S,
    HARD_MAX_S,
    frameRms,
    createChunkState,
    pushFrame,
    decideCut,
    stateAfterCut,
    joinChunkTexts,
  };
}
