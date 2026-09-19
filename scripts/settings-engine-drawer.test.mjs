import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/views/settings.js", import.meta.url), "utf8");
function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
function harness() {
  const choices = ["local-qwen", "local-qwen-large", "groq", "openai"];
  const nodes = {};
  for (const choice of choices) {
    nodes[`engine-drawer-${choice}`] = { hidden: true, appendChild(node) { node.parentElement = this; } };
    nodes[`engine-choice-${choice}`] = { attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } };
  }
  for (const id of ["engineAdvanced", "engineActivation", "apiKeyItem", "modelItem"]) nodes[id] = {};
  nodes.providerSelect = { value: "local-qwen", options: choices.map(value => ({ value })) };
  nodes.modelSelect = { value: "groq-model", options: [{ value: "groq-model" }] };
  const context = vm.createContext({
    document: { getElementById: id => nodes[id] },
    ENGINE_CARDS: choices.map(value => ({ value })),
    expandedEngineProvider: "local-qwen", inspectedLocalModel: null,
    engineCloudDrafts: new Map(), currentSettings: { provider: "local", model: "small" },
    localModelForProvider: choice => choice === "local-qwen" ? "small" : choice === "local-qwen-large" ? "large" : "",
    providerForSettings: settings => settings.model === "large" ? "local-qwen-large" : "local-qwen",
    modelOptions: { groq: [{ value: "groq-model" }] },
    updateModelOptions() {}, setSelectValue(node, value) { node.value = value; },
    refreshLocalModelStatus: async () => {},
  });
  vm.runInContext(section("function syncEngineDrawer", "function camelKey") + "\n"
    + section("function inspectEngine", "function handleProviderChange"), context);
  context.toggleProviderFields = context.syncEngineDrawer;
  context.renderEngineCards = context.syncEngineDrawer;
  return { context, nodes, choices };
}

test("engine card click opens, closes, and reopens without changing the active engine", () => {
  const h = harness();
  h.context.inspectEngine("groq", { toggle: true });
  assert.equal(h.nodes["engine-drawer-groq"].hidden, false);
  assert.equal(h.nodes["engine-drawer-local-qwen"].hidden, true);
  assert.equal(h.nodes.apiKeyItem.parentElement, h.nodes["engine-drawer-groq"]);
  h.context.inspectEngine("groq", { toggle: true });
  assert.ok(h.choices.every(choice => h.nodes[`engine-drawer-${choice}`].hidden));
  assert.equal(h.nodes["engine-choice-groq"].attributes["aria-expanded"], "false");
  h.context.syncEngineDrawer();
  assert.equal(h.nodes["engine-drawer-groq"].hidden, true, "status refresh must not reopen a collapsed drawer");
  h.context.inspectEngine("groq", { toggle: true });
  assert.equal(h.nodes["engine-drawer-groq"].hidden, false);
  assert.equal(h.context.currentSettings.provider, "local");
  assert.equal(h.context.currentSettings.model, "small");
});

test("explicit deep link opens local details even when its card is already expanded", () => {
  const h = harness();
  h.context.inspectEngine("local-qwen-large");
  h.context.inspectEngine("local-qwen-large");
  assert.equal(h.nodes["engine-drawer-local-qwen-large"].hidden, false);
  assert.equal(h.nodes.engineAdvanced.parentElement, h.nodes["engine-drawer-local-qwen-large"]);
  assert.equal(h.nodes.engineAdvanced.open, true);
  h.context.inspectEngine("local-qwen-large", { toggle: true });
  assert.equal(h.nodes["engine-drawer-local-qwen-large"].hidden, true);
});

test("rendered cards explicitly request accordion toggling", () => {
  assert.match(section("function renderEngineCards", "function syncEngineDrawer"), /inspectEngine\(entry\.value,\s*\{\s*toggle:\s*true\s*\}\)/);
});

test("engine cards show a decorative chevron driven by expansion state", () => {
  const render = section("function renderEngineCards", "function syncEngineDrawer");
  assert.match(render, /engine-card-chevron/);
  assert.match(render, /chevron\.setAttribute\("aria-hidden", "true"\)/);
  const css = readFileSync(new URL("../src/views/settings.css", import.meta.url), "utf8");
  assert.match(css, /\.engine-details-toggle\[aria-expanded="true"\] \.engine-card-chevron/);
  // A full-width row with padding must not outgrow the list, whose overflow
  // clipping would cut the chevron off the right edge.
  assert.match(css, /\.engine-card-row \{[^}]*box-sizing: border-box;[^}]*width: 100%/);
});

test("selection control activates the inspected target, independently of title expansion", async () => {
  const calls = [];
  const context = vm.createContext({
    engineSwitchPending: false,
    currentSettings: { provider: "local", model: "small" },
    inspectEngine: choice => calls.push(["inspect", choice]),
    inspectedEngineTarget: () => ({ provider: "local", model: "large" }),
    activateEngine: async target => calls.push(["activate", target.model]),
  });
  vm.runInContext(section("async function selectSettingsEngine", "function renderEngineCards"), context);
  await context.selectSettingsEngine("local-qwen-large");
  assert.deepEqual(calls, [["inspect", "local-qwen-large"], ["activate", "large"]]);
  context.engineSwitchPending = true;
  await context.selectSettingsEngine("groq");
  assert.equal(calls.length, 2);
  assert.match(source, /row.append\(activation, card\)/);
  assert.match(source, /activation.addEventListener\("click", \(\) => void selectSettingsEngine\(entry.value\)\)/);
});
