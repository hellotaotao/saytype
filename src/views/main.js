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
    const info = await ipc.invoke("get-build-info");
    const element = document.getElementById("appVersion");
    if (element && info) {
      if (info.channel === "official") {
        element.textContent = `v${info.version}`;
      } else {
        // Local build: append the dev counter, provenance in the tooltip.
        element.textContent = `v${info.version} · dev.${info.buildNumber}`;
        const parts = [`${info.gitHash}${info.gitDirty ? " (dirty)" : ""}`];
        if (info.buildTime) {
          parts.push(new Date(info.buildTime * 1000).toLocaleString());
        }
        if (info.debug) {
          parts.push("debug");
        }
        element.title = parts.join(" · ");
      }
    }
  } catch (error) {
    console.error("Failed to load app version", error);
  }

  bindEvents();

  // First launch (or the flag was never set): take over with the onboarding
  // wizard. Strictly `=== false` so a settings-load error doesn't flash it.
  if (cachedSettings?.onboardingCompleted === false) {
    showOnboarding();
  }
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
    if (onboardingVisible()) {
      void obRefreshMicState();
    }
  });

  document.getElementById("obNextBtn")?.addEventListener("click", () => obMove(1));
  document.getElementById("obBackBtn")?.addEventListener("click", () => obMove(-1));
  document.getElementById("obStepSkipBtn")?.addEventListener("click", () => obMove(1));
  document.getElementById("obSkipBtn")?.addEventListener("click", () => {
    void finishOnboarding();
  });
  document.getElementById("obKeySaveBtn")?.addEventListener("click", () => {
    void obSaveKey();
  });
  document.getElementById("obKeyInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      void obSaveKey();
    }
  });
  document.querySelectorAll(".ob-provider").forEach((card) => {
    card.addEventListener("click", () => {
      obKeyProvider = card.getAttribute("data-provider") || "groq";
      obKeyStatus = "idle";
      renderObKey();
    });
  });
  document.getElementById("obLocalCard")?.addEventListener("click", () => {
    const state = obLocalStatus?.state || "absent";
    if (state === "downloading") {
      return; // in flight — the wizard's escape hatch is "Skip this step"
    }
    if (state === "ready") {
      if (cachedSettings?.provider !== "local") {
        void obSelectLocal();
      }
      return;
    }
    void obStartLocalDownload();
  });
  document.getElementById("obCloudToggle")?.addEventListener("click", () => {
    obCloudExpanded = !obCloudExpanded;
    renderObLocal();
  });

  // Wizard-page-5 download progress. The settings window renders the same
  // event on its own panel; here it only matters while the wizard is up.
  ipc.on("local-model-download-progress", (_event, payload) => {
    if (!payload) {
      return;
    }
    if (payload.state === "downloading") {
      obLocalStatus = {
        state: "downloading",
        downloadedBytes: payload.downloadedBytes || 0,
        totalBytes: payload.totalBytes || 0,
      };
      if (onboardingVisible()) {
        renderObLocal();
      }
      return;
    }
    if (payload.state === "error") {
      obLocalError = payload.message || "";
    }
    if (payload.state === "ready" && obLocalStartedHere) {
      // Clicking Download in the wizard already chose the local engine —
      // completing the download selects it without a second confirmation.
      obLocalStartedHere = false;
      void obSelectLocal();
    }
    void obRefreshLocalStatus();
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
    if (onboardingVisible()) {
      renderOnboarding();
    }
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

// Accessibility onboarding: after the user clicks through to System Settings we
// actively poll `recheck` (which restarts the hotkey listener on grant) so the
// flow continues by itself — bounded, so a user who walks away doesn't leave a
// poller running forever. State lives at module level because renderReadiness
// rebuilds the whole card (replaceChildren) on every refresh.
const AX_POLL_INTERVAL_MS = 1000;
const AX_POLL_MAX_MS = 90_000;
let axGuideWaiting = false;
let axGuideTimedOut = false;
let axPollTimer = null;
let axPollDeadline = 0;

async function refreshReadiness() {
  try {
    cachedSettings = await ipc.invoke("get-settings");
  } catch (error) {
    console.error("Failed to load settings:", error);
  }

  const [micOk, axOk] = await Promise.all([checkMicOk(), checkAxOk()]);
  if (axOk) {
    stopAxPolling();
    axGuideTimedOut = false;
  }
  // Keep the onboarding wizard's Accessibility page in sync — every AX state
  // change (button flow, polling, focus recheck) funnels through here.
  const axWasGranted = obAxGranted;
  obAxGranted = axOk;
  if (!axWasGranted && axOk) {
    obScheduleAdvance(4);
  }
  if (onboardingVisible()) {
    renderObAx();
    renderObLocal();
    renderObFooter();
    renderObFinal();
  }
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
    // recheck (not the read-only check): it also syncs backend state, so a
    // grant made while this window was away restarts the hotkey listener the
    // moment we refocus. It only emits accessibility-permission-changed on a
    // real change, so the event handler re-entering here can't loop.
    const result = await ipc.invoke("recheck-accessibility-permission");
    return !!result.granted || result.status === "not_required";
  } catch (error) {
    console.error("Failed to check accessibility permission:", error);
    return false;
  }
}

async function startAccessibilityFlow() {
  if (axGuideWaiting) {
    return;
  }
  axGuideTimedOut = false;

  // Prompt first (prompt:true): the one-time system dialog is what pre-adds
  // SayType to the Accessibility list — deep-linking without it lands a
  // first-run user on a list with nothing to toggle.
  try {
    const result = await ipc.invoke("request-accessibility-permission");
    if (result?.granted || result?.status === "not_required") {
      await refreshReadiness();
      return;
    }
  } catch (error) {
    console.error("Failed to request accessibility permission:", error);
  }

  // Then deep-link straight to the Accessibility pane.
  try {
    await ipc.invoke("show-permission-dialog");
  } catch (error) {
    console.error("Failed to open accessibility settings:", error);
  }

  beginAxPolling();
}

function beginAxPolling() {
  stopAxPolling();
  axGuideWaiting = true;
  axPollDeadline = Date.now() + AX_POLL_MAX_MS;
  void refreshReadiness();
  scheduleAxPoll();
}

function scheduleAxPoll() {
  axPollTimer = window.setTimeout(async () => {
    axPollTimer = null;
    let granted = false;
    try {
      const result = await ipc.invoke("recheck-accessibility-permission");
      granted = !!result.granted || result.status === "not_required";
    } catch (error) {
      console.error("Failed to recheck accessibility permission:", error);
    }
    if (!axGuideWaiting) {
      return; // stopped while the recheck was in flight (e.g. a focus refresh saw the grant)
    }
    if (granted) {
      stopAxPolling();
      await refreshReadiness();
      return;
    }
    if (Date.now() >= axPollDeadline) {
      stopAxPolling();
      axGuideTimedOut = true;
      await refreshReadiness();
      return;
    }
    scheduleAxPoll();
  }, AX_POLL_INTERVAL_MS);
}

function stopAxPolling() {
  axGuideWaiting = false;
  if (axPollTimer) {
    window.clearTimeout(axPollTimer);
    axPollTimer = null;
  }
}

// Shown as soon as the user is sent to System Settings (waiting state) and
// kept in the timed-out state, in both the readiness-card guide and the
// wizard's Accessibility page. Covers the one case the prompt+deep-link flow
// can't fix: the user once removed SayType from the Accessibility list, and
// TCC won't reliably re-add the row — dragging the app in from Finder (same
// as clicking "+") always works. Whoever needs this discovers it the moment
// they see a list without SayType in it, so it must not hide behind a delay.
function buildAxRevealRow() {
  const row = document.createElement("div");
  row.className = "ax-reveal-row";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link-btn";
  button.textContent = t("readiness.axGuide.revealApp");
  button.addEventListener("click", () => {
    ipc.invoke("reveal-app-in-finder").catch((error) => {
      console.error("Failed to reveal app in Finder:", error);
    });
  });
  row.appendChild(button);
  const hint = document.createElement("span");
  hint.className = "ax-reveal-hint";
  hint.textContent = t("readiness.axGuide.revealHint");
  row.appendChild(hint);
  return row;
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
  const isLocal = cachedSettings?.provider === "local";
  pills.appendChild(
    buildPill({
      label: isLocal
        ? t("readiness.localModel")
        : hasKey
          ? t("readiness.apiKey")
          : t("readiness.addApiKey"),
      ok: hasKey,
      onFix: openSettings,
    })
  );
  pills.appendChild(buildPill({ label: t("readiness.microphone"), ok: micOk, onFix: openSettings }));
  pills.appendChild(
    buildPill({
      label: t("readiness.accessibility"),
      ok: axOk,
      onFix: () => {
        void startAccessibilityFlow();
      },
    })
  );
  card.appendChild(pills);

  if (!axOk) {
    card.appendChild(buildAxGuide());
  }

  renderEngineCard();
}

// Engine quick-switch: its own card right under the readiness card — one
// segmented control [Groq | OpenAI | Local] mirroring config.provider (the
// tray's Engine submenu is the same switch). Deliberately NOT inside the
// readiness card: that card is pure status display, and burying an
// interactive control among status rows made it unfindable. The
// "recommended" tag on Local is a nudge, so it only shows on local-capable
// hardware (Apple Silicon) while a cloud engine is selected. Selecting local
// before its assets are downloaded is rejected by the backend — we then open
// Settings on the download panel instead of silently switching to an
// unusable engine.
const ENGINE_OPTIONS = [
  { value: "groq", label: "Groq" },
  { value: "openai", label: "OpenAI" },
  { value: "local", labelKey: "home.engineLocal" },
];

const ENGINE_CAPTION_KEY = {
  local: "home.engineCaptionLocal",
  groq: "home.engineCaptionGroq",
  openai: "home.engineCaptionOpenai",
};

function renderEngineCard() {
  const card = document.getElementById("engine-card");
  if (!card) {
    return;
  }

  const iconWrap = document.createElement("div");
  iconWrap.className = "readiness-icon";
  iconWrap.appendChild(makeIcon("memory"));

  const titles = document.createElement("div");
  titles.className = "engine-titles";
  const title = document.createElement("div");
  title.className = "engine-title";
  title.textContent = t("home.engineLabel");
  const sub = document.createElement("div");
  sub.className = "engine-sub";
  const captionKey = ENGINE_CAPTION_KEY[cachedSettings?.provider];
  sub.textContent = captionKey ? t(captionKey) : "";
  titles.appendChild(title);
  titles.appendChild(sub);

  const seg = document.createElement("div");
  seg.className = "engine-seg";
  seg.setAttribute("role", "radiogroup");
  ENGINE_OPTIONS.forEach(({ value, label, labelKey }) => {
    const active = cachedSettings?.provider === value;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `engine-seg-btn${active ? " active" : ""}`;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(active));
    const text = document.createElement("span");
    text.textContent = labelKey ? t(labelKey) : label;
    btn.appendChild(text);
    if (value === "local" && cachedSettings?.localCapable && !active) {
      const tag = document.createElement("span");
      tag.className = "engine-tag";
      tag.textContent = t("home.engineRecommended");
      btn.appendChild(tag);
    }
    btn.addEventListener("click", () => {
      void selectEngine(value);
    });
    seg.appendChild(btn);
  });

  card.replaceChildren(iconWrap, titles, seg);
}

