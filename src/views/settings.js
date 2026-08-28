(function () {
let ipc = null;
let initI18n = () => "en";
let setLanguage = () => "en";
let applyI18n = () => {};
let t = (key) => key;

if (typeof document !== "undefined" && document.documentElement) {
  document.documentElement.setAttribute("data-settings-js-ran", "1");
}

const READY_TIMEOUT_MS = 3000;
const READY_POLL_MS = 25;
const THEME_PREFS = new Set(["auto", "midnight", "elegant"]);
const QWEN_LOCAL_MODEL = "qwen3-asr-0.6b-q8_0";
const NEMOTRON_LOCAL_MODEL = "nemotron-3.5-asr-streaming-0.6b-q8_0";
const LOCAL_QWEN_PROVIDER = "local-qwen";
const LOCAL_NEMOTRON_PROVIDER = "local-nemotron";
let currentThemePref = "elegant";

// First entry per provider is the effective default when switching provider
// (the rebuilt <select> lands on it) — keep it in sync with the backend
// default (settings.rs default_model / save_onboarding_api_key /
// perform_transcription_request's empty-model fallback). `recommended` adds a
// localized "★ 推荐" tag to the label. Turbo over lv3 and 4o-mini over
// whisper-1 are evidence-backed: the 2026-07-03 punctuation sweep (CLAUDE.md)
// showed lv3/whisper-1 collapse to zero punctuation on run-on Chinese speech
// while turbo+seed and gpt-4o-mini-transcribe punctuate.
const modelOptions = {
  groq: [
    { value: "whisper-large-v3-turbo", labelKey: "settings.model.options.whisperLargeV3Turbo", recommended: true },
    { value: "whisper-large-v3", labelKey: "settings.model.options.whisperLargeV3" },
  ],
  openai: [
    { value: "gpt-4o-mini-transcribe", labelKey: "settings.model.options.gpt4oMiniTranscribe", recommended: true },
    { value: "gpt-4o-transcribe", labelKey: "settings.model.options.gpt4oTranscribe" },
    { value: "whisper-1", labelKey: "settings.model.options.whisper1" },
  ],
};

let currentSettings = {};
let pageEventsBound = false;
let shortcutSyncBound = false;
let themeSyncBound = false;
let pendingAccessibilityRecheck = false;
let accessibilityRecheckTimer = null;
let settingsInitialized = false;
let settingsDirty = false;
let activeSettingsTab = "voice-input";

const SETTINGS_TABS = ["voice-input", "transcription", "app"];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function translate(key, vars) {
  try {
    return typeof t === "function" ? t(key, vars) : key;
  } catch {
    return key;
  }
}

function normalizeThemePref(value) {
  return THEME_PREFS.has(value) ? value : "elegant";
}

function systemPrefersDark() {
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

function concreteTheme(pref) {
  const normalized = normalizeThemePref(pref);
  return normalized === "auto" ? (systemPrefersDark() ? "midnight" : "elegant") : normalized;
}

function applyTheme(value) {
  currentThemePref = normalizeThemePref(value);
  document.documentElement.setAttribute("data-theme", concreteTheme(currentThemePref));
}

function watchSystemTheme() {
  if (!window.matchMedia) {
    return;
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentThemePref === "auto") {
      document.documentElement.setAttribute("data-theme", concreteTheme(currentThemePref));
    }
  });
}

function getDependencies() {
  const bridge = window.__SAYTYPE_IPC__;
  const i18nApi = window.SayTypeI18n;

  if (
    bridge &&
    typeof bridge.invoke === "function" &&
    typeof bridge.on === "function" &&
    i18nApi &&
    typeof i18nApi.initI18n === "function" &&
    typeof i18nApi.setLanguage === "function" &&
    typeof i18nApi.applyI18n === "function" &&
    typeof i18nApi.t === "function"
  ) {
    return { bridge, i18nApi };
  }

  return null;
}

async function waitForDependencies() {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const dependencies = getDependencies();
    if (dependencies) {
      return dependencies;
    }
    await delay(READY_POLL_MS);
  }

  return getDependencies();
}

async function initializeDependencies() {
  if (ipc) {
    return;
  }

  const dependencies = getDependencies() || (await waitForDependencies());
  if (!dependencies) {
    throw new Error("settings runtime dependencies unavailable");
  }

  ipc = dependencies.bridge;
  ({ initI18n, setLanguage, applyI18n, t } = dependencies.i18nApi);
}

function updateModelOptions(provider) {
  const select = document.getElementById("modelSelect");
  if (!select) {
    return;
  }

  select.innerHTML = "";
  (modelOptions[provider] || []).forEach((opt) => {
    const option = document.createElement("option");
    option.value = opt.value;
    const label = opt.labelKey ? translate(opt.labelKey) : opt.label || opt.value;
    option.textContent = opt.recommended
      ? `${label} · ${translate("settings.model.recommendedTag")}`
      : label;
    select.appendChild(option);
  });
}

