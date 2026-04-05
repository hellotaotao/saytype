const { ipcRenderer } = require("electron");
const { initI18n, setLanguage, applyI18n, t } = window.WhispLineI18n;

const themeOptions = new Set(["midnight", "elegant"]);

// Define available models per API provider
const modelOptions = {
  groq: [
    { value: "whisper-large-v3", labelKey: "settings.model.options.whisperLargeV3" },
    { value: "whisper-large-v3-turbo", labelKey: "settings.model.options.whisperLargeV3Turbo" }
  ],
  openai: [
    { value: "whisper-1", labelKey: "settings.model.options.whisper1" },
    { value: "gpt-4o-transcribe", labelKey: "settings.model.options.gpt4oTranscribe" },
    { value: "gpt-4o-mini-transcribe", labelKey: "settings.model.options.gpt4oMiniTranscribe" }
  ]
};

// Update model dropdown based on selected provider
function updateModelOptions(provider) {
  const select = document.getElementById("modelSelect");
  select.innerHTML = "";
  (modelOptions[provider] || []).forEach((opt) => {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.labelKey ? t(opt.labelKey) : opt.label || opt.value;
    select.appendChild(option);
  });
}

function toggleApiKeyVisibility(provider) {
  const keyGroq = document.getElementById("apiKeyGroq");
  const keyOpenAI = document.getElementById("apiKeyOpenAI");
  if (!keyGroq || !keyOpenAI) return;
  if (provider === "openai") {
    keyGroq.classList.add("hidden");
    keyOpenAI.classList.remove("hidden");
  } else {
    keyOpenAI.classList.add("hidden");
    keyGroq.classList.remove("hidden");
  }
}

function resolveTheme(value) {
  return themeOptions.has(value) ? value : "elegant";
}

function applyTheme(value) {
  const resolved = resolveTheme(value);
  document.documentElement.setAttribute("data-theme", resolved);
}

let currentSettings = {};

async function loadSettings() {
  try {
    currentSettings = await ipcRenderer.invoke("get-settings");
    initI18n(currentSettings.uiLanguage);
    applyTheme(currentSettings.uiTheme);
    // Initialize provider and models
    const providerSelect = document.getElementById("providerSelect");
    providerSelect.value = currentSettings.provider || "groq";
    updateModelOptions(providerSelect.value);
    // Toggle which API key input is visible for current provider
    if (typeof toggleApiKeyVisibility === "function") {
      toggleApiKeyVisibility(providerSelect.value);
    }

    const apiKeyGroq = document.getElementById("apiKeyGroq");
    const apiKeyOpenAI = document.getElementById("apiKeyOpenAI");
    apiKeyGroq.value =
      currentSettings.apiKeyGroq || currentSettings.apiKey || "";
    apiKeyOpenAI.value = currentSettings.apiKeyOpenAI || "";

    const shortcutSelect = document.getElementById("shortcutSelect");
    if (shortcutSelect) {
      const shortcutValue = currentSettings.shortcut || "Ctrl+Shift";
      const hasOption = Array.from(shortcutSelect.options).some(
        (opt) => opt.value === shortcutValue
      );
      shortcutSelect.value = hasOption ? shortcutValue : "Ctrl+Shift";
    }

    const uiLanguageSelect = document.getElementById("uiLanguageSelect");
    if (uiLanguageSelect) {
      const uiLanguageValue = currentSettings.uiLanguage || "auto";
      const hasOption = Array.from(uiLanguageSelect.options).some(
        (opt) => opt.value === uiLanguageValue
      );
      uiLanguageSelect.value = hasOption ? uiLanguageValue : "auto";
      uiLanguageSelect.addEventListener("change", () => {
        setLanguage(uiLanguageSelect.value);
        applyI18n(document);
        checkMicrophonePermissionStatus();
        checkAccessibilityStatus();
      });
    }

    const themeSelect = document.getElementById("themeSelect");
    if (themeSelect) {
      const themeValue = resolveTheme(currentSettings.uiTheme);
      const hasOption = Array.from(themeSelect.options).some(
        (opt) => opt.value === themeValue
      );
      themeSelect.value = hasOption ? themeValue : "elegant";
      themeSelect.addEventListener("change", () => {
        applyTheme(themeSelect.value);
      });
    }

    // Set the selected language
    const languageSelect = document.getElementById("languageSelect");
    if (currentSettings.language) {
      languageSelect.value = currentSettings.language;
    }

    // Set the selected model
    const modelSelect = document.getElementById("modelSelect");
    if (currentSettings.model) modelSelect.value = currentSettings.model;

    // Configure auto-launch and start-minimized controls
    const autoLaunchCheck = document.getElementById("autoLaunchCheck");
    const startMinimizedCheck = document.getElementById("startMinimizedCheck");
    autoLaunchCheck.checked = currentSettings.autoLaunch;
    startMinimizedCheck.checked = currentSettings.startMinimized;

    // Check initial permission status
    await checkMicrophonePermissionStatus();
    await checkAccessibilityStatus();
    setupShortcutSync();
  } catch (error) {
    console.error("Failed to load settings:", error);
    initI18n("auto");
    applyTheme("elegant");
  }
}

function setupShortcutSync() {
  ipcRenderer.on("shortcut-updated", (event, payload) => {
    if (!payload || !payload.recordShortcut) {
      return;
    }
    const shortcutSelect = document.getElementById("shortcutSelect");
    if (!shortcutSelect) {
      return;
    }
    const hasOption = Array.from(shortcutSelect.options).some(
      (opt) => opt.value === payload.recordShortcut
    );
    shortcutSelect.value = hasOption ? payload.recordShortcut : "Ctrl+Shift";
  });
}

