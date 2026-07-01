document.documentElement.setAttribute("data-main-js-ran", "1");

const ipc = window.__SAYTYPE_IPC__;
const { initI18n, setLanguage, applyI18n, t, getLocale } = window.SayTypeI18n;

const THEME_PREFS = new Set(["auto", "midnight", "elegant"]);
const RECENT_LIMIT = 12;
let currentThemePref = "elegant";

let cachedSettings = null;
let cachedActivities = [];
let historyQuery = "";
let clearConfirming = false;
let clearConfirmTimer = null;

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

// Render each modifier as an OS-appropriate keycap: Apple glyphs on macOS,
// plain words (Ctrl/Shift/Alt/Win|Super) on Windows/Linux. Driven by the backend
// `os` field (get-settings), with a navigator fallback before settings load.
function shortcutKeycaps(shortcut) {
  const os = (cachedSettings?.os || "").toLowerCase();
  const isMac = os ? os === "macos" : /Mac/i.test(navigator.platform || "");
  const metaWord = os === "linux" ? "Super" : "Win";
  const macGlyphs = { ctrl: "⌃", control: "⌃", shift: "⇧", alt: "⌥", option: "⌥", cmd: "⌘", command: "⌘", meta: "⌘", super: "⌘", win: "⌘", windows: "⌘" };
  const textWords = { ctrl: "Ctrl", control: "Ctrl", shift: "Shift", alt: "Alt", option: "Alt", cmd: metaWord, command: metaWord, meta: metaWord, super: metaWord, win: metaWord, windows: metaWord };
  const map = isMac ? macGlyphs : textWords;
  return String(shortcut || "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => map[part.toLowerCase()] || part);
}

function hasApiKey(settings) {
  // The backend computes this (get_settings no longer ships the raw keys here).
  return !!settings?.hasApiKey;
}

async function initializeMainPage() {
  // The entry script runs twice (the <script> tag plus the Rust on-page-load
  // injection); guard so listeners and data loads are only wired up once.
  if (window.__sayTypeMainStarted) {
    return;
  }
  window.__sayTypeMainStarted = true;

  try {
    cachedSettings = await ipc.invoke("get-settings");
  } catch (error) {
    console.error("Failed to load settings for i18n:", error);
  }

  initI18n(cachedSettings?.uiLanguage);
  applyTheme(cachedSettings?.uiTheme);

  await loadActivities();
  await loadDictionary();
  await refreshReadiness();

  try {
    const version = await ipc.invoke("get-app-version");
    const element = document.getElementById("appVersion");
    if (element) {
      element.textContent = `v${version}`;
    }
  } catch (error) {
    console.error("Failed to load app version", error);
  }

  bindEvents();
}

function bindEvents() {
  watchSystemTheme();

  // Cmd+, (macOS standard "Preferences" shortcut) opens the settings window.
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === ",") {
      event.preventDefault();
      openSettings();
    }
  });

  document.getElementById("helpButton")?.addEventListener("click", showHelp);
  document.getElementById("clearHistoryBtn")?.addEventListener("click", handleClearHistory);
  document.getElementById("historySearch")?.addEventListener("input", (event) => {
    historyQuery = event.target.value.trim().toLowerCase();
    renderHistory();
  });

  // Re-check readiness when the window regains focus — the user may have just
  // granted a permission in System Settings or added a key in Settings.
  window.addEventListener("focus", () => {
    void refreshReadiness();
  });

  ipc.on("activity-updated", async () => {
    await loadActivities();
  });

  ipc.on("accessibility-permission-changed", (_event, data) => {
    showNotification(data.message, data.granted ? "success" : "warning");
    void refreshReadiness();
  });

  ipc.on("shortcut-updated", () => {
    void refreshReadiness();
  });

  ipc.on("ui-language-updated", async (_event, payload) => {
    if (!payload) {
      return;
    }
    setLanguage(payload.language);
    applyI18n(document);
    // applyI18n resets the clear button's text via its data-i18n attribute, so
    // drop any in-progress two-step confirm to keep its state consistent.
    resetClearButton();
    await refreshReadiness();
    renderRecent();
    renderHistory();
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

/* ---------- Readiness card ---------- */

async function refreshReadiness() {
  try {
    cachedSettings = await ipc.invoke("get-settings");
  } catch (error) {
    console.error("Failed to load settings:", error);
  }

  const [micOk, axOk] = await Promise.all([checkMicOk(), checkAxOk()]);
  renderReadiness({
    hasKey: hasApiKey(cachedSettings),
    micOk,
    axOk,
    recordShortcut: cachedSettings?.shortcut || "Ctrl+Shift",
    translateShortcut: cachedSettings?.translateShortcut || "Shift+Alt",
  });
}

async function checkMicOk() {
  try {
    const result = await ipc.invoke("check-microphone-permission");
    return result.status === "granted" || result.status === "not-determined";
  } catch (error) {
    console.error("Failed to check microphone permission:", error);
    return false;
  }
}

async function checkAxOk() {
  try {
    const result = await ipc.invoke("check-accessibility-permission");
    return !!result.granted || result.status === "not_required";
  } catch (error) {
    console.error("Failed to check accessibility permission:", error);
    return false;
  }
}

function makeIcon(name) {
  const icon = document.createElement("span");
  icon.className = "material-icons";
  icon.textContent = name;
  return icon;
}

function keycapRow(shortcut) {
  const group = document.createDocumentFragment();
  shortcutKeycaps(shortcut).forEach((symbol) => {
    const cap = document.createElement("span");
    cap.className = "kbd";
    cap.textContent = symbol;
    group.appendChild(cap);
  });
  return group;
}

function buildPill({ label, ok, onFix }) {
  const pill = document.createElement(ok ? "span" : "button");
  pill.className = `pill ${ok ? "ok" : "warn"}`;
  if (!ok) {
    pill.type = "button";
    if (onFix) {
      pill.addEventListener("click", onFix);
    }
  }
  pill.appendChild(makeIcon(ok ? "check" : "priority_high"));
  const text = document.createElement("span");
  text.textContent = label;
  pill.appendChild(text);
  return pill;
}

function renderReadiness({ hasKey, micOk, axOk, recordShortcut, translateShortcut }) {
  const card = document.getElementById("readiness-card");
  if (!card) {
    return;
  }
  const allReady = hasKey && micOk && axOk;
  card.replaceChildren();

  const head = document.createElement("div");
  head.className = "readiness-head";

  const iconWrap = document.createElement("div");
  iconWrap.className = "readiness-icon";
  iconWrap.appendChild(makeIcon("mic"));

  const titles = document.createElement("div");
  titles.className = "readiness-titles";
  const title = document.createElement("div");
  title.className = "readiness-title";
  title.textContent = allReady ? t("home.ready") : t("home.setupNeeded");
  const sub = document.createElement("div");
  sub.className = "readiness-sub";
  sub.textContent = allReady ? t("home.readyHint") : t("home.setupHint");
  titles.appendChild(title);
  titles.appendChild(sub);

  const badge = document.createElement("div");
  badge.className = `readiness-badge ${allReady ? "ok" : "warn"}`;
  badge.appendChild(makeIcon(allReady ? "check" : "priority_high"));
  const badgeText = document.createElement("span");
  badgeText.textContent = allReady ? t("home.readyBadge") : t("home.setupBadge");
  badge.appendChild(badgeText);

  head.appendChild(iconWrap);
  head.appendChild(titles);
  head.appendChild(badge);
  card.appendChild(head);

  const shortcuts = document.createElement("div");
  shortcuts.className = "readiness-shortcuts";
  [
    { label: t("home.dictate"), shortcut: recordShortcut },
    { label: t("home.english"), shortcut: translateShortcut },
  ].forEach(({ label, shortcut }) => {
    const group = document.createElement("span");
    group.className = "shortcut-group";
    const text = document.createElement("span");
    text.textContent = label;
    group.appendChild(text);
    group.appendChild(keycapRow(shortcut));
    shortcuts.appendChild(group);
  });
  card.appendChild(shortcuts);

  const divider = document.createElement("div");
  divider.className = "readiness-divider";
  card.appendChild(divider);

  const pills = document.createElement("div");
  pills.className = "readiness-pills";
  pills.appendChild(
    buildPill({ label: hasKey ? t("readiness.apiKey") : t("readiness.addApiKey"), ok: hasKey, onFix: openSettings })
  );
  pills.appendChild(buildPill({ label: t("readiness.microphone"), ok: micOk, onFix: openSettings }));
  pills.appendChild(buildPill({ label: t("readiness.accessibility"), ok: axOk, onFix: openSettings }));
  card.appendChild(pills);
}

/* ---------- Activities (recent + history) ---------- */

async function loadActivities() {
  try {
    const activities = await ipc.invoke("get-recent-activities");
    cachedActivities = Array.isArray(activities) ? activities : [];
  } catch (error) {
    console.error("Error loading activities:", error);
    cachedActivities = [];
  }
  renderRecent();
  renderHistory();
}

function formatTime(timestamp) {
  const locale = getLocale();
  return new Date(timestamp).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: locale === "en-US",
  });
}