function localModelForProvider(provider) {
  if (provider === LOCAL_NEMOTRON_PROVIDER) {
    return NEMOTRON_LOCAL_MODEL;
  }
  if (provider === LOCAL_QWEN_PROVIDER) {
    return QWEN_LOCAL_MODEL;
  }
  return "";
}

function providerForSettings(settings) {
  if (settings?.provider !== "local") {
    return settings?.provider || "groq";
  }
  return settings.model === NEMOTRON_LOCAL_MODEL
    ? LOCAL_NEMOTRON_PROVIDER
    : LOCAL_QWEN_PROVIDER;
}

function toggleProviderFields(providerChoice) {
  const provider = localModelForProvider(providerChoice) ? "local" : providerChoice;
  const apiKeyItem = document.getElementById("apiKeyItem");
  const modelItem = document.getElementById("modelItem");
  const fieldGroq = document.getElementById("apiKeyFieldGroq");
  const fieldOpenAI = document.getElementById("apiKeyFieldOpenAI");
  if (!fieldGroq || !fieldOpenAI) {
    return;
  }
  apiKeyItem?.classList.toggle("hidden", provider === "local");
  modelItem?.classList.toggle("hidden", provider === "local");
  fieldGroq.classList.toggle("hidden", provider !== "groq");
  fieldOpenAI.classList.toggle("hidden", provider !== "openai");
}

// --- Local model panel (provider "local") ---
let localModelState = "absent"; // absent | partial | downloading | ready
// Whether the running download was started from this Settings page. Gates the
// "switch to local?" prompt on ready: a download driven by the onboarding
// onboarding wizard auto-switches there, so Settings must not show a second,
// competing dialog.
let localModelDownloadStartedHere = "";
let localModelSyncBound = false;
let updatesPanelBound = false;
let currentAppVersion = "";
let diagnosticLogPanelBound = false;
let diagnosticLogLoaded = false;
let diagnosticLogLoading = false;
let currentDiagnosticLog = null;

function formatGB(bytes) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function selectedLocalModel() {
  const provider = document.getElementById("providerSelect")?.value;
  return localModelForProvider(provider) || NEMOTRON_LOCAL_MODEL;
}

function renderLocalModelPanel(status) {
  const item = document.getElementById("localModelItem");
  const statusEl = document.getElementById("localModelStatus");
  const actionBtn = document.getElementById("localModelActionBtn");
  const deleteBtn = document.getElementById("localModelDeleteBtn");
  const progressEl = document.getElementById("localModelProgress");
  if (!item || !statusEl || !actionBtn || !deleteBtn || !progressEl) {
    return;
  }
  localModelState = status.state;
  const provider = document.getElementById("providerSelect")?.value;
  item.classList.toggle("hidden", !localModelForProvider(provider));

  const pct = status.totalBytes ? status.downloadedBytes / status.totalBytes : 0;
  progressEl.value = Math.round(pct * 1000);
  progressEl.classList.toggle("hidden", status.state !== "downloading");
  // Also offered in the "partial" state: an interrupted download leaves up to
  // ~1 GB of .part files behind, and resuming is not the only way out of it.
  const isPartial = status.state === "partial";
  deleteBtn.classList.toggle("hidden", status.state !== "ready" && !isPartial);
  deleteBtn.textContent = translate(
    isPartial ? "settings.localModel.deletePartial" : "settings.localModel.delete"
  );

  if (status.state === "unsupported") {
    statusEl.textContent = translate("settings.localModel.statusUnsupported");
    actionBtn.classList.add("hidden");
    deleteBtn.classList.add("hidden");
  } else if (status.state === "ready") {
    statusEl.textContent = translate("settings.localModel.statusReady", {
      size: formatGB(status.totalBytes),
    });
    actionBtn.classList.add("hidden");
  } else if (status.state === "downloading") {
    statusEl.textContent = translate("settings.localModel.statusDownloading", {
      done: formatGB(status.downloadedBytes),
      total: formatGB(status.totalBytes),
    });
    actionBtn.classList.remove("hidden");
    actionBtn.textContent = translate("settings.localModel.cancel");
  } else {
    statusEl.textContent =
      status.state === "partial"
        ? translate("settings.localModel.statusPartial")
        : translate("settings.localModel.statusAbsent", { total: formatGB(status.totalBytes) });
    actionBtn.classList.remove("hidden");
    actionBtn.textContent = translate(
      status.state === "partial" ? "settings.localModel.resume" : "settings.localModel.download"
    );
  }
}

async function refreshLocalModelStatus() {
  if (!ipc) {
    return;
  }
  try {
    renderLocalModelPanel(await ipc.invoke("get-local-model-status", selectedLocalModel()));
  } catch (error) {
    console.error("Failed to fetch local model status:", error);
  }
}

