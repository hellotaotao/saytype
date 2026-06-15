document.documentElement.setAttribute("data-main-js-ran", "1");

const ipc = window.__WHISPLINE_IPC__;
const { initI18n, setLanguage, applyI18n, t, getLocale } = window.WhispLineI18n;
let lastRecordShortcut = "Ctrl+Shift";
let lastTranslateShortcut = "Shift+Alt";
const themeOptions = new Set(["midnight", "elegant"]);

function resolveTheme(value) {
  return themeOptions.has(value) ? value : "elegant";
}

function applyTheme(value) {
  document.documentElement.setAttribute("data-theme", resolveTheme(value));
}

async function initializeMainPage() {
  // The entry script runs twice (the <script> tag plus the Rust on-page-load
  // injection); guard so listeners and data loads are only wired up once.
  if (window.__sayTypeMainStarted) {
    return;
  }
  window.__sayTypeMainStarted = true;

  let settings = null;
  try {
    settings = await ipc.invoke("get-settings");
  } catch (error) {
    console.error("Failed to load settings for i18n:", error);
  }

  initI18n(settings?.uiLanguage);
  applyTheme(settings?.uiTheme);
  await loadActivities();
  await loadDictionary();
  await loadShortcutHints();

  try {
    const version = await ipc.invoke("get-app-version");
    const element = document.getElementById("appVersion");
    if (element) {
      element.textContent = `v${version} · Tauri`;
    }
  } catch (error) {
    console.error("Failed to load app version", error);
  }

  ipc.on("activity-updated", async () => {
    await loadActivities();
  });

  ipc.on("accessibility-permission-changed", (_event, data) => {
    showNotification(data.message, data.granted ? "success" : "warning");
  });

  ipc.on("shortcut-updated", (_event, payload) => {
    if (!payload) {
      return;
    }
    updateShortcutHints(payload.recordShortcut, payload.translateShortcut);
  });

  ipc.on("ui-language-updated", async (_event, payload) => {
    if (!payload) {
      return;
    }
    setLanguage(payload.language);
    applyI18n(document);
    updateShortcutHints(lastRecordShortcut, lastTranslateShortcut);
    await loadActivities();
  });

  ipc.on("ui-theme-updated", (_event, payload) => {
    if (!payload) {
      return;
    }
    applyTheme(payload.theme);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void initializeMainPage();
  }, { once: true });
} else {
  void initializeMainPage();
}

async function loadShortcutHints() {
  try {
    const settings = await ipc.invoke("get-settings");
    updateShortcutHints(settings.shortcut, settings.translateShortcut);
  } catch (error) {
    console.error("Failed to load shortcuts:", error);
    updateShortcutHints("Ctrl+Shift", "Shift+Alt");
  }
}

function formatShortcutLabel(shortcut) {
  if (!shortcut) {
    return "";
  }
  const isMac = window.navigator?.platform?.includes("Mac");
  const label = shortcut.replace(/\+/g, " + ");
  return isMac ? label.replace(/Alt/g, "Option") : label;
}

function updateShortcutHints(recordShortcut, translateShortcut) {
  const recordHint = document.getElementById("recordShortcutHint");
  const translateHint = document.getElementById("translateShortcutHint");
  const recordLabel = formatShortcutLabel(recordShortcut || "Ctrl+Shift");
  const translateLabel = formatShortcutLabel(translateShortcut || "Shift+Alt");
  lastRecordShortcut = recordShortcut || lastRecordShortcut;
  lastTranslateShortcut = translateShortcut || lastTranslateShortcut;

  if (recordHint) {
    recordHint.textContent = t("home.recordHint", { shortcut: recordLabel });
  }
  if (translateHint) {
    translateHint.textContent = t("home.translateHint", { shortcut: translateLabel });
  }
}

function showPage(pageId) {
  document.querySelectorAll(".page").forEach((page) => {
    page.classList.remove("active");
  });

  document.getElementById(`${pageId}-page`).classList.add("active");

  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.remove("active");
  });

  const clickEvent = window.event;
  clickEvent?.target?.closest(".nav-item")?.classList.add("active");
}