async function selectEngine(provider) {
  if (cachedSettings?.provider === provider) {
    return;
  }
  try {
    await ipc.invoke("set-provider", provider);
    // The shortcut-updated broadcast re-renders too; refresh eagerly so the
    // highlight moves without waiting on the event round-trip.
    await refreshReadiness();
  } catch (error) {
    if (provider === "local") {
      // Assets not downloaded yet — hand over to the settings download panel.
      ipc.invoke("open-local-model-panel").catch((panelError) => {
        console.error("Failed to open local model panel:", panelError);
      });
      return;
    }
    console.error("Failed to switch engine:", error);
    showNotification(String(error?.message || error), "warning");
  }
}

// The in-card Accessibility onboarding panel. The copy leads with what the
// permission is used for AND what it is not used for — the permission sounds
// scary, and Apple forbids apps from granting it to themselves, so persuading
// the user through the System Settings toggle is the whole game here.
function buildAxGuide() {
  const guide = document.createElement("div");
  guide.className = "ax-guide";

  const head = document.createElement("div");
  head.className = "ax-guide-head";
  head.appendChild(makeIcon("accessibility_new"));
  const headText = document.createElement("div");
  const title = document.createElement("div");
  title.className = "ax-guide-title";
  title.textContent = t("readiness.axGuide.title");
  const lead = document.createElement("div");
  lead.className = "ax-guide-lead";
  lead.textContent = t("readiness.axGuide.lead");
  headText.appendChild(title);
  headText.appendChild(lead);
  head.appendChild(headText);
  guide.appendChild(head);

  const list = document.createElement("ul");
  list.className = "ax-guide-list";
  [
    { icon: "keyboard", key: "readiness.axGuide.useInsert" },
    { icon: "bolt", key: "readiness.axGuide.useHotkey" },
  ].forEach(({ icon, key }) => {
    const item = document.createElement("li");
    item.appendChild(makeIcon(icon));
    const text = document.createElement("span");
    text.textContent = t(key);
    item.appendChild(text);
    list.appendChild(item);
  });
  guide.appendChild(list);

  const privacy = document.createElement("div");
  privacy.className = "ax-guide-privacy";
  privacy.appendChild(makeIcon("verified_user"));
  const privacyText = document.createElement("span");
  privacyText.textContent = t("readiness.axGuide.privacy");
  privacy.appendChild(privacyText);
  guide.appendChild(privacy);

  const actions = document.createElement("div");
  actions.className = "ax-guide-actions";
  if (axGuideWaiting) {
    const waiting = document.createElement("div");
    waiting.className = "ax-guide-waiting";
    waiting.appendChild(makeIcon("sync"));
    const label = document.createElement("span");
    label.textContent = t("readiness.axGuide.waiting");
    waiting.appendChild(label);
    actions.appendChild(waiting);
    const hint = document.createElement("div");
    hint.className = "ax-guide-hint";
    hint.textContent = t("readiness.axGuide.waitingHint");
    actions.appendChild(hint);
    actions.appendChild(buildAxRevealRow());
  } else {
    const button = document.createElement("button");
    button.className = "btn";
    button.type = "button";
    button.textContent = t("readiness.axGuide.open");
    button.addEventListener("click", () => {
      void startAccessibilityFlow();
    });
    actions.appendChild(button);
    if (axGuideTimedOut) {
      const hint = document.createElement("div");
      hint.className = "ax-guide-hint";
      hint.textContent = t("readiness.axGuide.retryHint");
      actions.appendChild(hint);
      actions.appendChild(buildAxRevealRow());
    }
  }
  guide.appendChild(actions);

  return guide;
}