async function handleLocalModelAction() {
  try {
    if (localModelState === "downloading") {
      localModelDownloadStartedHere = "";
      await ipc.invoke("cancel-local-model-download");
      return; // terminal event repaints the panel
    }
    // Optimistic repaint, then kick the (long-running) download; progress
    // events keep the panel live. Errors surface via the "error" event too.
    const model = selectedLocalModel();
    localModelDownloadStartedHere = model;
    renderLocalModelPanel({ state: "downloading", downloadedBytes: 0, totalBytes: 1 });
    void refreshLocalModelStatus();
    await ipc.invoke("download-local-model", model);
  } catch (error) {
    console.error("Local model download failed:", error);
  }
}

// Download finished from this page → offer (don't force) the switch to the
// local engine; the backend save + broadcast keeps every window in sync.
async function offerSwitchToLocal(model) {
  if (currentSettings?.provider === "local" && currentSettings?.model === model) {
    return;
  }
  if (!confirm(translate("settings.localModel.switchPrompt"))) {
    return;
  }
  try {
    await ipc.invoke("set-local-model", model);
    currentSettings.provider = "local";
    currentSettings.model = model;
    const providerSelect = document.getElementById("providerSelect");
    setSelectValue(providerSelect, providerForSettings(currentSettings), "groq");
    toggleProviderFields(providerSelect?.value || "groq");
    void refreshLocalModelStatus();
  } catch (error) {
    console.error("Failed to switch to the local engine:", error);
    alert(translate("settings.saveError"));
  }
}

async function handleLocalModelDelete() {
  const confirmKey =
    localModelState === "partial"
      ? "settings.localModel.deletePartialConfirm"
      : "settings.localModel.deleteConfirm";
  if (!confirm(translate(confirmKey))) {
    return;
  }
  try {
    await ipc.invoke("delete-local-model", selectedLocalModel());
    await refreshLocalModelStatus();
  } catch (error) {
    console.error("Failed to delete local model:", error);
  }
}

function setupLocalModelSync() {
  if (localModelSyncBound || !ipc) {
    return;
  }
  localModelSyncBound = true;
  ipc.on("local-model-download-progress", (_event, payload) => {
    if (!payload) {
      return;
    }
    if (payload.model && payload.model !== selectedLocalModel()) {
      return;
    }
    if (payload.state === "error") {
      alert(translate("settings.localModel.downloadFailed", { reason: payload.message || "" }));
    }
    if (payload.state === "downloading") {
      renderLocalModelPanel({
        state: "downloading",
        downloadedBytes: payload.downloadedBytes || 0,
        totalBytes: payload.totalBytes || 0,
      });
    } else {
      // ready/cancelled/error: re-derive the real on-disk state.
      void refreshLocalModelStatus();
    }
    if (payload.state === "ready" && localModelDownloadStartedHere === selectedLocalModel()) {
      const model = localModelDownloadStartedHere;
      localModelDownloadStartedHere = "";
      void offerSwitchToLocal(model);
    }
  });

}

function revealLocalModelPanel(model = NEMOTRON_LOCAL_MODEL) {
  const providerSelect = document.getElementById("providerSelect");
  const provider = model === QWEN_LOCAL_MODEL
    ? LOCAL_QWEN_PROVIDER
    : LOCAL_NEMOTRON_PROVIDER;
  setSelectValue(providerSelect, provider, "groq");
  toggleProviderFields(provider);
  void refreshLocalModelStatus();
  window.setTimeout(() => {
    document.getElementById("localModelItem")?.scrollIntoView({ block: "center" });
  }, 0);
}

function renderUpdateStatus(status) {
  const statusEl = document.getElementById("updateStatus");
  const checkBtn = document.getElementById("checkUpdatesBtn");
  const installBtn = document.getElementById("installUpdateBtn");
  if (!statusEl || !checkBtn || !installBtn) {
    return;
  }

  const state = status?.state || "idle";
  const version = status?.version || "";
  checkBtn.disabled = state === "checking" || state === "downloading";
  checkBtn.classList.toggle("hidden", state === "ready");
  installBtn.classList.toggle("hidden", state !== "ready");

  if (state === "checking") {
    statusEl.textContent = translate("settings.updates.checking");
  } else if (state === "downloading") {
    statusEl.textContent = translate("settings.updates.downloading", { version });
  } else if (state === "ready") {
    statusEl.textContent = translate("settings.updates.ready", { version });
  } else if (state === "error") {
    statusEl.textContent = translate("settings.updates.error", { message: status?.message || "" });
  } else if (state === "upToDate") {
    statusEl.textContent = translate("settings.updates.upToDate", { version: currentAppVersion });
  } else {
    statusEl.textContent = currentAppVersion ? `v${currentAppVersion}` : "";
  }
}

