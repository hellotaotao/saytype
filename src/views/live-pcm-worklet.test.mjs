import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./live-pcm-worklet.js", import.meta.url), "utf8");

test("audio worklet converts float samples to little-endian PCM16", () => {
  let Processor = null;
  class AudioWorkletProcessor {
    constructor() {
      this.port = {
        postMessage(buffer) {
          this.buffer = buffer;
        },
      };
    }
  }
  vm.runInNewContext(source, {
    AudioWorkletProcessor,
    registerProcessor(name, implementation) {
      assert.equal(name, "saytype-pcm16-capture");
      Processor = implementation;
    },
    Int16Array,
    Math,
  });

  const processor = new Processor();
  const keepAlive = processor.process([[
    new Float32Array([-1, -0.5, 0, 0.5, 1]),
  ]]);

  assert.equal(keepAlive, true);
  assert.deepEqual(
    Array.from(new Int16Array(processor.port.buffer)),
    [-32768, -16384, 0, 16384, 32767]
  );
});