async function checkMicrophonePermissionStatus() {
  const statusElement = document.getElementById("permissionStatus");
  try {
    statusElement.textContent = t("settings.permission.checking");
    statusElement.className = "permission-status";

    const result = await ipcRenderer.invoke("check-microphone-permission");
    const status = result.status; // "granted" | "denied" | "restricted" | "not-determined"

    if (status === "granted" || status === "not-determined") {
      statusElement.textContent = t("settings.permission.granted");
      statusElement.className = "permission-status granted";
    } else if (status === "restricted") {
      statusElement.textContent = t("settings.permission.restricted");
      statusElement.className = "permission-status denied";
    } else {
      statusElement.textContent = t("settings.permission.denied");
      statusElement.className = "permission-status denied";
    }
  } catch (error) {
    console.error("Failed to check microphone permission:", error);
    statusElement.textContent = t("settings.permission.error");
    statusElement.className = "permission-status denied";
  }
}

async function checkAccessibilityStatus() {
  try {
    const statusElement = document.getElementById("accessibilityStatus");
    statusElement.textContent = t("settings.permission.checking");
    statusElement.className = "permission-status";

    const result = await ipcRenderer.invoke(
      "check-accessibility-permission"
    );

    let statusText, statusClass;
    if (result.granted) {
      statusText = t("settings.accessibility.granted");
      statusClass = "granted";
    } else if (result.status === "not_required") {
      statusText = t("settings.accessibility.notRequired");
      statusClass = "granted";
    } else {
      statusText = t("settings.accessibility.denied");
      statusClass = "denied";
    }

    statusElement.textContent = statusText;
    statusElement.className = `permission-status ${statusClass}`;
  } catch (error) {
    console.error("Failed to check accessibility permission:", error);
    const statusElement = document.getElementById("accessibilityStatus");
    statusElement.textContent = t("settings.permission.error");
    statusElement.className = "permission-status denied";
  }
}

async function recheckAccessibilityPermission() {
  try {
    const statusElement = document.getElementById("accessibilityStatus");
    statusElement.textContent = t("settings.accessibility.rechecking");
    statusElement.className = "permission-status";

    const result = await ipcRenderer.invoke(
      "recheck-accessibility-permission"
    );

    let statusText, statusClass;
    if (result.granted) {
      statusText = t("settings.accessibility.granted");
      statusClass = "granted";
    } else {
      statusText = t("settings.accessibility.denied");
      statusClass = "denied";
    }

    statusElement.textContent = statusText;
    statusElement.className = `permission-status ${statusClass}`;
  } catch (error) {
    console.error("Failed to recheck accessibility permission:", error);
    const statusElement = document.getElementById("accessibilityStatus");
    statusElement.textContent = t("settings.permission.error");
    statusElement.className = "permission-status denied";
  }
}

async function saveSettings() {
  try {
    const provider = document.getElementById("providerSelect").value;
    const themeSelect = document.getElementById("themeSelect");
    const settings = {
      apiKeyGroq: document.getElementById("apiKeyGroq").value,
      apiKeyOpenAI: document.getElementById("apiKeyOpenAI").value,
      shortcut: document.getElementById("shortcutSelect").value,
      language: document.getElementById("languageSelect").value,
      uiLanguage: document.getElementById("uiLanguageSelect").value,
      uiTheme: resolveTheme(themeSelect ? themeSelect.value : "elegant"),
      model: document.getElementById("modelSelect").value,
      microphone: currentSettings.microphone,
      autoLaunch: document.getElementById("autoLaunchCheck").checked,
      startMinimized: document.getElementById("startMinimizedCheck").checked,
      provider
    };

    await ipcRenderer.invoke("save-settings", settings);
    window.close();
  } catch (error) {
    console.error("Failed to save settings:", error);
    alert(t("settings.saveError"));
  }
}

function closeSettings() {
  window.close();
}

// Load settings when page loads
document.addEventListener("DOMContentLoaded", loadSettings);

// Listen to provider changes
document.getElementById("providerSelect").addEventListener("change", (e) => {
  updateModelOptions(e.target.value);
  if (typeof toggleApiKeyVisibility === "function") {
    toggleApiKeyVisibility(e.target.value);
  }
});

// Permission check buttons
document
  .getElementById("checkPermission")
  .addEventListener("click", checkMicrophonePermissionStatus);

document
  .getElementById("checkAccessibility")
  .addEventListener("click", recheckAccessibilityPermission);

ipcRenderer.on("ui-theme-updated", (event, payload) => {
  if (!payload) return;
  applyTheme(payload.theme);
  const themeSelect = document.getElementById("themeSelect");
  if (themeSelect) {
    themeSelect.value = resolveTheme(payload.theme);
  }
});

// Sidebar navigation
document.querySelectorAll(".sidebar-item").forEach((item) => {
  item.addEventListener("click", () => {
    document
      .querySelectorAll(".sidebar-item")
      .forEach((i) => i.classList.remove("active"));
    item.classList.add("active");

    const target = item.getAttribute("data-section");
    document
      .querySelectorAll(".content-section")
      .forEach((sec) => sec.classList.remove("active"));
    const content = document.getElementById(`section-${target}`);
    if (content) content.classList.add("active");
  });
});