function dateGroupLabel(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const startOfDay = (value) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (diffDays <= 0) {
    return t("history.today");
  }
  if (diffDays === 1) {
    return t("history.yesterday");
  }
  return date.toLocaleDateString(getLocale(), {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

function buildActivityRow(activity) {
  const rawText = (activity.text ?? "").toString();

  const item = document.createElement("div");
  item.className = "activity-item";

  const time = document.createElement("div");
  time.className = "activity-time";
  time.textContent = formatTime(activity.timestamp);

  const text = document.createElement("div");
  text.className = "activity-text";
  if (activity.success === false) {
    text.classList.add("failed");
  }
  text.textContent = rawText;
  text.title = rawText;

  const actions = document.createElement("div");
  actions.className = "activity-actions";

  // Dev-only: play back the original recording captured for this entry.
  if (cachedSettings?.isDev && activity.audioId) {
    const playBtn = document.createElement("button");
    playBtn.className = "icon-btn";
    playBtn.type = "button";
    playBtn.title = t("activity.playTitle");
    playBtn.setAttribute("aria-label", t("activity.playTitle"));
    playBtn.appendChild(makeIcon("play_arrow"));
    playBtn.addEventListener("click", () => playDebugAudio(activity.audioId, playBtn));
    actions.appendChild(playBtn);
  }

  const copyBtn = document.createElement("button");
  copyBtn.className = "icon-btn";
  copyBtn.type = "button";
  copyBtn.title = t("activity.copyTitle");
  copyBtn.setAttribute("aria-label", t("activity.copyTitle"));
  copyBtn.appendChild(makeIcon("content_copy"));
  copyBtn.addEventListener("click", () => copyToClipboard(rawText, copyBtn));

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "icon-btn danger";
  deleteBtn.type = "button";
  deleteBtn.title = t("activity.deleteTitle");
  deleteBtn.setAttribute("aria-label", t("activity.deleteTitle"));
  deleteBtn.appendChild(makeIcon("delete"));
  deleteBtn.addEventListener("click", () => deleteActivity(activity.id));

  actions.appendChild(copyBtn);
  actions.appendChild(deleteBtn);

  item.appendChild(time);
  item.appendChild(text);
  item.appendChild(actions);
  return item;
}

// Dev-only: single in-page debug player. Only one recording plays at a time —
// clicking another row stops the previous one; clicking the playing row stops it
// (the ▶ button toggles to ⏹ while playing).
let debugAudio = null; // { audio, url, btn } | null
let debugAudioGen = 0;

function stopDebugAudio() {
  if (!debugAudio) return;
  debugAudio.audio.pause();
  URL.revokeObjectURL(debugAudio.url);
  if (debugAudio.btn) debugAudio.btn.replaceChildren(makeIcon("play_arrow"));
  debugAudio = null;
}

async function playDebugAudio(audioId, btn) {
  // Toggle: clicking the currently-playing row's button just stops it.
  const wasPlayingThis = debugAudio && debugAudio.btn === btn;
  stopDebugAudio();
  if (wasPlayingThis) return;

  const gen = ++debugAudioGen;
  try {
    const res = await ipc.invoke("read-debug-audio", audioId);
    if (gen !== debugAudioGen) return; // a newer click superseded this one
    const bytes =
      res.bytes instanceof Uint8Array ? res.bytes : new Uint8Array(res.bytes);
    const blob = new Blob([bytes], { type: res.mime || "audio/mp4" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    debugAudio = { audio, url, btn };
    if (btn) btn.replaceChildren(makeIcon("stop"));
    const stopIfCurrent = () => {
      if (debugAudio && debugAudio.audio === audio) stopDebugAudio();
    };
    audio.addEventListener("ended", stopIfCurrent);
    audio.addEventListener("error", () => {
      console.error("[debug-audio] element error code:", audio.error && audio.error.code);
      stopIfCurrent();
    });
    await audio.play();
  } catch (error) {
    console.error("[debug-audio] playback failed:", error);
    stopDebugAudio();
  }
}

function renderGroupedList(container, activities) {
  container.replaceChildren();
  let lastGroup = null;
  activities.forEach((activity) => {
    const group = dateGroupLabel(activity.timestamp);
    if (group !== lastGroup) {
      lastGroup = group;
      const label = document.createElement("div");
      label.className = "activity-group-label";
      label.textContent = group;
      container.appendChild(label);
    }
    container.appendChild(buildActivityRow(activity));
  });
}

function renderRecent() {
  const container = document.getElementById("activity-container");
  if (!container) {
    return;
  }
  const viewAll = document.getElementById("viewAllBtn");
  if (viewAll) {
    viewAll.style.display = cachedActivities.length > RECENT_LIMIT ? "" : "none";
  }
  if (!cachedActivities.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = t("home.noActivity");
    container.replaceChildren(empty);
    return;
  }
  renderGroupedList(container, cachedActivities.slice(0, RECENT_LIMIT));
}

function renderHistory() {
  const container = document.getElementById("history-container");
  if (!container) {
    return;
  }

  // Skip rebuilding the (up to 100-row) history DOM while the History page isn't
  // visible — on every activity-updated event from Home (the common case) this
  // avoids rebuilding a hidden list. showPage('history') re-renders it on nav,
  // and the search box (the only other caller) lives on the then-active page.
  if (!document.getElementById("history-page")?.classList.contains("active")) {
    return;
  }

  if (!cachedActivities.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = t("history.empty");
    container.replaceChildren(empty);
    return;
  }

  const filtered = historyQuery
    ? cachedActivities.filter((activity) =>
        (activity.text ?? "").toString().toLowerCase().includes(historyQuery)
      )
    : cachedActivities;

  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = t("history.noResults");
    container.replaceChildren(empty);
    return;
  }

  renderGroupedList(container, filtered);
}

async function deleteActivity(id) {
  if (!id) {
    return;
  }
  try {
    await ipc.invoke("delete-history-item", id);
  } catch (error) {
    console.error("Failed to delete history item:", error);
    return;
  }
  await loadActivities();
}

function handleClearHistory() {
  const button = document.getElementById("clearHistoryBtn");
  if (!button) {
    return;
  }

  if (!clearConfirming) {
    clearConfirming = true;
    button.textContent = t("history.confirmClear");
    clearConfirmTimer = window.setTimeout(resetClearButton, 3000);
    return;
  }

  resetClearButton();
  void clearHistory();
}

function resetClearButton() {
  const button = document.getElementById("clearHistoryBtn");
  clearConfirming = false;
  if (clearConfirmTimer) {
    window.clearTimeout(clearConfirmTimer);
    clearConfirmTimer = null;
  }
  if (button) {
    button.textContent = t("history.clearAll");
  }
}

async function clearHistory() {
  try {
    await ipc.invoke("clear-history");
  } catch (error) {
    console.error("Failed to clear history:", error);
    return;
  }
  await loadActivities();
}

/* ---------- Dictionary ---------- */

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

/* ---------- Navigation & misc ---------- */

function showPage(pageId) {
  document.querySelectorAll(".page").forEach((page) => {
    page.classList.remove("active");
  });
  const page = document.getElementById(`${pageId}-page`);
  if (page) {
    page.classList.add("active");
  }
  document.querySelectorAll(".nav-item[data-page]").forEach((item) => {
    item.classList.toggle("active", item.getAttribute("data-page") === pageId);
  });
  if (pageId === "history") {
    renderHistory();
  }
}

function openSettings() {
  ipc.invoke("open-settings");
}

function showHelp() {
  const record = shortcutKeycaps(cachedSettings?.shortcut || "Ctrl+Shift").join(" ");
  const translate = shortcutKeycaps(cachedSettings?.translateShortcut || "Shift+Alt").join(" ");
  showNotification(
    `${t("home.dictate")}: ${record}   ·   ${t("home.english")}: ${translate}`,
    "info"
  );
}

async function copyToClipboard(text, button) {
  const icon = button.querySelector(".material-icons");
  const originalText = icon.textContent;
  try {
    await navigator.clipboard.writeText(text);
    icon.textContent = "check";
    button.style.color = "var(--status-success)";
  } catch (error) {
    console.error("Failed to copy text:", error);
    icon.textContent = "error";
    button.style.color = "var(--status-danger)";
  }
  setTimeout(() => {
    icon.textContent = originalText;
    button.style.color = "";
  }, 2000);
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
    padding: 14px 18px;
    border-radius: 10px;
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
window.openSettings = openSettings;