async function refreshUpdateStatus() {
  try {
    renderUpdateStatus(await ipc.invoke("get-update-status"));
  } catch {
    renderUpdateStatus({ state: "idle" });
  }
}

async function setupUpdatesPanel() {
  if (updatesPanelBound || !ipc) {
    return;
  }
  updatesPanelBound = true;

  ipc.on("update-status", (_event, payload) => {
    if (payload) {
      renderUpdateStatus(payload);
    }
  });

  document.getElementById("checkUpdatesBtn")?.addEventListener("click", async () => {
    try {
      renderUpdateStatus(await ipc.invoke("check-for-updates"));
    } catch (error) {
      renderUpdateStatus({ state: "error", message: String(error) });
    }
  });

  document.getElementById("installUpdateBtn")?.addEventListener("click", async () => {
    try {
      await ipc.invoke("install-update-and-restart");
    } catch (error) {
      renderUpdateStatus({ state: "error", message: String(error) });
    }
  });

  try {
    // Dev-channel builds show the local build counter alongside the version;
    // official CI builds stay a clean "1.6.1". Remote versions in the
    // downloading/ready strings are untouched.
    const info = await ipc.invoke("get-build-info");
    currentAppVersion =
      info.channel === "official" ? info.version : `${info.version} · dev.${info.buildNumber}`;
  } catch {
    currentAppVersion = "";
  }
  await refreshUpdateStatus();
}

