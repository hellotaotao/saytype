import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/views/settings.js", import.meta.url), "utf8");
const saveSource = source.slice(source.indexOf("async function saveSettings()"), source.indexOf("async function initializeSettingsPage()"));

for (const [choice, model] of [["local-qwen", "qwen3-asr-0.6b-q8_0"], ["local-qwen-large", "qwen3-asr-1.7b-q8_0"], ["local-nemotron", "nemotron-3.5-asr-streaming-0.6b-q8_0"]]) {
for (const state of ["absent", "partial", "downloading", "ready"]) {
  test(`model readiness (${choice}: ${state}) inspection never activates during ordinary autosave`, async () => {
    const saved = [];
    const alerts = [];
    const fields = {
      providerSelect: { value: choice },
      languageSelect: { value: "zh" },
      themeSelect: { value: "midnight" },
      modelSelect: { value: "gpt-transcribe" },
      apiKeyOpenAI: { value: "test-key" },
    };
    const context = vm.createContext({
      console,
      initializeDependencies: async () => {},
      document: { getElementById: (id) => fields[id] },
      localModelForProvider: (value) => value === choice ? model : null,
      localModelState: "absent",
      currentSettings: { provider: "openai", model: "gpt-transcribe", microphone: "default" },
      ipc: { invoke: async (command, payload) => {
        if (command === "get-local-model-status") return { state };
        if (command === "save-settings") saved.push(payload);
      } },
      normalizeThemePref: (value) => value,
      translate: (key) => key,
      showSaveStatus() {},
      alert: (message) => alerts.push(message),
      providerForSettings: (settings) => settings.provider,
      setSelectValue: (element, value) => { element.value = value; },
      updateModelOptions() {},
      toggleProviderFields() {},
      renderEngineCards() {},
      renderLocalModelPanel() {},
      inspectedLocalModel: null,
    });
    await vm.runInContext(saveSource + "; saveSettings()", context);
    assert.equal(alerts.length, 0);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].provider, "openai");
    assert.equal(saved[0].model, "gpt-transcribe");
    assert.equal(saved[0].uiTheme, "midnight");
    assert.equal(saved[0].language, "zh");
    assert.equal(saved[0].apiKeyOpenAI, "test-key");
    assert.equal(fields.providerSelect.value, choice);
  });
}

}
