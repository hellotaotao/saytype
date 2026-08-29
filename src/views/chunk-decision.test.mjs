import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SOFT_TARGET_S,
  HARD_MAX_S,
  frameRms,
  createChunkState,
  pushFrame,
  decideCut,
  stateAfterCut,
  joinChunkTexts,
} from "./chunk-decision.mjs";

const RATE = 48000;
const FRAME = 4800; // 0.1 s blocks; decideCut is frame-size agnostic

// Feed `seconds` of audio at a constant level, returning the first cut decision
// (and when it happened). Level is the per-frame RMS.
function feed(state, seconds, level, opts) {
  const frames = Math.round((seconds * RATE) / FRAME);
  for (let i = 0; i < frames; i++) {
    pushFrame(state, level, FRAME);
    const cut = decideCut(state, RATE, opts);
    if (cut) return cut;
  }
  return null;
}

// ---- frameRms ----

test("frameRms: silence is 0, a constant level is that level", () => {
  assert.equal(frameRms(new Float32Array(64)), 0);
  assert.equal(frameRms(null), 0);
  assert.equal(frameRms(new Float32Array(0)), 0);
  const half = new Float32Array(64).fill(0.5);
  assert.ok(Math.abs(frameRms(half) - 0.5) < 1e-9);
  const alternating = Float32Array.from({ length: 64 }, (_, i) => (i % 2 ? -0.5 : 0.5));
  assert.ok(Math.abs(frameRms(alternating) - 0.5) < 1e-9);
});

// ---- no cut before the soft target ----

test("a dictation shorter than the soft target is never cut", () => {
  const state = createChunkState();
  assert.equal(feed(state, SOFT_TARGET_S - 5, 0.1), null);
});

test("silence before the soft target does not trigger a cut", () => {
  const state = createChunkState();
  feed(state, 10, 0.1); // establish a speech level
  assert.equal(feed(state, 20, 0.0), null, "a 20 s pause at 10 s in must not cut");
  assert.ok(state.samples < SOFT_TARGET_S * RATE);
});

// ---- cutting on silence ----

test("past the soft target, the first pause cuts", () => {
  const state = createChunkState();
  assert.equal(feed(state, SOFT_TARGET_S + 1, 0.1), null);
  pushFrame(state, 0.0, FRAME);
  const cut = decideCut(state, RATE);
  assert.ok(cut, "a pause after the soft target must cut");
  assert.equal(cut.reason, "silence");
  assert.equal(cut.cutAtSample, state.samples, "a silence cut lands at the current instant");
});

// ---- forced cut ----

test("with no pause at all, the hard max forces a cut inside the search window", () => {
  const state = createChunkState();
  const cut = feed(state, HARD_MAX_S + 5, 0.1);
  assert.ok(cut, "the hard max must force a cut");
  assert.equal(cut.reason, "forced");
  assert.ok(
    cut.cutAtSample >= SOFT_TARGET_S * RATE,
    "a forced cut must not reach back before the soft target"
  );
  assert.ok(cut.cutAtSample <= (HARD_MAX_S + 1) * RATE);
});

test("a forced cut picks the quietest frame in the window, not the latest one", () => {
  const state = createChunkState();
  // Loud through the soft target, one relatively quiet dip after it (still
  // above the pause threshold), then loud again to the hard max.
  feed(state, SOFT_TARGET_S + 2, 0.2);
  const dipAt = state.samples;
  pushFrame(state, 0.05, FRAME); // quietest, but 0.05 > 0.2 * 0.03 so not a "pause"
  assert.equal(decideCut(state, RATE), null, "the dip is not quiet enough to be a pause");
  const cut = feed(state, HARD_MAX_S, 0.2);
  assert.ok(cut);
  assert.equal(cut.reason, "forced");
  assert.equal(cut.cutAtSample, dipAt + FRAME, "the cut lands just after the quietest frame");
});

// ---- scale invariance ----

test("decisions are scale-invariant: a quiet mic cuts exactly like a loud one", () => {
  const run = (gain) => {
    const state = createChunkState();
    feed(state, SOFT_TARGET_S + 1, 0.2 * gain);
    pushFrame(state, 0.004 * gain, FRAME); // a real pause: 2% of the speech level
    return decideCut(state, RATE);
  };
  const loud = run(1);
  const quiet = run(0.01);
  assert.ok(loud && quiet, "both gains must reach a cut");
  assert.deepEqual(quiet, loud);
});