function formatDiagnosticLogSize(bytes) {
  const size = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function renderDiagnosticLog(result) {
  const contentElement = document.getElementById("diagnosticLogContent");
  const statusElement = document.getElementById("diagnosticLogStatus");
  const copyButton = document.getElementById("copyDiagnosticLogBtn");
  if (!contentElement || !statusElement || !copyButton) {
    return;
  }

  currentDiagnosticLog = result;
  const content = typeof result?.content === "string" ? result.content : "";
  contentElement.value = content;
  copyButton.disabled = !content;
  if (!content) {
    statusElement.textContent = translate("settings.diagnostics.empty");
    return;
  }

  const language = currentSettings?.uiLanguage;
  const locale = language === "zh" ? "zh-CN" : language === "en" ? "en-US" : undefined;
  const modifiedAt = Number(result.modifiedAtUnixMs);
  const time = modifiedAt > 0 ? new Date(modifiedAt).toLocaleString(locale) : "—";
  statusElement.textContent = translate(
    result.truncated ? "settings.diagnostics.truncated" : "settings.diagnostics.loaded",
    {
      size: formatDiagnosticLogSize(Number(result.sizeBytes)),
      time,
    }
  );
}

async function refreshDiagnosticLog() {
  if (!ipc || diagnosticLogLoading) {
    return;
  }

  const statusElement = document.getElementById("diagnosticLogStatus");
  const refreshButton = document.getElementById("refreshDiagnosticLogBtn");
  const copyButton = document.getElementById("copyDiagnosticLogBtn");
  diagnosticLogLoading = true;
  if (statusElement) {
    statusElement.textContent = translate("settings.diagnostics.loading");
  }
  if (refreshButton) {
    refreshButton.disabled = true;
  }
  if (copyButton) {
    copyButton.disabled = true;
  }

  try {
    const result = await ipc.invoke("get-diagnostic-log");
    diagnosticLogLoaded = true;
    renderDiagnosticLog(result);
  } catch (error) {
    if (statusElement) {
      statusElement.textContent = translate("settings.diagnostics.loadError", {
        message: String(error),
      });
    }
  } finally {
    diagnosticLogLoading = false;
    if (refreshButton) {
      refreshButton.disabled = false;
    }
    if (copyButton) {
      copyButton.disabled = !document.getElementById("diagnosticLogContent")?.value;
    }
  }
}

async function copyDiagnosticLog() {
  const content = document.getElementById("diagnosticLogContent")?.value || "";
  const statusElement = document.getElementById("diagnosticLogStatus");
  if (!content || !statusElement) {
    return;
  }

  try {
    await ipc.invoke("copy-to-clipboard", content, null);
    statusElement.textContent = translate("settings.diagnostics.copied");
  } catch (error) {
    statusElement.textContent = translate("settings.diagnostics.copyError", {
      message: String(error),
    });
  }
}

function setupDiagnosticLogPanel() {
  if (diagnosticLogPanelBound) {
    return;
  }
  const panel = document.getElementById("diagnosticLogPanel");
  if (!panel) {
    return;
  }

  panel.addEventListener("toggle", () => {
    if (panel.open && !diagnosticLogLoaded) {
      void refreshDiagnosticLog();
    }
  });
  document.getElementById("refreshDiagnosticLogBtn")?.addEventListener("click", () => {
    void refreshDiagnosticLog();
  });
  document.getElementById("copyDiagnosticLogBtn")?.addEventListener("click", () => {
    void copyDiagnosticLog();
  });
  diagnosticLogPanelBound = true;

  if (panel.open) {
    void refreshDiagnosticLog();
  }
}

function toggleKeyReveal(button) {
  const input = document.getElementById(button.getAttribute("data-target"));
  if (!input) {
    return;
  }
  const reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  button.textContent = reveal ? "visibility_off" : "visibility";
  const label = translate(reveal ? "settings.apiKey.hide" : "settings.apiKey.reveal");
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
}

function markDirty() {
  settingsDirty = true;
  document.getElementById("unsavedHint")?.classList.remove("hidden");
  const saveButton = document.getElementById("saveSettingsButton");
  const discardButton = document.getElementById("discardSettingsButton");
  if (saveButton) {
    saveButton.disabled = false;
  }
  if (discardButton) {
    discardButton.disabled = false;
  }
}

function clearDirty() {
  settingsDirty = false;
  document.getElementById("unsavedHint")?.classList.add("hidden");
  const saveButton = document.getElementById("saveSettingsButton");
  const discardButton = document.getElementById("discardSettingsButton");
  if (saveButton) {
    saveButton.disabled = true;
  }
  if (discardButton) {
    discardButton.disabled = true;
  }
}

function setSelectValue(element, value, fallback) {
  if (!element) {
    return;
  }

  const hasOption = Array.from(element.options).some((option) => option.value === value);
  element.value = hasOption ? value : fallback;
}

function handleProviderChange(event) {
  const providerChoice = event.target.value || "groq";
  const provider = localModelForProvider(providerChoice) ? "local" : providerChoice;
  if (provider !== "local") {
    updateModelOptions(provider);
  }
  toggleProviderFields(providerChoice);
  void refreshLocalModelStatus();
}

function handleThemeChange(event) {
  applyTheme(event.target.value);
}

function handleUiLanguageChange(event) {
  setLanguage(event.target.value);
  applyI18n(document);
  if (currentDiagnosticLog) {
    renderDiagnosticLog(currentDiagnosticLog);
  }
  void checkMicrophonePermissionStatus();
  void checkAccessibilityStatus();
  void refreshUpdateStatus();
}

function activateSettingsTab(tabName, focus = false) {
  const target = SETTINGS_TABS.includes(tabName) ? tabName : "voice-input";
  activeSettingsTab = target;

  document.querySelectorAll("[data-settings-tab]").forEach((tab) => {
    const active = tab.getAttribute("data-settings-tab") === target;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) {
      tab.focus();
    }
  });

  document.querySelectorAll(".settings-panel").forEach((panel) => {
    const active = panel.id === `settings-panel-${target}`;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
}

function handleSettingsTabClick(event) {
  activateSettingsTab(event.currentTarget.getAttribute("data-settings-tab"));
}

function handleSettingsTabKeydown(event) {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") {
    return;
  }
  event.preventDefault();
  const current = SETTINGS_TABS.indexOf(activeSettingsTab);
  let next = current;
  if (event.key === "ArrowRight") {
    next = (current + 1) % SETTINGS_TABS.length;
  } else if (event.key === "ArrowLeft") {
    next = (current - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
  } else if (event.key === "Home") {
    next = 0;
  } else if (event.key === "End") {
    next = SETTINGS_TABS.length - 1;
  }
  activateSettingsTab(SETTINGS_TABS[next], true);
}

function bindEventHandlers() {
  if (pageEventsBound) {
    return;
  }

  watchSystemTheme();

  const providerSelect = document.getElementById("providerSelect");
  const checkPermissionButton = document.getElementById("checkPermission");
  const checkAccessibilityButton = document.getElementById("checkAccessibility");
  const discardSettingsButton = document.getElementById("discardSettingsButton");
  const saveSettingsButton = document.getElementById("saveSettingsButton");
  const uiLanguageSelect = document.getElementById("uiLanguageSelect");
  const themeSelect = document.getElementById("themeSelect");

  providerSelect?.addEventListener("change", handleProviderChange);
  checkPermissionButton?.addEventListener("click", () => {
    void requestMicrophonePermission();
  });
  checkAccessibilityButton?.addEventListener("click", () => {
    void handleAccessibilityPermission();
  });
  discardSettingsButton?.addEventListener("click", () => {
    void discardSettings();
  });
  saveSettingsButton?.addEventListener("click", () => {
    void saveSettings();
  });
  uiLanguageSelect?.addEventListener("change", handleUiLanguageChange);
  themeSelect?.addEventListener("change", handleThemeChange);

  document.querySelectorAll(".reveal-btn").forEach((button) => {
    button.addEventListener("click", () => toggleKeyReveal(button));
  });

  document.getElementById("localModelActionBtn")?.addEventListener("click", () => {
    void handleLocalModelAction();
  });
  document.getElementById("localModelDeleteBtn")?.addEventListener("click", () => {
    void handleLocalModelDelete();
  });

  // Only edits inside Settings mark the draft dirty. History search and the
  // dictionary live in the same main window and must not affect this state.
  const settingsPage = document.querySelector("#settings-page");
  settingsPage?.addEventListener("input", markDirty);
  settingsPage?.addEventListener("change", markDirty);

  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      settingsDirty &&
      document.getElementById("settings-page")?.classList.contains("active")
    ) {
      event.preventDefault();
      void discardSettings();
    }
  });

  // Permission state can change while another main-window page is active or
  // while System Settings is in front. Refresh quietly whenever the app comes
  // back; the debounced gated recheck stays for the guided flow, where the TCC
  // grant can land a beat after refocus.
  window.addEventListener("focus", () => {
    void refreshAccessibilityQuietly();
    scheduleAccessibilityRecheck();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void refreshAccessibilityQuietly();
      scheduleAccessibilityRecheck();
    }
  });

  // The backend broadcasts every real Accessibility state change (wizard
  // grant, main-window rechecks), so re-render without waiting for the next
  // visit to Settings.
  ipc.on("accessibility-permission-changed", () => {
    void refreshAccessibilityQuietly();
  });

  document.querySelectorAll("[data-settings-tab]").forEach((tab) => {
    tab.addEventListener("click", handleSettingsTabClick);
    tab.addEventListener("keydown", handleSettingsTabKeydown);
  });

  pageEventsBound = true;
}

