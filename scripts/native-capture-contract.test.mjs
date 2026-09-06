import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const frontend = readFileSync(new URL("../src/views/input-prompt.js", import.meta.url), "utf8");
const backend = readFileSync(new URL("../src-tauri/src/native_capture.rs", import.meta.url), "utf8");

test("frontend native stop deadline includes backend deadline and IPC margin", () => {
  const frontendMs = Number(frontend.match(/const NATIVE_CAPTURE_STOP_TIMEOUT_MS = (\d+);/)?.[1]);
  const backendMs = Number(backend.match(/pub const STOP_TIMEOUT_MS: u64 = ([\d_]+);/)?.[1]?.replaceAll("_", ""));
  assert.ok(Number.isFinite(frontendMs) && Number.isFinite(backendMs));
  assert.ok(backendMs > 0);
  assert.ok(frontendMs >= backendMs + 1000, "reserve at least one second for IPC and channel drainage");
  assert.match(backend, /stop_capture_with_timeout\(state, session_id, std::time::Duration::from_millis\(STOP_TIMEOUT_MS\)\)/);
});

test("native error codes are shared across Rust serialization and the renderer", () => {
  const block = frontend.match(/const NATIVE_CAPTURE_ERROR_CODES = new Set\(\[([\s\S]*?)\]\);/)?.[1];
  assert.ok(block);
  const frontendCodes = [...block.matchAll(/"(NATIVE_CAPTURE_[A-Z_]+)"/g)].map((match) => match[1]).sort();
  const backendCodes = [...backend.matchAll(/#\[serde\(rename = "(NATIVE_CAPTURE_[A-Z_]+)"\)\]/g)].map((match) => match[1]).sort();
  assert.equal(frontendCodes.length, 5);
  assert.deepEqual(frontendCodes, backendCodes);
});
