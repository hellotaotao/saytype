// Keep hardware presentation separate from persisted engine intent and readiness.
export function onboardingSteps(os) {
  return ["welcome", "privacy", "engine", "microphone", ...(os === "macos" ? ["accessibility"] : []), "practice"];
}

export function onboardingEngineLayout(localTier, nemotronSupported) {
  const small = { value: "local-qwen", recommended: true };
  const large = { value: "local-qwen-large", prominent: localTier === "qwen-large-prominent" };
  const openai = { value: "openai" };
  const extras = [{ value: "groq" }, ...(nemotronSupported ? [{ value: "local-nemotron" }] : [])];
  if (localTier === "cloud-default") {
    return { main: [{ ...openai, note: "cloudDefault" }, { ...small, note: "localSlow" }], more: [{ ...large, note: "largeSlow" }, ...extras] };
  }
  if (localTier === "qwen-large-offered" || localTier === "qwen-large-prominent") {
    return { main: [small, { ...large, note: "largeComparison" }, openai], more: extras };
  }
  return { main: [small, openai], more: [{ ...large, note: "largeSlow" }, ...extras] };
}

export function onboardingEngineState(settings, statuses) {
  const valid = ["local", "openai", "groq"].includes(settings?.provider);
  const ready = valid && settings.engineReady === true;
  const downloading = settings?.provider === "local" && statuses[settings.model]?.state === "downloading";
  return { selected: ready || downloading, ready };
}