function renderAccessibilityStatus(result) {
  const statusElement = document.getElementById("accessibilityStatus");
  if (!statusElement) {
    return;
  }

  let ok = false;
  if (!result) {
    statusElement.textContent = translate("settings.permission.error");
    statusElement.className = "permission-status denied";
  } else if (result.granted) {
    statusElement.textContent = translate("settings.accessibility.granted");
    statusElement.className = "permission-status granted";
    ok = true;
  } else if (result.status === "not_required") {
    statusElement.textContent = translate("settings.accessibility.notRequired");
    statusElement.className = "permission-status granted";
    ok = true;
  } else {
    statusElement.textContent = translate("settings.accessibility.denied");
    statusElement.className = "permission-status denied";
  }

  // Once granted there's nothing to act on, so hide the check button.
  document.getElementById("checkAccessibility")?.classList.toggle("hidden", ok);
}

function scheduleAccessibilityRecheck() {
  if (!pendingAccessibilityRecheck) {
    return;
  }

  if (accessibilityRecheckTimer) {
    window.clearTimeout(accessibilityRecheckTimer);
  }

  accessibilityRecheckTimer = window.setTimeout(() => {
    accessibilityRecheckTimer = null;
    pendingAccessibilityRecheck = false;
    void recheckAccessibilityPermission();
  }, 400);
}

async function requestAccessibilityPermission() {
  if (!ipc) {
    return null;
  }

  const statusElement = document.getElementById("accessibilityStatus");
  if (!statusElement) {
    return null;
  }

  try {
    statusElement.textContent = translate("settings.accessibility.rechecking");
    statusElement.className = "permission-status";

    const result = await ipc.invoke("request-accessibility-permission");
    renderAccessibilityStatus(result);
    return result;
  } catch (error) {
    console.error("Failed to request accessibility permission:", error);
    renderAccessibilityStatus(null);
    return null;
  }
}

async function handleAccessibilityPermission() {
  const result = await requestAccessibilityPermission();
  if (!result || result.granted || result.status === "not_required") {
    return;
  }

  try {
    pendingAccessibilityRecheck = true;
    await ipc.invoke("show-permission-dialog");
  } catch (error) {
    pendingAccessibilityRecheck = false;
    console.error("Failed to open accessibility settings:", error);
  }
}

function setupShortcutSync() {
  if (shortcutSyncBound || !ipc) {
    return;
  }

  shortcutSyncBound = true;
  ipc.on("shortcut-updated", (_event, payload) => {
    if (!payload || !payload.recordShortcut) {
      return;
    }

    const shortcutSelect = document.getElementById("shortcutSelect");
    setSelectValue(shortcutSelect, payload.recordShortcut, "Ctrl+Shift");
  });
}

function setupThemeSync() {
  if (themeSyncBound || !ipc) {
    return;
  }

  themeSyncBound = true;
  ipc.on("ui-theme-updated", (_event, payload) => {
    if (!payload) {
      return;
    }

    applyTheme(payload.theme);
    setSelectValue(document.getElementById("themeSelect"), normalizeThemePref(payload.theme), "elegant");
  });
}

