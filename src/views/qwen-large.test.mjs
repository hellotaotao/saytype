import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const large = "qwen3-asr-1.7b-q8_0";
function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}", start) + 2;
  return source.slice(start, end);
}
test("large Qwen settings mapping round-trips independently of default Qwen", () => {
  const source = read("settings.js");
  const constants = source.match(/^const (?:QWEN\w*|NEMOTRON\w*|LOCAL_\w*) = .*;$/gm).join("\n");
  const context = vm.createContext({});
  vm.runInContext(constants + "\n" + functionSource(source, "localModelForProvider") + "\n" + functionSource(source, "providerForSettings"), context);
  assert.equal(context.localModelForProvider("local-qwen-large"), large);
  assert.equal(context.providerForSettings({ provider: "local", model: large }), "local-qwen-large");
  assert.equal(context.localModelForProvider("local-qwen"), "qwen3-asr-0.6b-q8_0");
});
test("main selection preserves large Qwen rather than normalizing to default", () => {
  const source = read("main.js");
  const constants = source.match(/^const (?:QWEN\w*|NEMOTRON\w*) = .*;$/gm).join("\n");
  const context = vm.createContext({ cachedSettings: { provider: "local", model: large } });
  vm.runInContext(constants + "\n" + functionSource(source, "normalizeLocalModel") + "\n" + functionSource(source, "selectedEngineValue"), context);
  assert.equal(context.normalizeLocalModel(large), large);
  assert.equal(context.selectedEngineValue(), "local-qwen-large");
});
test("large Qwen is a size inside the Qwen engine, not an engine row of its own", () => {
  assert.match(read("main.html"), /value="local-qwen-large"/);
  assert.match(read("settings.js"), /value: LOCAL_QWEN_LARGE_PROVIDER, local: true, icon: "memory", group: "size"/);
  assert.match(read("input-prompt.js"), /\[QWEN_LARGE_LOCAL_MODEL_ID\]: "Qwen3 1.7B · Local"/);
});


test("large Qwen download requests status and assets for the inspected model", async () => {
  const source = read("settings.js");
  const calls = [];
  const context = vm.createContext({
    localModelState: "absent", localModelDownloadStartedHere: "",
    inspectedLocalModel: large,
    document: { getElementById: () => ({ value: "openai", options: [] }) },
    localModelForProvider: () => "",
    localModelStatuses: new Map(), localModelStatusRequests: new Map(),
    ipc: { invoke: async (command, model) => { calls.push([command, model]); return { state: "absent" }; } },
    renderLocalModelPanel() {}, renderEngineCards() {}, console,
  });
  const selected = functionSource(source, "selectedLocalModel");
  const refresh = "async " + functionSource(source, "refreshLocalModelStatus");
  const action = "async " + functionSource(source, "handleLocalModelAction");
  await vm.runInContext(selected + "\n" + refresh + "\n" + action + "\nhandleLocalModelAction()", context);
  assert.ok(calls.some(([command, model]) => command === "get-local-model-status" && model === large));
  assert.ok(calls.some(([command, model]) => command === "download-local-model" && model === large));
});

test("the 1.7B suggestion follows this machine's measured 0.6B speed", () => {
  const source = read("settings.js");
  const constants = source.match(/^const (?:QWEN\w*|NEMOTRON\w*|LOCAL_\w*) = .*;$/gm).join("\n");
  const context = vm.createContext({});
  vm.runInContext(constants + "\n" + functionSource(source, "qwenWaitEstimate") + "\n" + functionSource(source, "qwenSizeAdvice"), context);
  const small = "qwen3-asr-0.6b-q8_0";
  const speed = (smallRtf, smallSamples, largeRtf, largeSamples) => ({
    ...(smallRtf === null ? {} : { [small]: { samples: smallSamples, medianRtf: smallRtf } }),
    ...(largeRtf === null ? {} : { [large]: { samples: largeSamples, medianRtf: largeRtf } }),
  });
  // An M4: 0.6B at 0.031 s per second of audio puts 1.7B near 1.0 s for 15 s.
  assert.equal(context.qwenSizeAdvice(speed(0.031, 24, null, 0), small, "absent"), "suggest");
  assert.ok(Math.abs(context.qwenWaitEstimate(speed(0.031, 24, null, 0), large) - 1.023) < 0.001);
  // Too few dictations yet, already downloaded, or too slow: no suggestion.
  assert.equal(context.qwenSizeAdvice(speed(0.031, 9, null, 0), small, "absent"), "");
  assert.equal(context.qwenSizeAdvice(speed(0.031, 24, null, 0), small, "ready"), "");
  assert.equal(context.qwenSizeAdvice(speed(0.031, 24, null, 0), small, "downloading"), "");
  assert.equal(context.qwenSizeAdvice(speed(0.4, 24, null, 0), small, "absent"), "");
  assert.equal(context.qwenWaitEstimate(speed(0.031, 3, null, 0), large), null);
  // 1.7B measured slow on this machine: suggest going back.
  assert.equal(context.qwenSizeAdvice(speed(null, 0, 0.9, 6), large, "ready"), "slow");
  assert.equal(context.qwenSizeAdvice(speed(null, 0, 0.07, 6), large, "ready"), "");
  assert.equal(context.qwenSizeAdvice(speed(null, 0, 0.9, 4), large, "ready"), "");
  // Other engines in use get no Qwen advice.
  assert.equal(context.qwenSizeAdvice(speed(0.031, 24, null, 0), "", "absent"), "");
});

test("a missing size downloads and takes over only while Qwen is in use", async () => {
  const source = read("settings.js");
  const run = async (activeModel, state) => {
    const calls = [];
    const context = vm.createContext({
      engineSwitchPending: false,
      currentSettings: { provider: activeModel ? "local" : "openai", model: activeModel || "gpt-transcribe" },
      localModelStatuses: new Map([[large, { state }], ["qwen3-asr-0.6b-q8_0", { state: "ready" }]]),
      inspectEngine: (choice) => calls.push(["inspect", choice]),
      activateEngine: async (target) => calls.push(["activate", target.model]),
      handleLocalModelAction: async (options) => calls.push(["download", options.switchWhenReady]),
    });
    const constants = source.match(/^const (?:QWEN\w*|NEMOTRON\w*|LOCAL_\w*) = .*;$/gm).join("\n");
    vm.runInContext(constants + "\n" + functionSource(source, "isQwenChoice") + "\n" + functionSource(source, "localModelForProvider")
      + "\n" + functionSource(source, "providerForSettings") + "\nasync " + functionSource(source, "chooseQwenSize"), context);
    await context.chooseQwenSize("local-qwen-large");
    return calls;
  };
  assert.deepEqual(await run("qwen3-asr-0.6b-q8_0", "absent"), [["inspect", "local-qwen-large"], ["download", true]]);
  assert.deepEqual(await run("", "absent"), [["inspect", "local-qwen-large"], ["download", false]]);
  assert.deepEqual(await run("qwen3-asr-0.6b-q8_0", "ready"), [["inspect", "local-qwen-large"], ["activate", large]]);
  assert.deepEqual(await run("", "ready"), [["inspect", "local-qwen-large"]], "an inactive engine's size waits for the row click");
  assert.deepEqual(await run("qwen3-asr-0.6b-q8_0", "downloading"), [["inspect", "local-qwen-large"]]);
});
