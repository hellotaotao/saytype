import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideSpeech,
  totalSpeechMs,
  trimRangeMs,
  shouldTrim,
  encodeWavPcm16,
} from "./vad-decision.mjs";

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

// ---- trimRangeMs ----

const PAD = { padStartMs: 300, padEndMs: 450 };

test("trimRangeMs: no segments -> null", () => {
  assert.equal(trimRangeMs([], 5000, PAD), null);
});

test("trimRangeMs: pads around first start and last end", () => {
  // speech 1000-2000ms inside a 10s clip -> keep 700-2450ms
  assert.deepEqual(trimRangeMs([{ start: 1000, end: 2000 }], 10000, PAD), {
    startMs: 700,
    endMs: 2450,
  });
});

test("trimRangeMs: clamps padding to the clip bounds", () => {
  // speech starts 100ms in, ends 200ms before the clip ends
  assert.deepEqual(trimRangeMs([{ start: 100, end: 4800 }], 5000, PAD), {
    startMs: 0,
    endMs: 5000,
  });
});

test("trimRangeMs: spans first start to last end across segments, any order", () => {
  const segments = [
    { start: 3000, end: 3500 },
    { start: 1000, end: 1800 },
  ];
  assert.deepEqual(trimRangeMs(segments, 10000, PAD), { startMs: 700, endMs: 3950 });
});

// ---- shouldTrim ----

test("shouldTrim: null range -> false", () => {
  assert.equal(shouldTrim(null, 10000, 500), false);
});

test("shouldTrim: savings below threshold -> false (skip pointless re-encode)", () => {
  assert.equal(shouldTrim({ startMs: 0, endMs: 9700 }, 10000, 500), false);
});

test("shouldTrim: savings at/above threshold -> true", () => {
  assert.equal(shouldTrim({ startMs: 0, endMs: 9500 }, 10000, 500), true);
  assert.equal(shouldTrim({ startMs: 4000, endMs: 6000 }, 10000, 500), true);
});

// ---- encodeWavPcm16 ----

test("encodeWavPcm16: 44-byte RIFF/WAVE header + 2 bytes per sample", () => {
  const wav = encodeWavPcm16(new Float32Array(160), 16000);
  assert.equal(wav.length, 44 + 320);
  const ascii = (off, len) => String.fromCharCode(...wav.subarray(off, off + len));
  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(ascii(12, 4), "fmt ");
  assert.equal(ascii(36, 4), "data");
});

test("encodeWavPcm16: header fields — mono 16-bit at the given rate", () => {
  const wav = encodeWavPcm16(new Float32Array(10), 16000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint32(4, true), 36 + 20); // RIFF size
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), 16000); // sample rate
  assert.equal(view.getUint32(28, true), 32000); // byte rate
  assert.equal(view.getUint16(32, true), 2); // block align
  assert.equal(view.getUint16(34, true), 16); // bits per sample
  assert.equal(view.getUint32(40, true), 20); // data size
});

test("encodeWavPcm16: samples scale and clip to int16 little-endian", () => {
  const wav = encodeWavPcm16(new Float32Array([0, 0.5, 1, -1, 2, -2]), 16000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 16384); // 0.5 * 32768, rounded
  assert.equal(view.getInt16(48, true), 32767); // +1 clips to int16 max
  assert.equal(view.getInt16(50, true), -32768);
  assert.equal(view.getInt16(52, true), 32767); // overdrive clips
  assert.equal(view.getInt16(54, true), -32768);
});
