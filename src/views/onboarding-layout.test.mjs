import assert from "node:assert/strict";
import test from "node:test";

const module = await import("./onboarding-layout.mjs").catch(() => ({}));
const small = "local-qwen", large = "local-qwen-large", nemotron = "local-nemotron";

test("onboarding uses named steps, with engine before permissions and no non-macOS Accessibility", () => {
  assert.equal(typeof module.onboardingSteps, "function", "named-step policy must exist");
  assert.deepEqual(module.onboardingSteps("macos"), ["welcome", "privacy", "engine", "microphone", "accessibility", "practice"]);
  for (const os of ["windows", "linux"]) assert.deepEqual(module.onboardingSteps(os), ["welcome", "privacy", "engine", "microphone", "practice"]);
});

test("all four tiers offer the approved main and more engine ordering", () => {
  assert.equal(typeof module.onboardingEngineLayout, "function", "tier layout policy must exist");
  for (const [tier, main, more] of [
    ["qwen", [small, "openai"], [large, "groq", nemotron]],
    ["qwen-large-offered", [small, large, "openai"], ["groq", nemotron]],
    ["qwen-large-prominent", [small, large, "openai"], ["groq", nemotron]],
    ["cloud-default", ["openai", small], [large, "groq", nemotron]],
  ]) {
    const layout = module.onboardingEngineLayout(tier, true);
    assert.deepEqual(layout.main.map(card => card.value), main);
    assert.deepEqual(layout.more.map(card => card.value), more);
    const cards = [...layout.main, ...layout.more];
    assert.deepEqual(cards.filter(card => card.recommended).map(card => card.value), [small]);
    assert.equal(layout.main.find(card => card.value === large)?.prominent, tier === "qwen-large-prominent" ? true : tier === "qwen-large-offered" ? false : undefined);
    assert.equal(module.onboardingEngineLayout(tier, false).more.some(card => card.value === nemotron), false);
  }
  assert.deepEqual(module.onboardingEngineLayout("unknown", false), module.onboardingEngineLayout("qwen", false));
});

test("selected downloading local engine permits Next but never unlocks practice", () => {
  assert.equal(typeof module.onboardingEngineState, "function", "selection and readiness must be separate");
  const settings = {provider: "local", model: "qwen", engineReady: false};
  assert.deepEqual(module.onboardingEngineState(settings, {qwen:{state:"downloading"}}), {selected: true, ready: false});
  for (const state of ["absent", "partial", "error"]) assert.deepEqual(module.onboardingEngineState(settings, {qwen:{state}}), {selected:false, ready:false});
  assert.deepEqual(module.onboardingEngineState({...settings, engineReady:true}, {qwen:{state:"ready"}}), {selected:true,ready:true});
  assert.deepEqual(module.onboardingEngineState({provider:"groq",engineReady:false}, {qwen:{state:"downloading"}}), {selected:false,ready:false});
});