/* ---------- Onboarding wizard ---------- */

// A first-launch takeover of the main window (6 pages, one idea per page).
// Static copy lives in main.html via data-i18n; everything stateful — keycaps,
// permission statuses, the provider/key form — renders here. Completing OR
// skipping sets settings.onboardingCompleted; the readiness card remains the
// everyday fallback for anything left unfinished. Help reopens the wizard.

const OB_TOTAL = 6;
let obCurrent = 1;
let obMicState = "unknown"; // "unknown" | "prompt" | "granted" | "denied"
let obMicBusy = false;
let obAxGranted = false;
let obKeyProvider = "groq";
let obKeyStatus = "idle"; // "idle" | "saving" | "saved" | "error"
let obKeyError = "";
let obAdvanceTimer = null;
// Page 5's local-engine path (only rendered when settings.localCapable):
// download state mirrors get-local-model-status; obLocalStartedHere marks a
// download the user started from THIS wizard — clicking Download already
// expresses "use local", so its completion selects the engine without asking
// again (the settings window prompts instead for downloads started there).
let obLocalStatus = null; // { state, downloadedBytes, totalBytes } | null
let obLocalStartedHere = false;
let obLocalError = "";
let obCloudExpanded = false;

function onboardingVisible() {
  const overlay = document.getElementById("onboarding");
  return !!overlay && !overlay.hidden;
}