async function checkMicrophonePermissionStatus() {
  if (!ipc) {
    return;
  }

  const statusElement = document.getElementById("permissionStatus");
  if (!statusElement) {
    return;
  }

  const micButton = document.getElementById("checkPermission");
  try {
    statusElement.textContent = translate("settings.permission.checking");
    statusElement.className = "permission-status";

    const result = await ipc.invoke("check-microphone-permission");
    const status = result.status;
    let ok = false;

    if (status === "granted") {
      statusElement.textContent = translate("settings.permission.granted");
      statusElement.className = "permission-status granted";
      ok = true;
    } else if (status === "not-determined") {
      statusElement.textContent = translate("settings.permission.notDetermined");
      statusElement.className = "permission-status";
    } else if (status === "restricted") {
      statusElement.textContent = translate("settings.permission.restricted");
      statusElement.className = "permission-status denied";
    } else {
      statusElement.textContent = translate("settings.permission.denied");
      statusElement.className = "permission-status denied";
    }
    micButton?.classList.toggle("hidden", ok);
  } catch (error) {
    console.error("Failed to check microphone permission:", error);
    statusElement.textContent = translate("settings.permission.error");
    statusElement.className = "permission-status denied";
    micButton?.classList.remove("hidden");
  }
}

async function requestMicrophonePermission() {
  try {
    const current = await ipc.invoke("check-microphone-permission");
    if (current?.status === "denied" || current?.status === "restricted") {
      await ipc.invoke("open-microphone-settings");
    } else if (
      current?.status !== "granted" &&
      navigator.mediaDevices?.getUserMedia
    ) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    }
  } catch (error) {
    console.warn("Microphone permission action failed:", error);
  }
  await checkMicrophonePermissionStatus();
}

async function checkAccessibilityStatus() {
  if (!ipc) {
    return null;
  }

  const statusElement = document.getElementById("accessibilityStatus");
  if (!statusElement) {
    return null;
  }

  try {
    statusElement.textContent = translate("settings.permission.checking");
    statusElement.className = "permission-status";

    const result = await ipc.invoke("check-accessibility-permission");
    renderAccessibilityStatus(result);
    return result;
  } catch (error) {
    console.error("Failed to check accessibility permission:", error);
    renderAccessibilityStatus(null);
    return null;
  }
}

// Same full recheck (backend state sync + hotkey restart on grant), but
// without the "rechecking…" placeholder write — safe to run on every focus /
// broadcast without making the status line flicker. Errors keep whatever is
// currently shown rather than degrading it to the error state.
async function refreshAccessibilityQuietly() {
  if (!ipc) {
    return;
  }
  try {
    renderAccessibilityStatus(await ipc.invoke("recheck-accessibility-permission"));
  } catch (error) {
    console.error("Failed to refresh accessibility permission:", error);
  }
}

async function recheckAccessibilityPermission() {
  if (!ipc) {
    return null;
  }

  const statusElement = document.getElementById("accessibilityStatus");
  if (!statusElement) {
    return null;
  }

  try {
    statusElement.textContent = translate("settings.accessibility.rechecking");
    statusElement.className = "permission-status";

    const result = await ipc.invoke("recheck-accessibility-permission");
    renderAccessibilityStatus(result);
    return result;
  } catch (error) {
    console.error("Failed to recheck accessibility permission:", error);
    renderAccessibilityStatus(null);
    return null;
  }
}

async function loadSettings() {
  await initializeDependencies();

  try {
    currentSettings = await ipc.invoke("get-settings");
    // Raw API keys come from a dedicated command — get_settings never ships
    // them to general readers. The main window fetches them only because it now
    // owns the Settings editor; input-prompt and other windows stay blocked.
    // Shares fate with the get-settings call above: if the config is readable
    // for one it is for the other, so this won't leave the key fields blank
    // (which a subsequent Save would persist as cleared keys).
    const apiKeys = await ipc.invoke("get-api-keys");
    initI18n(currentSettings.uiLanguage);
    applyTheme(currentSettings.uiTheme);

    const provider = currentSettings.provider || "groq";
    const providerChoice = providerForSettings(currentSettings);
    const providerSelect = document.getElementById("providerSelect");
    const shortcutSelect = document.getElementById("shortcutSelect");
    const uiLanguageSelect = document.getElementById("uiLanguageSelect");
    const themeSelect = document.getElementById("themeSelect");
    const languageSelect = document.getElementById("languageSelect");
    const modelSelect = document.getElementById("modelSelect");
    const autoLaunchCheck = document.getElementById("autoLaunchCheck");
    const startMinimizedCheck = document.getElementById("startMinimizedCheck");
    const apiKeyGroq = document.getElementById("apiKeyGroq");
    const apiKeyOpenAI = document.getElementById("apiKeyOpenAI");

    setSelectValue(providerSelect, providerChoice, "groq");
    if (provider !== "local") {
      updateModelOptions(provider);
    }
    toggleProviderFields(providerChoice);

    if (apiKeyGroq) {
      apiKeyGroq.value = apiKeys.apiKeyGroq || apiKeys.apiKey || "";
    }
    if (apiKeyOpenAI) {
      apiKeyOpenAI.value = apiKeys.apiKeyOpenAI || "";
    }

    setSelectValue(shortcutSelect, currentSettings.shortcut || "Ctrl+Shift", "Ctrl+Shift");
    setSelectValue(uiLanguageSelect, currentSettings.uiLanguage || "auto", "auto");
    setSelectValue(themeSelect, normalizeThemePref(currentSettings.uiTheme), "elegant");
    setSelectValue(languageSelect, currentSettings.language || "auto", "auto");
    if (provider !== "local") {
      setSelectValue(modelSelect, currentSettings.model, modelSelect?.options[0]?.value || "");
    }

    if (autoLaunchCheck) {
      autoLaunchCheck.checked = !!currentSettings.autoLaunch;
    }
    if (startMinimizedCheck) {
      startMinimizedCheck.checked = !!currentSettings.startMinimized;
    }

    await refreshLocalModelStatus();
    await Promise.all([
      checkMicrophonePermissionStatus(),
      checkAccessibilityStatus(),
    ]);

    clearDirty();
  } catch (error) {
    console.error("Failed to load settings:", error);
    initI18n("auto");
    applyTheme("elegant");
  }
}

