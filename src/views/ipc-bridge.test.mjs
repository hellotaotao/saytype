import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./ipc-bridge.js", import.meta.url), "utf8");

function loadBridge() {
  const calls = [];
  const window = {
    __TAURI__: {
      core: { invoke: async (...args) => { calls.push(args); return "saved-id"; } },
      event: { listen: async () => () => {} },
    },
  };
  vm.runInNewContext(source, { window });
  return { bridge: window.__SAYTYPE_IPC__, calls };
}

test("recovered text uses the strict recovery payload command", async () => {
  const { bridge, calls } = loadBridge();
  const recovery = { id: "recovery-100-1", text: "kept words", kind: "incomplete" };
  assert.equal(await bridge.invoke("save-recovered-transcription", recovery), "saved-id");
  assert.equal(calls[0][0], "save_recovered_transcription");
  assert.equal(calls[0][1].recovery, recovery);
  assert.deepEqual(Object.keys(calls[0][1]), ["recovery"]);
});

test("pending audio carries an optional stable recovery id without changing the raw body", async () => {
  const { bridge, calls } = loadBridge();
  const audio = new Uint8Array([1, 2, 3]);
  await bridge.invoke("save-pending-transcription", audio, "audio/wav", "pending-100-1");
  assert.equal(calls[0][0], "save_pending_transcription");
  assert.equal(calls[0][1], audio);
  assert.equal(calls[0][2].headers["mime-type"], "audio/wav");
  assert.equal(calls[0][2].headers["recovery-id"], "pending-100-1");
});

test("legacy two-argument pending audio does not send a recovery id header", async () => {
  const { bridge, calls } = loadBridge();
  const audio = new Uint8Array([1]);
  await bridge.invoke("save-pending-transcription", audio, "audio/mp4");
  assert.equal(calls[0][1], audio);
  assert.equal(calls[0][2].headers["mime-type"], "audio/mp4");
  assert.equal(Object.hasOwn(calls[0][2].headers, "recovery-id"), false);
});