function showOnboarding(page = 1) {
  const overlay = document.getElementById("onboarding");
  if (!overlay) {
    return;
  }
  obCurrent = page;
  obKeyStatus = "idle";
  obKeyError = "";
  // Recommend Groq (free tier) unless the user already runs on OpenAI.
  obKeyProvider =
    cachedSettings?.hasApiKey && cachedSettings.provider === "openai" ? "openai" : "groq";
  obLocalError = "";
  obLocalStartedHere = false;
  // Local-first: the cloud section starts folded on capable hardware, unless
  // the user is already set up on a cloud engine (re-opened wizard from Help).
  obCloudExpanded =
    !cachedSettings?.localCapable ||
    (!!cachedSettings?.hasApiKey && cachedSettings.provider !== "local");
  overlay.hidden = false;
  renderOnboarding();
  void obRefreshMicState();
  void obRefreshLocalStatus();
}

async function finishOnboarding() {
  const overlay = document.getElementById("onboarding");
  if (overlay) {
    overlay.hidden = true;
  }
  if (obAdvanceTimer) {
    window.clearTimeout(obAdvanceTimer);
    obAdvanceTimer = null;
  }
  try {
    await ipc.invoke("set-onboarding-completed");
    if (cachedSettings) {
      cachedSettings.onboardingCompleted = true;
    }
  } catch (error) {
    console.error("Failed to persist onboarding completion:", error);
  }
  void refreshReadiness();
}