async function loadDictionary() {
  try {
    const dictionary = await ipc.invoke("get-dictionary");
    document.getElementById("dictionary-text").value = dictionary || "";
  } catch (error) {
    console.error("Error loading dictionary:", error);
  }
}

async function saveDictionary() {
  const text = document.getElementById("dictionary-text").value;
  try {
    await ipc.invoke("save-dictionary", text);
    const button = document.querySelector(".dictionary-actions .btn");
    const originalText = button.textContent;
    button.textContent = t("dictionary.saved");
    setTimeout(() => {
      button.textContent = originalText;
    }, 2000);
  } catch (error) {
    console.error("Error saving dictionary:", error);
    alert(t("dictionary.saveError", { message: error.message }));
  }
}

async function loadActivities() {
  try {
    const activities = await ipc.invoke("get-recent-activities");
    displayActivities(activities);
  } catch (error) {
    console.error("Error loading activities:", error);
  }
}

function displayActivities(activities) {
  const container = document.getElementById("activity-container");
  if (!container) {
    return;
  }

  if (!Array.isArray(activities) || activities.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = t("home.noActivity");
    container.replaceChildren(empty);
    return;
  }

  container.replaceChildren();

  const header = document.createElement("div");
  header.className = "section-header";
  const headerTitle = document.createElement("h4");
  headerTitle.textContent = t("home.recentHeader");
  header.appendChild(headerTitle);
  container.appendChild(header);

  activities.forEach((activity) => {
    const locale = getLocale();
    const time = new Date(activity.timestamp).toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: locale === "en-US",
    });

    const rawText = (activity.text ?? "").toString();

    const item = document.createElement("div");
    item.className = "activity-item";

    const content = document.createElement("div");
    content.className = "activity-content";

    const timeElement = document.createElement("div");
    timeElement.className = "activity-time";
    timeElement.textContent = time;

    const textElement = document.createElement("div");
    textElement.className = "activity-text";
    textElement.textContent = rawText;

    const button = document.createElement("button");
    button.className = "copy-btn";
    button.type = "button";
    button.title = t("activity.copyTitle");
    button.addEventListener("click", () => {
      copyToClipboard(rawText, button);
    });

    const icon = document.createElement("span");
    icon.className = "material-icons";
    icon.textContent = "content_copy";

    content.appendChild(timeElement);
    content.appendChild(textElement);
    button.appendChild(icon);
    item.appendChild(content);
    item.appendChild(button);
    container.appendChild(item);
  });
}

function exploreUseCases() {
  console.log("Explore use cases clicked");
}

function openSettings() {
  ipc.invoke("open-settings");
}

async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);

    const icon = button.querySelector(".material-icons");
    const originalText = icon.textContent;
    icon.textContent = "check";
    button.style.color = "var(--status-success)";

    setTimeout(() => {
      icon.textContent = originalText;
      button.style.color = "";
    }, 2000);
  } catch (error) {
    console.error("Failed to copy text:", error);

    const icon = button.querySelector(".material-icons");
    const originalText = icon.textContent;
    icon.textContent = "error";
    button.style.color = "var(--status-danger)";

    setTimeout(() => {
      icon.textContent = originalText;
      button.style.color = "";
    }, 2000);
  }
}

function showNotification(message, type = "info") {
  const notification = document.createElement("div");
  notification.className = `notification notification-${type}`;
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: ${type === "success" ? "var(--status-success)" : type === "warning" ? "var(--status-warning)" : "var(--status-info)"};
    color: white;
    padding: 16px 20px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 10000;
    max-width: 400px;
    font-size: 14px;
    opacity: 0;
    transform: translateX(100%);
    transition: all 0.3s ease;
  `;
  notification.textContent = message;

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.opacity = "1";
    notification.style.transform = "translateX(0)";
  }, 100);

  setTimeout(() => {
    notification.style.opacity = "0";
    notification.style.transform = "translateX(100%)";
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 300);
  }, 5000);
}

window.showPage = showPage;
window.saveDictionary = saveDictionary;
window.exploreUseCases = exploreUseCases;
window.openSettings = openSettings;