// ---- carrying the remainder over ----

test("stateAfterCut re-bases the remainder and recomputes the quiet reference", () => {
  const state = createChunkState();
  feed(state, SOFT_TARGET_S + 1, 0.5); // a loud first chunk
  const cutAtSample = state.samples;
  pushFrame(state, 0.01, FRAME); // carried over: quiet tail
  pushFrame(state, 0.02, FRAME);

  const next = stateAfterCut(state, cutAtSample);
  assert.equal(next.samples, FRAME * 2, "only post-cut audio carries over");
  assert.equal(next.frames[0].at, 0, "the remainder is re-based to the new origin");
  assert.equal(next.loudRef, 0.02, "loudRef comes from the remainder, not the loud first chunk");
});

test("a cut inside a frame keeps that frame's remainder, matching the PCM split", () => {
  const state = createChunkState();
  pushFrame(state, 0.2, 100);
  pushFrame(state, 0.1, 100);
  pushFrame(state, 0.3, 100);

  const next = stateAfterCut(state, 150); // halfway through the second frame
  assert.equal(next.samples, 150, "frame bookkeeping must match the 150 samples of audio kept");
  assert.equal(next.frames.length, 2);
  assert.equal(next.frames[0].length, 50, "the partial frame keeps only its remainder");
  assert.equal(next.frames[0].at, 0);
  assert.equal(next.frames[1].length, 100);
});

test("an exact cut leaves nothing behind", () => {
  const state = createChunkState();
  feed(state, SOFT_TARGET_S + 1, 0.1);
  const next = stateAfterCut(state, state.samples);
  assert.equal(next.samples, 0);
  assert.deepEqual(next.frames, []);
});

// ---- the constraint the numbers exist to satisfy ----

test("a full-length chunk still pins the resident worker's ctx to the 2048 floor", () => {
  // Mirrors ctx_size_for_wav in local_asr.rs: the resident llama worker is only
  // reused when ctx matches EXACTLY, so every chunk must land on the floor.
  const ctxSizeForWav = (wavLen) => {
    const seconds = Math.max(0, wavLen - 44) / 32000;
    const tokens = Math.floor(seconds * 20) + 512;
    return Math.min(16384, Math.max(2048, tokens));
  };
  const wavBytesFor = (seconds) => 44 + Math.round(seconds * 16000) * 2;

  assert.equal(ctxSizeForWav(wavBytesFor(HARD_MAX_S)), 2048, "the hard max must stay on the floor");
  assert.equal(ctxSizeForWav(wavBytesFor(SOFT_TARGET_S)), 2048);
  assert.ok(HARD_MAX_S < 76.8, "76.8 s is where ctx leaves the floor");
  // Guard the direction of the failure: a chunk cap above the floor boundary
  // would give each chunk its own ctx and respawn the worker every time.
  assert.ok(ctxSizeForWav(wavBytesFor(90)) > 2048, "the old 90 s cap would have broken reuse");
});

// ---- joining chunk transcripts ----

test("latin chunks join with a single space", () => {
  assert.equal(
    joinChunkTexts(["the first part.", "and the second part."]),
    "the first part. and the second part."
  );
});

test("CJK seams join without a space", () => {
  assert.equal(joinChunkTexts(["今天天气不错。", "我们出去走走吧。"]), "今天天气不错。我们出去走走吧。");
  assert.equal(joinChunkTexts(["这是一段话", "继续说下去"]), "这是一段话继续说下去");
});

test("a mixed seam takes the CJK rule — no stray space inside Chinese text", () => {
  assert.equal(joinChunkTexts(["用的是 Claude", "写的代码。"]), "用的是 Claude写的代码。");
  assert.equal(joinChunkTexts(["I used", "千问来转写。"]), "I used千问来转写。");
});

test("empty and failed chunks leave a gap instead of losing everything", () => {
  assert.equal(joinChunkTexts(["first", "", "third"]), "first third");
  assert.equal(joinChunkTexts([undefined, "only survivor", null]), "only survivor");
  assert.equal(joinChunkTexts([]), "");
  assert.equal(joinChunkTexts(null), "");
});

test("chunk text is trimmed before joining", () => {
  assert.equal(joinChunkTexts(["  padded  ", "  words  "]), "padded words");
});

test("a single chunk is returned unchanged — short dictation has no seam", () => {
  assert.equal(joinChunkTexts(["just one chunk."]), "just one chunk.");
});