function obMove(delta) {
  if (obAdvanceTimer) {
    window.clearTimeout(obAdvanceTimer);
    obAdvanceTimer = null;
  }
  if (obCurrent === OB_TOTAL && delta > 0) {
    void finishOnboarding();
    return;
  }
  obCurrent = Math.min(OB_TOTAL, Math.max(1, obCurrent + delta));
  renderOnboarding();
  if (obCurrent === 3) {
    void obRefreshMicState();
  }
}

// Advance shortly after a step completes, so the user sees the ✓ land first.
// Only fires while the user is actually looking at the page that completed.
function obScheduleAdvance(fromPage) {
  if (!onboardingVisible() || obCurrent !== fromPage || obAdvanceTimer) {
    return;
  }
  obAdvanceTimer = window.setTimeout(() => {
    obAdvanceTimer = null;
    if (onboardingVisible() && obCurrent === fromPage) {
      obMove(1);
    }
  }, 900);
}

function renderOnboarding() {
  if (!onboardingVisible()) {
    return;
  }
  document.querySelectorAll(".onboard-page").forEach((page) => {
    page.classList.toggle(
      "active",
      Number(page.getAttribute("data-ob-page")) === obCurrent
    );
  });

  const dots = document.getElementById("obDots");
  if (dots) {
    dots.replaceChildren(
      ...Array.from({ length: OB_TOTAL }, (_, index) => {
        const dot = document.createElement("div");
        dot.className = `ob-dot${index + 1 === obCurrent ? " active" : ""}`;
        return dot;
      })
    );
  }

  renderObKeycaps();
  renderObMic();
  renderObAx();
  renderObLocal();
  renderObKey();
  renderObFooter();
  renderObFinal();
}

/* ---- Page 5: local engine path (Apple Silicon local-first) ---- */

function obFormatGB(bytes) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

async function obRefreshLocalStatus() {
  if (!cachedSettings?.localCapable) {
    return;
  }
  try {
    obLocalStatus = await ipc.invoke("get-local-model-status");
  } catch (error) {
    console.error("Failed to fetch local model status:", error);
  }
  if (onboardingVisible()) {
    renderObLocal();
  }
}

// Pick the local engine (assets are ready). The backend save broadcasts
// shortcut-updated → refreshReadiness updates cachedSettings/hasApiKey, which
// is what satisfies page 5's gate.
async function obSelectLocal() {
  try {
    await ipc.invoke("set-provider", "local");
    await refreshReadiness();
    if (onboardingVisible()) {
      renderOnboarding();
      obScheduleAdvance(5);
    }
  } catch (error) {
    obLocalError = String(error?.message || error);
    renderObLocal();
  }
}

async function obStartLocalDownload() {
  obLocalError = "";
  obLocalStartedHere = true;
  obLocalStatus = {
    state: "downloading",
    downloadedBytes: obLocalStatus?.downloadedBytes || 0,
    totalBytes: obLocalStatus?.totalBytes || 0,
  };
  renderObLocal();
  try {
    await ipc.invoke("download-local-model");
  } catch (error) {
    obLocalStartedHere = false;
    obLocalError = String(error?.message || error);
    void obRefreshLocalStatus();
  }
}

function renderObLocal() {
  const card = document.getElementById("obLocalCard");
  const toggle = document.getElementById("obCloudToggle");
  const cloud = document.getElementById("obCloudSection");
  if (!card || !toggle || !cloud) {
    return;
  }
  const capable = !!cachedSettings?.localCapable;

  // The page's framing changes with the hardware: engine choice (local-first)
  // vs the classic "connect a cloud service" page.
  const title = document.getElementById("obKeyTitle");
  if (title) {
    title.textContent = t(capable ? "onboarding.key.titleLocalFirst" : "onboarding.key.title");
  }
  const lead = document.getElementById("obKeyLead");
  if (lead) {
    lead.textContent = t(capable ? "onboarding.key.leadLocalFirst" : "onboarding.key.lead");
  }

  card.hidden = !capable;
  toggle.hidden = !capable;
  cloud.hidden = capable && !obCloudExpanded;
  toggle.textContent = t(
    obCloudExpanded ? "onboarding.key.cloudToggleHide" : "onboarding.key.cloudToggle"
  );
  if (!capable) {
    return;
  }

  const state = obLocalStatus?.state || "absent";
  const selected = state === "ready" && cachedSettings?.provider === "local";
  card.classList.toggle("selected", selected);
  card.classList.toggle("downloading", state === "downloading");

  const icon = document.getElementById("obLocalIcon");
  if (icon) {
    icon.textContent = selected ? "check_circle" : "memory";
  }
  const progress = document.getElementById("obLocalProgress");
  if (progress) {
    progress.hidden = state !== "downloading";
    const pct = obLocalStatus?.totalBytes
      ? (obLocalStatus.downloadedBytes || 0) / obLocalStatus.totalBytes
      : 0;
    progress.value = Math.round(pct * 1000);
  }
  const desc = document.getElementById("obLocalDesc");
  if (desc) {
    if (obLocalError) {
      desc.textContent = t("onboarding.key.localError", { reason: obLocalError });
    } else if (selected) {
      desc.textContent = t("onboarding.key.localSelected");
    } else if (state === "ready") {
      desc.textContent = t("onboarding.key.localReady");
    } else if (state === "downloading") {
      desc.textContent = t("onboarding.key.localDownloading", {
        done: obFormatGB(obLocalStatus?.downloadedBytes || 0),
        total: obFormatGB(obLocalStatus?.totalBytes || 0),
      });
    } else if (state === "partial") {
      desc.textContent = t("onboarding.key.localResume");
    } else {
      desc.textContent = t("onboarding.key.localAbsent", {
        total: obLocalStatus?.totalBytes ? obFormatGB(obLocalStatus.totalBytes) : "~1 GB",
      });
    }
  }
}

