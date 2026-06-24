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