async function saveSettings() {
  try {
    await initializeDependencies();

    const providerChoice = document.getElementById("providerSelect")?.value || "groq";
    const localModel = localModelForProvider(providerChoice);
    const provider = localModel ? "local" : providerChoice;
    if (localModel && localModelState !== "ready") {
      alert(translate("settings.localModel.notReady"));
      return;
    }
    const themeSelect = document.getElementById("themeSelect");
    const settings = {
      apiKeyGroq: document.getElementById("apiKeyGroq")?.value || "",
      apiKeyOpenAI: document.getElementById("apiKeyOpenAI")?.value || "",
      shortcut: document.getElementById("shortcutSelect")?.value || "Ctrl+Shift",
      language: document.getElementById("languageSelect")?.value || "auto",
      uiLanguage: document.getElementById("uiLanguageSelect")?.value || "auto",
      uiTheme: normalizeThemePref(themeSelect ? themeSelect.value : "elegant"),
      model: localModel || document.getElementById("modelSelect")?.value || "",
      microphone: currentSettings.microphone,
      autoLaunch: !!document.getElementById("autoLaunchCheck")?.checked,
      startMinimized: !!document.getElementById("startMinimizedCheck")?.checked,
      provider,
    };

    await ipc.invoke("save-settings", settings);
    currentSettings = settings;
    clearDirty();
    const saveButton = document.getElementById("saveSettingsButton");
    if (saveButton) {
      saveButton.textContent = translate("settings.saved");
      window.setTimeout(() => {
        saveButton.textContent = translate("settings.save");
      }, 1400);
    }
  } catch (error) {
    console.error("Failed to save settings:", error);
    alert(translate("settings.saveError"));
  }
}

async function discardSettings() {
  // Revert unsaved controls plus the live theme/language preview. Settings is
  // now a normal page, so discarding stays on the page instead of closing it.
  try {
    await loadSettings();
  } catch (error) {
    console.error("Failed to discard settings changes:", error);
  }
  clearDirty();
}

async function initializeSettingsPage() {
  if (settingsInitialized) {
    return;
  }

  await initializeDependencies();
  bindEventHandlers();
  setupShortcutSync();
  setupThemeSync();
  setupLocalModelSync();
  setupDiagnosticLogPanel();
  void setupUpdatesPanel();
  await loadSettings();
  activateSettingsTab(activeSettingsTab);
  settingsInitialized = true;
  document.documentElement.setAttribute("data-settings-bootstrap-complete", "1");
}

async function showSettings(target = null) {
  const wasInitialized = settingsInitialized;
  try {
    await initializeSettingsPage();
    if (wasInitialized && !settingsDirty) {
      await loadSettings();
    }

    if (typeof target === "string" && target.startsWith("local-model")) {
      activateSettingsTab("transcription");
      const model = target.split(":", 2)[1] || NEMOTRON_LOCAL_MODEL;
      revealLocalModelPanel(model);
      return;
    }

    activateSettingsTab(SETTINGS_TABS.includes(target) ? target : activeSettingsTab);
  } catch (error) {
    console.error("Failed to initialize settings page:", error);
    document.documentElement.setAttribute(
      "data-settings-bootstrap-error",
      String(error?.message || error)
    );
  }
}

async function confirmLeave() {
  if (!settingsDirty) {
    return true;
  }
  if (!window.confirm(translate("settings.discardConfirm"))) {
    return false;
  }
  await discardSettings();
  return true;
}

window.SayTypeSettings = {
  show: showSettings,
  confirmLeave,
  hasUnsavedChanges: () => settingsDirty,
  save: saveSettings,
  discard: discardSettings,
};

document.documentElement.setAttribute("data-settings-handlers-exposed", "1");
})();