// Whether a wizard page's job is done. Info pages (1/2/6) are always
// "done"; the three action pages gate the Next button on real state.
function obStepSatisfied(page) {
  if (page === 3) {
    return obMicState === "granted";
  }
  if (page === 4) {
    return obAxGranted;
  }
  if (page === 5) {
    return obKeyStatus === "saved" || !!cachedSettings?.hasApiKey;
  }
  return true;
}

// Footer gating: on an unfinished action page, Next is disabled so nobody
// slides through unawares — but a low-key per-step skip link keeps anyone
// who genuinely can't grant right now from being held hostage. The global
// skip (whole wizard) only shows on the info pages before any gate.
function renderObFooter() {
  if (!onboardingVisible()) {
    return;
  }
  const satisfied = obStepSatisfied(obCurrent);
  const gated = obCurrent >= 3 && obCurrent <= 5;

  const back = document.getElementById("obBackBtn");
  if (back) {
    back.style.visibility = obCurrent === 1 ? "hidden" : "visible";
  }
  const skip = document.getElementById("obSkipBtn");
  if (skip) {
    skip.style.display = obCurrent <= 2 ? "" : "none";
  }
  const stepSkip = document.getElementById("obStepSkipBtn");
  if (stepSkip) {
    stepSkip.style.display = gated && !satisfied ? "" : "none";
  }
  const next = document.getElementById("obNextBtn");
  if (next) {
    next.textContent =
      obCurrent === 1
        ? t("onboarding.start")
        : obCurrent === OB_TOTAL
          ? t("onboarding.finish")
          : t("onboarding.next");
    next.disabled = gated && !satisfied;
  }
}

// Page 6 tells the truth: celebration + practice box only when everything
// is actually ready; otherwise a checklist of what's missing, each row
// jumping back to its page — nobody leaves the wizard surprised later.
function renderObFinal() {
  if (!onboardingVisible() || obCurrent !== OB_TOTAL) {
    return;
  }
  const steps = [
    { page: 3, icon: "mic", label: t("readiness.microphone") },
    { page: 4, icon: "accessibility_new", label: t("readiness.accessibility") },
    { page: 5, icon: "graphic_eq", label: t("readiness.engine") },
  ];
  const ready = steps.every(({ page }) => obStepSatisfied(page));

  const title = document.getElementById("obTryTitle");
  if (title) {
    title.textContent = t(ready ? "onboarding.try.title" : "onboarding.tryPending.title");
  }
  const lead = document.getElementById("obTryLead");
  if (lead) {
    lead.textContent = t(ready ? "onboarding.try.lead" : "onboarding.tryPending.lead");
  }
  const icon = document.getElementById("obFinalIcon");
  if (icon) {
    icon.textContent = ready ? "celebration" : "playlist_add_check";
  }
  const tryBox = document.getElementById("obTryBox");
  if (tryBox) {
    tryBox.hidden = !ready;
  }
  const tip = document.getElementById("obTryTip");
  if (tip) {
    tip.hidden = !ready;
  }

  const checklist = document.getElementById("obChecklist");
  if (!checklist) {
    return;
  }
  checklist.hidden = ready;
  if (ready) {
    checklist.replaceChildren();
    return;
  }
  checklist.replaceChildren(
    ...steps.map(({ page, icon: rowIcon, label }) => {
      const ok = obStepSatisfied(page);
      const row = document.createElement(ok ? "div" : "button");
      row.className = `ob-check-row${ok ? " ok" : ""}`;
      if (!ok) {
        row.type = "button";
        row.addEventListener("click", () => {
          obCurrent = page;
          renderOnboarding();
        });
      }
      row.appendChild(makeIcon(rowIcon));
      const text = document.createElement("span");
      text.className = "ob-check-label";
      text.textContent = label;
      row.appendChild(text);
      row.appendChild(makeIcon(ok ? "check" : "chevron_right"));
      return row;
    })
  );
}

