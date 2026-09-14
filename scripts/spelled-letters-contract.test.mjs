import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const commands = readFileSync(new URL("../src-tauri/src/commands.rs", import.meta.url), "utf8");

function between(start, end) {
  const offset = commands.indexOf(start);
  assert.ok(offset >= 0, `missing ${start}`);
  const limit = commands.indexOf(end, offset + start.length);
  assert.ok(limit > offset, `missing ${end}`);
  return commands.slice(offset, limit);
}

test("all complete dictations share final formatting before History and insertion", () => {
  const success = between("fn record_successful_transcription(", "pub fn record_assembled_transcription");
  assert.match(success, /let text = prepare_final_transcription\(raw\)/);
  assert.ok(success.indexOf("prepare_final_transcription(raw)") < success.indexOf("history::record_transcription"));
  assert.match(success, /history::record_transcription\(&text,/);

  const assembled = between("pub fn record_assembled_transcription(", "pub fn save_recovered_transcription");
  assert.match(assembled, /record_successful_transcription\(&app, &text,/);
  const live = between("pub async fn finish_live_transcription(", "pub async fn cancel_live_transcription");
  assert.match(live, /record_successful_transcription\(&app, &raw,/);
  const batch = between("pub async fn transcribe_audio(", "fn text_shape(");
  assert.match(batch, /Ok\(raw\) => Ok\(record_successful_transcription\(/);

  const retry = between("pub async fn retranscribe_pending(", "fn build_transcription_prompt(");
  assert.match(retry, /let text = prepare_final_transcription\(&raw\)/);
  assert.ok(retry.indexOf("prepare_final_transcription(&raw)") < retry.indexOf("history::finish_pending_transcription"));
});

test("final formatting reads the shared setting and leaves partial chunks unmerged", () => {
  const finalization = between("fn prepare_final_transcription(", "fn record_successful_transcription(");
  assert.match(finalization, /settings::read_config\(\)/);
  assert.match(finalization, /config\.merge_spelled_letters/);
  assert.match(finalization, /crate::scrub::finalize_transcription\(raw, merge_spelled_letters\)/);
  const chunks = between("fn scrub_transcription_with_chunk_diagnostics(", "pub async fn transcribe_audio(");
  assert.match(chunks, /crate::scrub::scrub_transcription\(raw\)/);
  assert.doesNotMatch(chunks, /finalize_transcription|prepare_final_transcription/);
});
