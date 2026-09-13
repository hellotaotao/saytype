import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../src/views/settings.js", import.meta.url), "utf8");
const settingsCode = source.slice(source.indexOf("async function saveSettings()"), source.indexOf("async function initializeSettingsPage()"));
function harness() {
  let database = { provider: "local", model: "large", uiTheme: "elegant" };
  let release;
  let delayFirstSave = true;
  let failSnapshot = false;
  const calls = [], cancelled = [];
  const context = vm.createContext({
    currentSettings: { ...database }, commitTimer: null, settingsInitialized: true,
    window: { clearTimeout: id => cancelled.push(id) },
    initializeDependencies: async () => {},
    document: { getElementById: id => id === "themeSelect" ? { value: "midnight" } : null },
    normalizeThemePref: value => value, translate: key => key,
    toggleProviderFields() {}, providerForSettings: settings => settings.provider,
    renderEngineCards() {}, renderEngineActivation() {}, showSaveStatus() {}, console: { error() {} },
    engineActivationMessage: "", engineTargetLabel: target => target.model,
    ipc: { invoke: async (command, payload) => {
      calls.push([command, payload?.model || payload]);
      if (command === "get-local-model-status") return { state: "ready" };
      if (command === "save-settings") {
        database = { ...database, ...payload };
        if (delayFirstSave) { delayFirstSave = false; await new Promise(resolve => { release = resolve; }); }
        return true;
      }
      if (command === "get-settings") {
        if (failSnapshot) throw new Error("snapshot unavailable");
        return { ...database };
      }
      if (command === "set-local-model") { database.model = payload; return true; }
    } },
  });
  vm.runInContext(settingsCode, context);
  return { context, calls, cancelled, get database() { return database; }, get release() { return release; },
    noDelay() { delayFirstSave = false; }, failSnapshot(value) { failSnapshot = value; } };
}
async function until(predicate) { for (let i = 0; i < 30 && !predicate(); i++) await Promise.resolve(); assert.ok(predicate()); }
test("Home switch waits for queued Settings saves and later autosave preserves actual Home model", async () => {
  const h = harness();
  const first = h.context.saveSettings();
  const second = h.context.saveSettings();
  await until(() => h.release);
  const home = h.context.runEngineChange(async () => h.context.ipc.invoke("set-local-model", "small"));
  const later = h.context.saveSettings();
  assert.equal(h.calls.some(([command]) => command === "set-local-model"), false);
  h.release();
  await Promise.all([first, second, home, later]);
  assert.equal(h.database.model, "small");
  assert.equal(h.context.currentSettings.model, "small");
  assert.deepEqual(h.calls.filter(([command]) => command !== "get-settings"), [
    ["save-settings", "large"], ["save-settings", "large"], ["set-local-model", "small"], ["save-settings", "small"],
  ]);
});
test("Home flushes pending debounced form edits before changing engine", async () => {
  const h = harness(); h.noDelay(); h.context.commitTimer = 123;
  await h.context.runEngineChange(async () => h.context.ipc.invoke("set-local-model", "small"));
  assert.deepEqual(h.cancelled, [123]);
  assert.equal(h.context.commitTimer, null);
  assert.equal(h.database.uiTheme, "midnight");
  assert.equal(h.database.model, "small");
  assert.equal(h.calls[0][0], "save-settings");
});
test("failed post-switch snapshot cannot let autosave roll the engine back", async () => {
  const h = harness(); h.noDelay();
  await assert.rejects(h.context.runEngineChange(async () => {
    await h.context.ipc.invoke("set-local-model", "small"); h.failSnapshot(true); return true;
  }), /snapshot unavailable/);
  assert.equal(await h.context.saveSettings(), false);
  assert.equal(h.database.model, "small");
  assert.equal(h.calls.some(([command]) => command === "save-settings"), false);
  h.failSnapshot(false);
  assert.equal(await h.context.saveSettings(), true);
  assert.equal(h.database.model, "small");
});


test("Home also serializes behind a pending explicit Settings activation", async () => {
  const h = harness();
  const activation = h.context.queueSettingsSave({ provider: "local", model: "another" });
  await until(() => h.release);
  const home = h.context.runEngineChange(async actual => {
    assert.equal(actual.model, "another");
    return h.context.ipc.invoke("set-local-model", "small");
  });
  const later = h.context.saveSettings();
  h.release();
  await Promise.all([activation, home, later]);
  assert.equal(h.database.model, "small");
  assert.equal(h.context.currentSettings.model, "small");
});
