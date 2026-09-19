import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/views/settings.js", import.meta.url), "utf8");
function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
function container(id) {
  return {
    id, hidden: true, children: [],
    appendChild(node) { return this.insertBefore(node, null); },
    insertBefore(node, reference) {
      const previous = node.parentElement?.children;
      if (previous) previous.splice(previous.indexOf(node), 1);
      const index = reference ? this.children.indexOf(reference) : -1;
      if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
      node.parentElement = this;
      return node;
    },
  };
}
function harness() {
  const choices = ["local-qwen", "local-qwen-large", "groq", "openai"];
  const nodes = {};
  for (const choice of choices) {
    nodes[`engine-drawer-${choice}`] = container(`engine-drawer-${choice}`);
    nodes[`engine-choice-${choice}`] = { attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } };
  }
  for (const id of ["engineAdvanced", "engineActivation", "apiKeyItem", "modelItem"]) nodes[id] = { id };
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

test("drawer content starts where the row's title does", () => {
  const css = readFileSync(new URL("../src/views/settings.css", import.meta.url), "utf8");
  const block = selector => css.match(new RegExp(`${selector.replace(/[.[\]]/g, "\\$&")} \\{([^}]+)\\}`))[1];
  const px = (rule, property) => Number(rule.match(new RegExp(`${property}: ([\\d.]+)px`))[1]);
  const row = block(".engine-card-row");
  const rowPaddingLeft = Number(row.match(/padding: [\d.]+px ([\d.]+)px/)[1]);
  const titleInset = rowPaddingLeft + px(block(".engine-select-button"), "width") + px(row, "gap")
    + px(block(".engine-card-icon"), "font-size") + px(block(".engine-details-toggle"), "gap");
  const drawerBorder = Number(block(".engine-drawer").match(/border-left: ([\d.]+)px/)[1]);
  const drawerPadding = Number(css.match(/\.engine-drawer \{ padding: [\d.]+px [\d.]+px [\d.]+px ([\d.]+)px; \}/)[1]);
  assert.equal(drawerBorder + drawerPadding, titleInset);
});

test("a cloud drawer keeps its key, model and notice in order after a local drawer borrowed some of them", () => {
  const h = harness();
  const translationSlot = container("translationKeySlot");
  // As in toggleProviderFields: inspecting a local engine parks the key field
  // in the translation panel, while the model card stays in the old drawer.
  h.context.toggleProviderFields = (choice) => {
    if (h.context.localModelForProvider(choice)) translationSlot.appendChild(h.nodes.apiKeyItem);
    h.context.syncEngineDrawer();
  };
  for (const choice of ["groq", "local-qwen-large", "groq"]) h.context.inspectEngine(choice);
  const order = h.nodes["engine-drawer-groq"].children.map((node) => node.id);
  assert.deepEqual(order, ["apiKeyItem", "modelItem", "engineActivation"]);
});