// Fill an element from an i18n template containing a {keys} placeholder,
// rendering the shortcut as keycap chips instead of plain text.
function fillKeycapTemplate(element, key, shortcut) {
  if (!element) {
    return;
  }
  const [before, after] = t(key).split("{keys}");
  element.replaceChildren();
  if (before) {
    element.appendChild(document.createTextNode(before));
  }
  element.appendChild(keycapRow(shortcut));
  if (after) {
    element.appendChild(document.createTextNode(after));
  }
}

function renderObKeycaps() {
  const record = cachedSettings?.shortcut || "Ctrl+Shift";
  const translate = cachedSettings?.translateShortcut || "Shift+Alt";
  fillKeycapTemplate(document.getElementById("obStepHold"), "onboarding.welcome.holdTitle", record);
  fillKeycapTemplate(document.getElementById("obTryHint"), "onboarding.try.hint", record);

  const tip = document.getElementById("obTryTip");
  if (tip) {
    tip.replaceChildren(makeIcon("translate"));
    const body = document.createElement("span");
    fillKeycapTemplate(body, "onboarding.try.tip", translate);
    tip.appendChild(body);
  }

  const tryInput = document.getElementById("obTryInput");
  if (tryInput) {
    tryInput.placeholder = t("onboarding.try.placeholder", {
      keys: shortcutKeycaps(record).join(" "),
    });
  }
}

function obStatusPill(label) {
  const pill = document.createElement("span");
  pill.className = "ob-status-pill ok";
  pill.appendChild(makeIcon("check"));
  const text = document.createElement("span");
  text.textContent = label;
  pill.appendChild(text);
  return pill;
}

function obActionHint(label) {
  const hint = document.createElement("div");
  hint.className = "ob-action-hint";
  hint.textContent = label;
  return hint;
}

