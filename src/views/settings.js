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
const themeOptions = new Set(["midnight", "elegant"]);

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

function resolveTheme(value) {
  return themeOptions.has(value) ? value : "elegant";
}

function applyTheme(value) {
  document.documentElement.setAttribute("data-theme", resolveTheme(value));
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
  const keyGroq = document.getElementById("apiKeyGroq");
  const keyOpenAI = document.getElementById("apiKeyOpenAI");
  if (!keyGroq || !keyOpenAI) {
    return;
  }

  if (provider === "openai") {
    keyGroq.classList.add("hidden");
    keyOpenAI.classList.remove("hidden");
  } else {
    keyOpenAI.classList.add("hidden");
    keyGroq.classList.remove("hidden");
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
    void closeSettings();
  });
  saveSettingsButton?.addEventListener("click", () => {
    void saveSettings();
  });
  uiLanguageSelect?.addEventListener("change", handleUiLanguageChange);
  themeSelect?.addEventListener("change", handleThemeChange);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void closeSettings();
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

  window.closeSettings = closeSettings;
  window.saveSettings = saveSettings;
  pageEventsBound = true;
}

function renderAccessibilityStatus(result) {
  const statusElement = document.getElementById("accessibilityStatus");
  if (!statusElement) {
    return;
  }

  if (!result) {
    statusElement.textContent = translate("settings.permission.error");
    statusElement.className = "permission-status denied";
    return;
  }

  if (result.granted) {
    statusElement.textContent = translate("settings.accessibility.granted");
    statusElement.className = "permission-status granted";
  } else if (result.status === "not_required") {
    statusElement.textContent = translate("settings.accessibility.notRequired");
    statusElement.className = "permission-status granted";
  } else {
    statusElement.textContent = translate("settings.accessibility.denied");
    statusElement.className = "permission-status denied";
  }
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
    setSelectValue(document.getElementById("themeSelect"), resolveTheme(payload.theme), "elegant");
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

  try {
    statusElement.textContent = translate("settings.permission.checking");
    statusElement.className = "permission-status";

    const result = await ipc.invoke("check-microphone-permission");
    const status = result.status;

    if (status === "granted" || status === "not-determined") {
      statusElement.textContent = translate("settings.permission.granted");
      statusElement.className = "permission-status granted";
    } else if (status === "restricted") {
      statusElement.textContent = translate("settings.permission.restricted");
      statusElement.className = "permission-status denied";
    } else {
      statusElement.textContent = translate("settings.permission.denied");
      statusElement.className = "permission-status denied";
    }
  } catch (error) {
    console.error("Failed to check microphone permission:", error);
    statusElement.textContent = translate("settings.permission.error");
    statusElement.className = "permission-status denied";
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
    const keepMicWarmCheck = document.getElementById("keepMicWarmCheck");
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
    setSelectValue(themeSelect, resolveTheme(currentSettings.uiTheme), "elegant");
    setSelectValue(languageSelect, currentSettings.language || "auto", "auto");
    setSelectValue(modelSelect, currentSettings.model, modelSelect?.options[0]?.value || "");

    if (autoLaunchCheck) {
      autoLaunchCheck.checked = !!currentSettings.autoLaunch;
    }
    if (startMinimizedCheck) {
      startMinimizedCheck.checked = !!currentSettings.startMinimized;
    }
    if (keepMicWarmCheck) {
      // Default ON when the field is absent (older configs).
      keepMicWarmCheck.checked = currentSettings.keepMicWarm !== false;
    }

    await Promise.all([
      checkMicrophonePermissionStatus(),
      checkAccessibilityStatus(),
    ]);
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
      uiTheme: resolveTheme(themeSelect ? themeSelect.value : "elegant"),
      model: document.getElementById("modelSelect")?.value || "",
      microphone: currentSettings.microphone,
      autoLaunch: !!document.getElementById("autoLaunchCheck")?.checked,
      startMinimized: !!document.getElementById("startMinimizedCheck")?.checked,
      keepMicWarm: document.getElementById("keepMicWarmCheck")?.checked !== false,
      provider,
    };

    await ipc.invoke("save-settings", settings);
    await closeSettings();
  } catch (error) {
    console.error("Failed to save settings:", error);
    alert(translate("settings.saveError"));
  }
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