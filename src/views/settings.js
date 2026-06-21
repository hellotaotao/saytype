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
let currentThemePref = "elegant";

const modelOptions = {
  groq: [
    { value: "whisper-large-v3", labelKey: "settings.model.options.whisperLargeV3" },
    { value: "whisper-large-v3-turbo", labelKey: "settings.model.options.whisperLargeV3Turbo" },
  ],
  openai: [
    { value: "whisper-1", labelKey: "settings.model.options.whisper1" },
    { value: "gpt-4o-transcribe", labelKey: "settings.model.options.gpt4oTranscribe" },
    { value: "gpt-4o-mini-transcribe", labelKey: "settings.model.options.gpt4oMiniTranscribe" },
  ],
};

let currentSettings = {};
let pageEventsBound = false;
let shortcutSyncBound = false;
let themeSyncBound = false;
let pendingAccessibilityRecheck = false;
let accessibilityRecheckTimer = null;

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
    option.textContent = opt.labelKey ? translate(opt.labelKey) : opt.label || opt.value;
    select.appendChild(option);
  });
}

function toggleApiKeyVisibility(provider) {
  const fieldGroq = document.getElementById("apiKeyFieldGroq");
  const fieldOpenAI = document.getElementById("apiKeyFieldOpenAI");
  if (!fieldGroq || !fieldOpenAI) {
    return;
  }

  if (provider === "openai") {
    fieldGroq.classList.add("hidden");
    fieldOpenAI.classList.remove("hidden");
  } else {
    fieldOpenAI.classList.add("hidden");
    fieldGroq.classList.remove("hidden");
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
  document.getElementById("unsavedHint")?.classList.remove("hidden");
}

function clearDirty() {
  document.getElementById("unsavedHint")?.classList.add("hidden");
}

function setSelectValue(element, value, fallback) {
  if (!element) {
    return;
  }

  const hasOption = Array.from(element.options).some((option) => option.value === value);
  element.value = hasOption ? value : fallback;
}

function handleProviderChange(event) {
  const provider = event.target.value || "groq";
  updateModelOptions(provider);
  toggleApiKeyVisibility(provider);
}

function handleThemeChange(event) {
  applyTheme(event.target.value);
}

function handleUiLanguageChange(event) {
  setLanguage(event.target.value);
  applyI18n(document);
  void checkMicrophonePermissionStatus();
  void checkAccessibilityStatus();
}

function handleSidebarClick(event) {
  const item = event.currentTarget;
  document.querySelectorAll(".sidebar-item").forEach((node) => {
    node.classList.remove("active");
  });
  item.classList.add("active");

  const target = item.getAttribute("data-section");
  document.querySelectorAll(".content-section").forEach((section) => {
    section.classList.remove("active");
  });

  const content = document.getElementById(`section-${target}`);
  if (content) {
    content.classList.add("active");
  }
}

function bindEventHandlers() {
  if (pageEventsBound) {
    return;
  }

  watchSystemTheme();

  const providerSelect = document.getElementById("providerSelect");
  const checkPermissionButton = document.getElementById("checkPermission");
  const checkAccessibilityButton = document.getElementById("checkAccessibility");
  const closeSettingsButton = document.getElementById("closeSettingsButton");
  const saveSettingsButton = document.getElementById("saveSettingsButton");
  const uiLanguageSelect = document.getElementById("uiLanguageSelect");
  const themeSelect = document.getElementById("themeSelect");

  providerSelect?.addEventListener("change", handleProviderChange);
  checkPermissionButton?.addEventListener("click", () => {
    void checkMicrophonePermissionStatus();
  });
  checkAccessibilityButton?.addEventListener("click", () => {
    void handleAccessibilityPermission();
  });
  closeSettingsButton?.addEventListener("click", () => {
    void cancelSettings();
  });
  saveSettingsButton?.addEventListener("click", () => {
    void saveSettings();
  });
  uiLanguageSelect?.addEventListener("change", handleUiLanguageChange);
  themeSelect?.addEventListener("change", handleThemeChange);

  document.querySelectorAll(".reveal-btn").forEach((button) => {
    button.addEventListener("click", () => toggleKeyReveal(button));
  });

  // Any edit to a control marks the page dirty so the unsaved hint shows.
  // Programmatic value changes during loadSettings() don't fire these events.
  const mainContent = document.querySelector(".main-content");
  mainContent?.addEventListener("input", markDirty);
  mainContent?.addEventListener("change", markDirty);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void cancelSettings();
    }
  });

  window.addEventListener("focus", () => {
    scheduleAccessibilityRecheck();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleAccessibilityRecheck();
    }
  });

  document.querySelectorAll(".sidebar-item").forEach((item) => {
    item.addEventListener("click", handleSidebarClick);
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

    if (status === "granted" || status === "not-determined") {
      statusElement.textContent = translate("settings.permission.granted");
      statusElement.className = "permission-status granted";
      ok = true;
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
    initI18n(currentSettings.uiLanguage);
    applyTheme(currentSettings.uiTheme);

    const provider = currentSettings.provider || "groq";
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

    setSelectValue(providerSelect, provider, "groq");
    updateModelOptions(provider);
    toggleApiKeyVisibility(provider);

    if (apiKeyGroq) {
      apiKeyGroq.value = currentSettings.apiKeyGroq || currentSettings.apiKey || "";
    }
    if (apiKeyOpenAI) {
      apiKeyOpenAI.value = currentSettings.apiKeyOpenAI || "";
    }

    setSelectValue(shortcutSelect, currentSettings.shortcut || "Ctrl+Shift", "Ctrl+Shift");
    setSelectValue(uiLanguageSelect, currentSettings.uiLanguage || "auto", "auto");
    setSelectValue(themeSelect, normalizeThemePref(currentSettings.uiTheme), "elegant");
    setSelectValue(languageSelect, currentSettings.language || "auto", "auto");
    setSelectValue(modelSelect, currentSettings.model, modelSelect?.options[0]?.value || "");

    if (autoLaunchCheck) {
      autoLaunchCheck.checked = !!currentSettings.autoLaunch;
    }
    if (startMinimizedCheck) {
      startMinimizedCheck.checked = !!currentSettings.startMinimized;
    }

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

    const provider = document.getElementById("providerSelect")?.value || "groq";
    const themeSelect = document.getElementById("themeSelect");
    const settings = {
      apiKeyGroq: document.getElementById("apiKeyGroq")?.value || "",
      apiKeyOpenAI: document.getElementById("apiKeyOpenAI")?.value || "",
      shortcut: document.getElementById("shortcutSelect")?.value || "Ctrl+Shift",
      language: document.getElementById("languageSelect")?.value || "auto",
      uiLanguage: document.getElementById("uiLanguageSelect")?.value || "auto",
      uiTheme: normalizeThemePref(themeSelect ? themeSelect.value : "elegant"),
      model: document.getElementById("modelSelect")?.value || "",
      microphone: currentSettings.microphone,
      autoLaunch: !!document.getElementById("autoLaunchCheck")?.checked,
      startMinimized: !!document.getElementById("startMinimizedCheck")?.checked,
      provider,
    };

    await ipc.invoke("save-settings", settings);
    currentSettings = settings;
    clearDirty();
    await closeSettings();
  } catch (error) {
    console.error("Failed to save settings:", error);
    alert(translate("settings.saveError"));
  }
}

async function cancelSettings() {
  // Revert any unsaved edits — control values plus the live theme/language
  // preview — back to the last saved settings, then hide the window.
  try {
    await loadSettings();
  } catch (error) {
    console.error("Failed to revert settings on cancel:", error);
  }
  clearDirty();
  await closeSettings();
}

async function closeSettings() {
  try {
    await initializeDependencies();
    await ipc.invoke("close-settings");
  } catch (error) {
    console.error("Failed to close settings:", error);
  }
}

window.closeSettings = closeSettings;
window.cancelSettings = cancelSettings;
window.saveSettings = saveSettings;
if (typeof document !== "undefined" && document.documentElement) {
  document.documentElement.setAttribute("data-settings-handlers-exposed", "1");
}

async function bootstrapSettingsPage() {
  // The entry script runs twice (the <script> tag plus the Rust on-page-load
  // injection); guard so the page is only bootstrapped once.
  if (window.__sayTypeSettingsStarted) {
    return;
  }
  window.__sayTypeSettingsStarted = true;

  try {
    if (document?.documentElement) {
      document.documentElement.setAttribute("data-settings-bootstrap-started", "1");
    }
    await initializeDependencies();
    bindEventHandlers();
    setupShortcutSync();
    setupThemeSync();
    await loadSettings();
    if (document?.documentElement) {
      document.documentElement.setAttribute("data-settings-bootstrap-complete", "1");
    }
  } catch (error) {
    console.error("Failed to initialize settings page:", error);
    if (document?.documentElement) {
      document.documentElement.setAttribute(
        "data-settings-bootstrap-error",
        String(error?.message || error)
      );
    }
    applyTheme("elegant");
    const fallbackI18n = window.SayTypeI18n;
    if (fallbackI18n && typeof fallbackI18n.initI18n === "function") {
      fallbackI18n.initI18n("auto");
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void bootstrapSettingsPage();
  }, { once: true });
} else {
  void bootstrapSettingsPage();
}