function obActionButton(label, onClick) {
  const button = document.createElement("button");
  button.className = "btn";
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

/* --- page 3: microphone --- */

async function obRefreshMicState() {
  const previous = obMicState;
  try {
    const result = await ipc.invoke("check-microphone-permission");
    obMicState =
      result.status === "granted"
        ? "granted"
        : result.status === "not-determined"
          ? "prompt"
          : "denied";
  } catch (error) {
    console.error("Failed to check microphone permission:", error);
  }
  renderObMic();
  renderObFooter();
  renderObFinal();
  if (previous !== "granted" && obMicState === "granted") {
    obScheduleAdvance(3);
  }
}

async function obEnableMic() {
  if (obMicBusy) {
    return;
  }
  obMicBusy = true;
  try {
    // A momentary capture purely to trigger the macOS microphone prompt now,
    // instead of surprising the user mid-first-dictation.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch (error) {
    console.error("Microphone request was blocked or denied:", error);
  } finally {
    obMicBusy = false;
  }
  await obRefreshMicState();
}

function renderObMic() {
  const container = document.getElementById("obMicActions");
  if (!container || !onboardingVisible()) {
    return;
  }
  container.replaceChildren();
  if (obMicState === "granted") {
    container.appendChild(obStatusPill(t("onboarding.mic.granted")));
    return;
  }
  if (obMicState === "denied") {
    container.appendChild(
      obActionButton(t("onboarding.mic.openSettings"), () => {
        ipc.invoke("open-microphone-settings").catch((error) => {
          console.error("Failed to open microphone settings:", error);
        });
      })
    );
    container.appendChild(obActionHint(t("onboarding.mic.denied")));
    return;
  }
  container.appendChild(
    obActionButton(t("onboarding.mic.enable"), () => {
      void obEnableMic();
    })
  );
  container.appendChild(obActionHint(t("onboarding.mic.enableHint")));
}

/* --- page 4: accessibility (shares state + flow with the readiness card) --- */

function renderObAx() {
  const container = document.getElementById("obAxActions");
  if (!container || !onboardingVisible()) {
    return;
  }
  container.replaceChildren();
  if (obAxGranted) {
    container.appendChild(obStatusPill(t("onboarding.ax.granted")));
    return;
  }
  if (axGuideWaiting) {
    const waiting = document.createElement("div");
    waiting.className = "ob-waiting";
    waiting.appendChild(makeIcon("sync"));
    const label = document.createElement("span");
    label.textContent = t("readiness.axGuide.waiting");
    waiting.appendChild(label);
    container.appendChild(waiting);
    container.appendChild(obActionHint(t("readiness.axGuide.waitingHint")));
    container.appendChild(buildAxRevealRow());
    return;
  }
  container.appendChild(
    obActionButton(t("readiness.axGuide.open"), () => {
      void startAccessibilityFlow();
    })
  );
  container.appendChild(
    obActionHint(
      t(axGuideTimedOut ? "readiness.axGuide.retryHint" : "readiness.axGuide.waitingHint")
    )
  );
  if (axGuideTimedOut) {
    container.appendChild(buildAxRevealRow());
  }
}

/* --- page 5: provider + API key --- */

function renderObKey() {
  if (!onboardingVisible()) {
    return;
  }
  document.querySelectorAll(".ob-provider").forEach((card) => {
    card.classList.toggle(
      "selected",
      card.getAttribute("data-provider") === obKeyProvider
    );
  });

  const input = document.getElementById("obKeyInput");
  if (input) {
    input.placeholder = t(
      obKeyProvider === "groq"
        ? "onboarding.key.placeholderGroq"
        : "onboarding.key.placeholderOpenai"
    );
  }

  const help = document.getElementById("obKeyHelp");
  if (help) {
    if (obKeyStatus === "error") {
      help.className = "ob-key-help error";
      help.textContent = t("onboarding.key.error", { message: obKeyError });
    } else if (obKeyStatus === "saved") {
      help.className = "ob-key-help ok";
      help.textContent = t("onboarding.key.saved");
    } else if (cachedSettings?.hasApiKey && cachedSettings.provider === obKeyProvider) {
      help.className = "ob-key-help ok";
      help.textContent = t("onboarding.key.configured");
    } else {
      help.className = "ob-key-help";
      help.textContent = t(
        obKeyProvider === "groq" ? "onboarding.key.getKeyGroq" : "onboarding.key.getKeyOpenai"
      );
    }
  }

  const save = document.getElementById("obKeySaveBtn");
  if (save) {
    save.disabled = obKeyStatus === "saving";
  }
}

async function obSaveKey() {
  const input = document.getElementById("obKeyInput");
  const key = (input?.value || "").trim();
  if (!key || obKeyStatus === "saving") {
    input?.focus();
    return;
  }
  obKeyStatus = "saving";
  renderObKey();
  try {
    await ipc.invoke("save-onboarding-api-key", obKeyProvider, key);
    obKeyStatus = "saved";
    if (input) {
      input.value = "";
    }
    try {
      cachedSettings = await ipc.invoke("get-settings");
    } catch (error) {
      console.error("Failed to reload settings after key save:", error);
    }
    renderObKey();
    renderObFooter();
    renderObFinal();
    obScheduleAdvance(5);
  } catch (error) {
    obKeyStatus = "error";
    obKeyError = error?.message || String(error);
    renderObKey();
  }
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

// Help = replay the onboarding wizard. It covers everything the old shortcut
// toast did (page 1 shows the live shortcuts) plus permissions and setup, and
// it's freely skippable.
function showHelp() {
  showOnboarding();
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

// Toasts live in one fixed column so two messages fired close together stack
// downward instead of landing on top of each other. Styling is in main.css —
// the element only carries state classes.
function notificationStack() {
  let stack = document.getElementById("notification-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "notification-stack";
    document.body.appendChild(stack);
  }
  return stack;
}

function showNotification(message, type = "info") {
  const notification = document.createElement("div");
  notification.className = `notification notification-${type}`;
  notification.textContent = message;
  notificationStack().appendChild(notification);

  // Flush the just-inserted hidden state so the class change transitions from
  // it. Deliberately NOT requestAnimationFrame: this window is hidden rather
  // than closed, and rAF never fires while it is, which would leave a toast
  // parked off-screen forever.
  void notification.offsetHeight;
  notification.classList.add("visible");

  setTimeout(() => {
    notification.classList.remove("visible");
    setTimeout(() => {
      notification.remove();
    }, 300);
  }, 5000);
}

window.showPage = showPage;
window.saveDictionary = saveDictionary;
window.openSettings = openSettings;
