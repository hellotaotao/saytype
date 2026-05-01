const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  Tray,
  screen,
  clipboard,
  dialog,
  systemPreferences,
} = require("electron");
const AutoLaunch = require('auto-launch');
const { exec } = require("child_process");
const path = require("path");
const { default: Store } = require("electron-store");
const { uIOhook, UiohookKey } = require("uiohook-napi");
const DatabaseManager = require("./database-manager");
const PermissionManager = require("./permission-manager");
const TranscriptionService = require("./services/transcription-service");

// Import platform-specific text inserters
let windowsTextInserter = null;
let macosTextInserter = null;

if (process.platform === 'win32') {
  try {
    windowsTextInserter = require("./windows-text-inserter-koffi");
    console.log("Windows koffi text inserter loaded");
  } catch (error) {
    console.error("Failed to load Windows text inserter:", error);
  }
} else if (process.platform === 'darwin') {
  try {
    macosTextInserter = require("./macos-text-inserter-koffi");
    if (macosTextInserter.isAvailable()) {
      console.log("macOS CGEvent text inserter loaded and available");
    } else {
      console.warn("macOS CGEvent text inserter loaded but not available");
      macosTextInserter = null;
    }
  } catch (error) {
    console.error("Failed to load macOS text inserter:", error);
  }
}

const store = new Store();
const DEFAULT_RECORD_SHORTCUT = "Ctrl+Shift";
const TRANSLATE_SHORTCUT = "Shift+Alt";
const START_RECORDING_DEBOUNCE_MS = 120;
const STOP_RECORDING_DEBOUNCE_MS = 250;
const MODIFIER_ORDER = ["Ctrl", "Shift", "Alt", "Meta"];
const MODIFIER_ALIASES = {
  ctrl: "Ctrl",
  control: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
  meta: "Meta",
  command: "Meta",
  cmd: "Meta",
  super: "Meta",
  win: "Meta",
  windows: "Meta",
};
const db = new DatabaseManager();
const permissionManager = new PermissionManager();
const isDevelopment = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

// Transcription service cache to avoid recreating clients
let transcriptionServiceCache = new Map();

// Helper function to get or create transcription service
function getTranscriptionService(provider, apiKey) {
  const cacheKey = `${provider}:${apiKey}`;
  
  if (!transcriptionServiceCache.has(cacheKey)) {
    try {
      const service = new TranscriptionService(provider, apiKey);
      transcriptionServiceCache.set(cacheKey, service);
    } catch (error) {
      console.error(`Failed to create transcription service for ${provider}:`, error);
      throw error;
    }
  }
  
  return transcriptionServiceCache.get(cacheKey);
}

// Helper function to clear service cache (useful when API keys change)
function clearTranscriptionServiceCache() {
  transcriptionServiceCache.clear();
}

function extractShortcutModifiers(value) {
  if (typeof value !== "string") {
    return [];
  }
  const tokens = value.split(/[^a-zA-Z]+/).filter(Boolean);
  const modifiers = new Set();
  for (const token of tokens) {
    const mapped = MODIFIER_ALIASES[token.toLowerCase()];
    if (mapped) {
      modifiers.add(mapped);
    }
  }
  return Array.from(modifiers);
}

function parseShortcut(shortcut) {
  if (typeof shortcut !== "string") {
    return null;
  }
  const modifiers = extractShortcutModifiers(shortcut);
  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier));
  if (ordered.length < 2) {
    return null;
  }
  return {
    ctrl: ordered.includes("Ctrl"),
    shift: ordered.includes("Shift"),
    alt: ordered.includes("Alt"),
    meta: ordered.includes("Meta"),
    label: ordered.join("+"),
  };
}

function normalizeRecordShortcut(value) {
  const parsed = parseShortcut(value);
  if (!parsed) {
    return DEFAULT_RECORD_SHORTCUT;
  }
  if (parsed.label === TRANSLATE_SHORTCUT) {
    return DEFAULT_RECORD_SHORTCUT;
  }
  return parsed.label;
}

function isShortcutActive(shortcut) {
  const parsed = parseShortcut(shortcut);
  if (!parsed) {
    return false;
  }
  return parsed.ctrl === ctrlPressed &&
    parsed.shift === shiftPressed &&
    parsed.alt === altPressed &&
    parsed.meta === metaPressed;
}

function isModifierKeycode(keycode) {
  return keycode === UiohookKey.Ctrl ||
    keycode === UiohookKey.CtrlR ||
    keycode === UiohookKey.Shift ||
    keycode === UiohookKey.ShiftR ||
    keycode === UiohookKey.Alt ||
    keycode === UiohookKey.AltR ||
    keycode === UiohookKey.Meta ||
    keycode === UiohookKey.MetaRight;
}

function getActiveShortcutMode() {
  if (isShortcutActive(recordShortcut)) {
    return { translateMode: false };
  }
  if (isShortcutActive(TRANSLATE_SHORTCUT)) {
    return { translateMode: true };
  }
  return null;
}

function clearStartRecordingDebounce() {
  if (startRecordingDebounceTimer) {
    clearTimeout(startRecordingDebounceTimer);
    startRecordingDebounceTimer = null;
  }
}

function startRecordingFromHotkey() {
  if (isRecording || startRecordingDebounceTimer) {
    return;
  }

  startRecordingDebounceTimer = setTimeout(() => {
    startRecordingDebounceTimer = null;

    if (isRecording) {
      return;
    }

    const activeMode = getActiveShortcutMode();
    if (!activeMode) {
      return;
    }

    // Delay short enough to feel instant, but filters combo hotkeys that add another key immediately.
    permissionManager
      .checkAndRequestMicrophonePermission()
      .then((hasPermission) => {
        if (!hasPermission || isRecording) {
          return;
        }

        // Re-evaluate in case key state changed while waiting for permission.
        const latestMode = getActiveShortcutMode();
        if (!latestMode) {
          return;
        }

        isRecording = true;
        if (inputPromptWindow) {
          // Reposition to the active display before showing
          positionInputPromptOnActiveDisplay(100);
          inputPromptWindow.showInactive();
          inputPromptWindow.webContents.send("start-recording", latestMode.translateMode);
        }
      })
      .catch((error) => {
        console.error("Error checking microphone permission:", error);
      });
  }, START_RECORDING_DEBOUNCE_MS);
}

function clearStopRecordingDebounce() {
  if (stopRecordingDebounceTimer) {
    clearTimeout(stopRecordingDebounceTimer);
    stopRecordingDebounceTimer = null;
  }
}

function scheduleStopRecording() {
  clearStopRecordingDebounce();
  stopRecordingDebounceTimer = setTimeout(() => {
    if (!isRecording) {
      return;
    }
    const recordShortcutActive = isShortcutActive(recordShortcut);
    const translateShortcutActive = isShortcutActive(TRANSLATE_SHORTCUT);
    if (recordShortcutActive || translateShortcutActive) {
      return;
    }
    isRecording = false;
    inputPromptWindow?.webContents.send("stop-recording");
  }, STOP_RECORDING_DEBOUNCE_MS);
}

function buildShortcutPayload() {
  return {
    recordShortcut,
    translateShortcut: TRANSLATE_SHORTCUT,
  };
}

function broadcastShortcutUpdate() {
  const payload = buildShortcutPayload();
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send("shortcut-updated", payload);
  }
  if (inputPromptWindow && inputPromptWindow.webContents) {
    inputPromptWindow.webContents.send("shortcut-updated", payload);
  }
  if (settingsWindow && settingsWindow.webContents) {
    settingsWindow.webContents.send("shortcut-updated", payload);
  }
}

function broadcastUiLanguageUpdate(language) {
  const payload = { language };
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send("ui-language-updated", payload);
  }
  if (inputPromptWindow && inputPromptWindow.webContents) {
    inputPromptWindow.webContents.send("ui-language-updated", payload);
  }
  if (settingsWindow && settingsWindow.webContents) {
    settingsWindow.webContents.send("ui-language-updated", payload);
  }
}

function broadcastUiThemeUpdate(theme) {
  const payload = { theme };
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send("ui-theme-updated", payload);
  }
  if (inputPromptWindow && inputPromptWindow.webContents) {
    inputPromptWindow.webContents.send("ui-theme-updated", payload);
  }
  if (settingsWindow && settingsWindow.webContents) {
    settingsWindow.webContents.send("ui-theme-updated", payload);
  }
}

function createCancellationError() {
  const error = new Error("TRANSCRIPTION_CANCELLED");
  error.name = "TranscriptionCancelledError";
  return error;
}

function isCancellationError(error) {
  if (!error) return false;
  if (error.name === "AbortError" || error.name === "TranscriptionCancelledError") {
    return true;
  }
  if (error.cause && error.cause.name === "AbortError") {
    return true;
  }
  if (typeof error.message === "string" && error.message.includes("TRANSCRIPTION_CANCELLED")) {
    return true;
  }
  return false;
}

function cancelActiveTranscription(reason = "user") {
  if (activeTranscriptions.size === 0) {
    return false;
  }
  for (const t of activeTranscriptions.values()) {
    t.cancelled = true;
    t.cancelReason = reason;
    if (t.abortController) {
      t.abortController.abort();
    }
  }
  return true;
}

// Auto-launch setup
const autoLauncher = new AutoLaunch({
  name: 'SayType',
  path: app.getPath('exe'),
});

let mainWindow;
let settingsWindow;
let inputPromptWindow;
let tray;
let hookStarted = false; // Track if hook is started
let accessibilityWatchdog = null; // Low-frequency permission watchdog (macOS only)

// Key state tracking for hotkey combination
let ctrlPressed = false;
let shiftPressed = false;
let altPressed = false;
let metaPressed = false;
let isQuitting = false;
let isRecording = false;
let stopRecordingDebounceTimer = null;
let startRecordingDebounceTimer = null;
let activeTranscriptions = new Map();
let transcriptionRequestId = 0;
let recordShortcut = normalizeRecordShortcut(
  store.get("shortcut", DEFAULT_RECORD_SHORTCUT)
);

// Set up permission manager event listeners
permissionManager.on('accessibility-permission-changed', (data) => {
  if (data.granted && !hookStarted) {
    setupGlobalHotkeys();
  } else if (!data.granted && hookStarted) {
    stopGlobalHotkeys();
  }
  
  // Notify main window
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('accessibility-permission-changed', data);
  }
  
  // Update settings window if open
  if (settingsWindow && settingsWindow.webContents) {
    settingsWindow.webContents.send('permission-status-updated', {
      accessibility: data.granted
    });
  }
});

permissionManager.on('quit-requested', () => {
  app.quit();
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    show: false,
    icon: path.join(__dirname, "../assets/icon.png"),
  });

  mainWindow.loadFile(path.join(__dirname, "views/main.html"));

  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.send("shortcut-updated", buildShortcutPayload());
  });

  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Handle main window closed event
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Add window focus event listener for dynamic permission detection
  // Note: This provides additional coverage beyond app.on("activate") for edge cases
  // where user might return to main window without app activation event
  mainWindow.on("focus", async () => {
    // Only recheck if we don't currently have permission (optimize for common case)
    if (!permissionManager.hasAccessibilityPermission()) {
      await permissionManager.recheckAccessibilityPermission();
    }
  });
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 900,
    height: 750,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    resizable: false,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
  });

  settingsWindow.loadFile(path.join(__dirname, "views/settings.html"));

  settingsWindow.webContents.on("before-input-event", (event, input) => {
    if (input.key === "Escape") {
      settingsWindow.close();
    }
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });

  // Check permissions when settings window gains focus
  settingsWindow.on("focus", async () => {
    // Always check in settings window since user might want to see current status
    await permissionManager.recheckAccessibilityPermission();
  });

  settingsWindow.once("ready-to-show", () => {
    settingsWindow.show();
    settingsWindow.webContents.send("shortcut-updated", buildShortcutPayload());
  });
}

function createInputPromptWindow() {
  const displays = screen.getAllDisplays();
  const primaryDisplay =
    displays.find(
      (display) => display.bounds.x === 0 && display.bounds.y === 0,
    ) || displays[0];

  const windowWidth = 400;
  const windowHeight = 100;
  const x = Math.round(
    primaryDisplay.bounds.x + primaryDisplay.bounds.width / 2 - windowWidth / 2,
  );
  const y = Math.round(
    primaryDisplay.bounds.y + primaryDisplay.bounds.height - windowHeight - 100,
  );

  inputPromptWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: x,
    y: y,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    transparent: true,
    hasShadow: false,
    focusable: false,
  });

  // Make the overlay appear on every macOS Space (including full-screen apps),
  // otherwise it stays bound to the Space where it was created and silently
  // "recording with no UI" happens after the user switches desktops.
  inputPromptWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  inputPromptWindow.loadFile(path.join(__dirname, "views/input-prompt.html"));
  inputPromptWindow.webContents.on("did-finish-load", () => {
    inputPromptWindow.webContents.send("shortcut-updated", buildShortcutPayload());
  });
}

// Position Input Prompt on the display where the user is currently active (by cursor)
function positionInputPromptOnActiveDisplay(offsetBottom = 100) {
  if (!inputPromptWindow) return;
  try {
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay();
    const area = display.workArea || display.bounds;
    const { width: winW, height: winH } = inputPromptWindow.getBounds();
    const x = Math.round(area.x + area.width / 2 - winW / 2);
    const y = Math.round(area.y + area.height - winH - Math.max(0, offsetBottom));
    inputPromptWindow.setPosition(x, y, false);
  } catch (e) {
    // Fallback: no-op if positioning fails
  }
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, "../assets/icon.png"));

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Show Main Window",
        click: () => {
          mainWindow.show();
        },
      },
      {
        label: "Settings",
        click: () => {
          createSettingsWindow();
        },
      },
      {
        type: "separator",
      },
      {
        label: "Quit",
        click: async () => {
          app.isQuitting = true;
          await stopGlobalHotkeys(); // Stop hotkeys before quitting
          app.quit();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);
    tray.setToolTip("SayType");

    tray.on("double-click", () => {
      mainWindow.show();
    });
  } catch (error) {
    console.error("Failed to create tray:", error);
  }
}

async function setupGlobalHotkeys() {
  try {
    // Check accessibility permission on macOS
    if (process.platform === "darwin") {
      const hasPermission = await permissionManager.checkAccessibilityPermission();
      if (!hasPermission) {
        return;
      }
    }

    // Ensure any previous hook is stopped before starting new one
    if (hookStarted) {
      await stopGlobalHotkeys();
      // Small delay to ensure cleanup completes
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Register keyboard event listeners (with defensive try/catch)
    uIOhook.on("keydown", (e) => {
      try {
      // Ctrl key (left or right)
      if (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlR) {
        ctrlPressed = true;
      }
      // Shift key (left or right)
      if (e.keycode === UiohookKey.Shift || e.keycode === UiohookKey.ShiftR) {
        shiftPressed = true;
      }
      // Alt key (left or right)
      if (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltR) {
        altPressed = true;
      }
      // Meta/Command key
      if (e.keycode === UiohookKey.Meta || e.keycode === UiohookKey.MetaRight) {
        metaPressed = true;
      }

      if (!isModifierKeycode(e.keycode)) {
        clearStartRecordingDebounce();
      }

      if (isRecording) {
        const recordShortcutActive = isShortcutActive(recordShortcut);
        const translateShortcutActive = isShortcutActive(TRANSLATE_SHORTCUT);
        if (recordShortcutActive || translateShortcutActive) {
          clearStopRecordingDebounce();
        }
      }

      if (e.keycode === UiohookKey.Escape) {
        if (isRecording || activeTranscriptions.size > 0) {
          clearStopRecordingDebounce();
          clearStartRecordingDebounce();
          isRecording = false;
          if (inputPromptWindow && inputPromptWindow.webContents) {
            inputPromptWindow.webContents.send("cancel-recording");
          }
          cancelActiveTranscription("user");
        }
        return;
      }

      // Start recording when the configured shortcut or translation shortcut is pressed
      if (!isRecording) {
        const activeMode = getActiveShortcutMode();
        if (activeMode) {
          clearStopRecordingDebounce();
          startRecordingFromHotkey();
        } else {
          clearStartRecordingDebounce();
        }
      }
      } catch (handlerErr) {
        console.error("uIOhook keydown handler error:", handlerErr);
      }
    });

    uIOhook.on("keyup", (e) => {
      try {
      // Ctrl key released
      if (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlR) {
        ctrlPressed = false;
      }
      // Shift key released
      if (e.keycode === UiohookKey.Shift || e.keycode === UiohookKey.ShiftR) {
        shiftPressed = false;
      }
      // Alt key released
      if (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltR) {
        altPressed = false;
      }
      // Meta/Command key released
      if (e.keycode === UiohookKey.Meta || e.keycode === UiohookKey.MetaRight) {
        metaPressed = false;
      }

      // Stop recording when neither the record nor translation shortcut is pressed
      const activeMode = getActiveShortcutMode();
      if (isRecording && !activeMode) {
        scheduleStopRecording();
      } else if (activeMode) {
        clearStopRecordingDebounce();
      } else {
        clearStartRecordingDebounce();
      }
      } catch (handlerErr) {
        console.error("uIOhook keyup handler error:", handlerErr);
      }
    });

    // Add error handler for uiohook
    uIOhook.on("error", async (error) => {
      try {
        console.error("uIOhook error:", error);
        // On any error, immediately stop the hook to avoid potential freeze
        await stopGlobalHotkeys();
      } catch (stopErr) {
        console.error("Failed to stop hotkeys after uIOhook error:", stopErr);
      } finally {
        // Recheck permission and notify UI
        try {
          await permissionManager.recheckAccessibilityPermission();
        } catch (reErr) {
          console.error("Permission recheck failed after uIOhook error:", reErr);
        }
        if (process.platform === "darwin" && error && error.message && error.message.toLowerCase().includes("access")) {
          permissionManager.showAccessibilityPermissionDialog();
        }
      }
    });

    // Start the global hook (wrap in try/catch to catch synchronous start errors)
    try {
      uIOhook.start();
    } catch (startErr) {
      console.error("uIOhook.start() threw:", startErr);
      await stopGlobalHotkeys();
      if (process.platform === "darwin") {
        permissionManager.showAccessibilityPermissionDialog();
      }
      return;
    }
    hookStarted = true;
    if (isDevelopment) console.log("Global hotkey listener started");

    // Start low-frequency watchdog (every 2s) to ensure eventual recovery if permission is revoked without error event
    if (process.platform === 'darwin') {
      if (accessibilityWatchdog) {
        clearInterval(accessibilityWatchdog);
      }
      accessibilityWatchdog = setInterval(async () => {
        try {
          if (!hookStarted) return; // if already stopped, do nothing
          const hasPermission = systemPreferences.isTrustedAccessibilityClient(false);
          if (!hasPermission) {
            console.warn("Accessibility permission revoked detected by watchdog. Stopping hotkeys to recover...");
            clearInterval(accessibilityWatchdog);
            accessibilityWatchdog = null;
            await stopGlobalHotkeys();
            await permissionManager.recheckAccessibilityPermission();
          }
        } catch (wdErr) {
          console.error("Accessibility watchdog error:", wdErr);
        }
      }, 2000);
    }
  } catch (error) {
    console.error("Failed to setup global hotkeys:", error);
    hookStarted = false;
    
    if (process.platform === "darwin" && error.message && error.message.includes("accessibility")) {
      // Only show permission dialog when we actually encounter a permission error
      permissionManager.showAccessibilityPermissionDialog();
    }
  }
}


function stopGlobalHotkeys() {
  if (!hookStarted) {
    return Promise.resolve(); // Already stopped or never started
  }

  return new Promise((resolve) => {
    try {
      // Remove all listeners first
      uIOhook.removeAllListeners();
      clearStopRecordingDebounce();
      clearStartRecordingDebounce();
      ctrlPressed = false;
      shiftPressed = false;
      altPressed = false;
      metaPressed = false;

      // Then stop the hook
      uIOhook.stop();
      hookStarted = false;

      // Clear watchdog if running
      if (accessibilityWatchdog) {
        clearInterval(accessibilityWatchdog);
        accessibilityWatchdog = null;
      }
      
      // Small delay to ensure cleanup completes
      setTimeout(resolve, 100);
    } catch (error) {
      console.error("Failed to stop global hotkeys:", error);
      hookStarted = false;

      // Clear watchdog even on failure path
      if (accessibilityWatchdog) {
        clearInterval(accessibilityWatchdog);
        accessibilityWatchdog = null;
      }

      // Force cleanup if normal stop fails
      try {
        // Kill any remaining uiohook processes on macOS
        if (process.platform === "darwin") {
          exec('pkill -f "SayType Helper"', (_err) => {
            setTimeout(resolve, 100);
          });
        } else {
          setTimeout(resolve, 100);
        }
      } catch (killError) {
        console.error("Failed to force cleanup:", killError);
        setTimeout(resolve, 100);
      }
    }
  });
}

// Clean up any orphaned helper processes from previous runs
function cleanupOrphanedProcesses() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      exec('pgrep -f "SayType Helper"', (error, stdout) => {
        if (!error && stdout.trim()) {
          exec('pkill -f "SayType Helper"', (killError) => {
            if (killError) {
              console.error("Failed to cleanup orphaned processes:", killError);
            }
            resolve();
          });
        } else {
          resolve();
        }
      });
    } else {
      resolve();
    }
  });
}


app.whenReady().then(async () => {
  // Set platform-specific icons
  if (process.platform === 'darwin') {
    // Set macOS Dock icon (useful in development)
    try {
      app.dock.setIcon(path.join(__dirname, '../assets/icon.png'));
    } catch (e) {
      console.warn('Failed to set Dock icon:', e);
    }
  }

  // Set up application menu to enable standard editing shortcuts
  const template = [
    {
      label: "SayType",
      submenu: [
        {
          label: "About SayType",
          role: "about"
        },
        {
          type: "separator"
        },
        {
          label: "Preferences...",
          accelerator: process.platform === "darwin" ? "Command+," : "Ctrl+,",
          click: () => {
            createSettingsWindow();
          }
        },
        {
          type: "separator"
        },
        {
          label: "Quit SayType",
          accelerator: process.platform === "darwin" ? "Command+Q" : "Ctrl+Q",
          click: async () => {
            app.isQuitting = true;
            await stopGlobalHotkeys();
            app.quit();
          }
        }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectall" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "toggleDevTools" }
      ]
    },
    {
      label: "Window",
      role: "window",
      submenu: [
        { role: "minimize" },
        { role: "close" }
      ]
    }
  ];
  
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // Clean up any orphaned processes first
  await cleanupOrphanedProcesses();

  // Initialize application components immediately to improve startup performance
  createMainWindow();
  createInputPromptWindow();
  createTray();
  await setupGlobalHotkeys();

  // Show main window on startup unless startMinimized is true
  const startMinimized = store.get("startMinimized", false);
  if (!startMinimized) {
    mainWindow.show();
  }

  // Request microphone permission on startup (non-blocking for UX)
  if (process.platform === "darwin") {
    permissionManager.requestInitialMicrophonePermission();
  }

  app.on("activate", () => {
    // On macOS, show or recreate main window when dock icon is clicked
    if (mainWindow) {
      mainWindow.show();
    } else {
      createMainWindow();
    }
    // Recheck accessibility permission if needed
    if (!permissionManager.hasAccessibilityPermission()) {
      permissionManager.recheckAccessibilityPermission();
    }
  });
});

app.on("window-all-closed", async () => {
  // On macOS, don't quit when all windows are closed unless explicitly quitting
  if (process.platform !== "darwin" || isQuitting) {
    await stopGlobalHotkeys();
    app.quit();
  }
});

app.on("before-quit", async (event) => {
  if (!isQuitting) {
    event.preventDefault();
    isQuitting = true;
    await stopGlobalHotkeys();
    globalShortcut.unregisterAll();
    app.exit(0);
  }
});

// Handle process termination signals
process.on("SIGINT", () => {
  console.log("Received SIGINT, cleaning up...");
  stopGlobalHotkeys();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, cleaning up...");
  stopGlobalHotkeys();
  process.exit(0);
});

// IPC handlers
ipcMain.handle("get-settings", () => {
  return {
    apiKey: store.get("apiKey", ""),
    apiKeyGroq: store.get("apiKeyGroq", store.get("apiKey", "")),
    apiKeyOpenAI: store.get("apiKeyOpenAI", ""),
    shortcut: recordShortcut,
    translateShortcut: TRANSLATE_SHORTCUT,
    language: store.get("language", "auto"),
    uiLanguage: store.get("uiLanguage", "auto"),
    uiTheme: store.get("uiTheme", "elegant"),
    model: store.get("model", "gpt-4o-mini-transcribe"),
    microphone: store.get("microphone", "default"),
    autoLaunch: store.get("autoLaunch", false),
    startMinimized: store.get("startMinimized", false),
    provider: store.get("provider", "openai"),
    isDev: isDevelopment,
  };
});

ipcMain.handle("save-settings", async (event, settings) => {
  // Persist API keys (provider-specific + legacy fallback)
  if (typeof settings.apiKeyGroq === 'string') {
    store.set("apiKeyGroq", settings.apiKeyGroq);
  }
  if (typeof settings.apiKeyOpenAI === 'string') {
    store.set("apiKeyOpenAI", settings.apiKeyOpenAI);
  }
  // Keep legacy apiKey synchronized with currently selected provider's key
  store.set("apiKey", settings.provider === 'openai' ? (settings.apiKeyOpenAI || '') : (settings.apiKeyGroq || ''));
  if (typeof settings.shortcut === "string") {
    recordShortcut = normalizeRecordShortcut(settings.shortcut);
    store.set("shortcut", recordShortcut);
  }
  store.set("language", settings.language);
  store.set("uiLanguage", settings.uiLanguage || "auto");
  store.set("uiTheme", settings.uiTheme || "elegant");
  store.set("model", settings.model);
  store.set("microphone", settings.microphone);
  store.set("autoLaunch", settings.autoLaunch);
  store.set("startMinimized", settings.startMinimized);
  store.set("provider", settings.provider || "groq");

  // Clear transcription service cache when settings change (especially API keys)
  clearTranscriptionServiceCache();

  // Notify renderers about updated shortcuts
  broadcastShortcutUpdate();
  broadcastUiLanguageUpdate(store.get("uiLanguage", "auto"));
  broadcastUiThemeUpdate(store.get("uiTheme", "elegant"));

  // Handle auto-launch setting
  try {
    if (settings.autoLaunch) {
      await autoLauncher.enable();
    } else {
      await autoLauncher.disable();
    }
  } catch (error) {
    console.error("Failed to update auto-launch setting:", error);
  }

  // Note: uiohook doesn't need re-registration like globalShortcut
  // The hotkey combination is handled dynamically

  return true;
});

ipcMain.handle("open-settings", () => {
  createSettingsWindow();
});

ipcMain.handle("hide-input-prompt", () => {
  if (inputPromptWindow) {
    // Send cleanup signal to renderer process before hiding
    inputPromptWindow.webContents.send("cleanup-microphone");
    inputPromptWindow.hide();
  }
});

ipcMain.handle("cleanup-microphone", () => {
  return true;
});

ipcMain.handle("cancel-transcription", () => {
  return cancelActiveTranscription("user");
});

ipcMain.handle("transcribe-audio", async (event, audioBuffer, translateMode = false, mimeType = 'audio/webm') => {
  const requestId = ++transcriptionRequestId;
  const abortController = new AbortController();
  const currentTranscription = {
    id: requestId,
    abortController,
    cancelled: false,
    cancelReason: null,
  };
  activeTranscriptions.set(requestId, currentTranscription);
  try {
    if (currentTranscription.cancelled) {
      throw createCancellationError();
    }
    const provider = store.get("provider", "openai");
    const apiKey = provider === 'openai'
      ? (store.get("apiKeyOpenAI", store.get("apiKey", "")))
      : (store.get("apiKeyGroq", store.get("apiKey", "")));
    if (!apiKey) {
      throw new Error("API key not configured");
    }

    const language = store.get("language", "auto");
    const model = store.get("model", "gpt-4o-mini-transcribe");
    const dictionary = store.get('dictionary', '');

    // Get cached transcription service
    const transcriptionService = getTranscriptionService(provider, apiKey);

    // Transcribe audio
    const resultText = await transcriptionService.transcribeAudio(audioBuffer, {
      model,
      language,
      prompt: dictionary,
      translateMode,
      mimeType,
      signal: abortController.signal
    });

    if (currentTranscription.cancelled) {
      throw createCancellationError();
    }

    // Save successful transcription to database
    db.addActivity(resultText, true);

    // Notify main window to update Recent Activity
    if (mainWindow) {
      mainWindow.webContents.send('activity-updated');
    }

    return resultText;
  } catch (error) {
    if (currentTranscription.cancelled || isCancellationError(error)) {
      if (isDevelopment) console.log(`${translateMode ? 'Translation' : 'Transcription'} cancelled by user`);
      throw createCancellationError();
    }
    console.error(`${translateMode ? 'Translation' : 'Transcription'} error:`, error);
    
    // Save failed transcription to database
    db.addActivity(`${translateMode ? 'Translation' : 'Transcription'} failed: ${error.message}`, false, error.message);
    
    // Notify main window to update Recent Activity
    if (mainWindow) {
      mainWindow.webContents.send('activity-updated');
    }
    
    throw error;
  } finally {
    activeTranscriptions.delete(requestId);
  }
});

ipcMain.handle("type-text", async (event, text) => {
  try {
    if (typeof text !== "string" || !text.trim()) {
      return {
        success: false,
        skippedNoText: true,
        message: "No text to insert.",
      };
    }

    if (process.platform === "darwin") {
      // macOS: Try CGEvent direct Unicode insertion first
      if (macosTextInserter) {
        try {
          if (isDevelopment) console.log("Attempting macOS text insertion via CGEvent:", JSON.stringify(text.substring(0, 50)) + (text.length > 50 ? '...' : ''));
          await macosTextInserter.insertText(text);
          
          return {
            success: true,
            method: "cgevent_unicode",
            message: "Text inserted directly via macOS CGEvent.",
          };
        } catch (cgEventError) {
          console.error("macOS CGEvent text insertion failed, falling back to clipboard:", cgEventError);
          // Fall through to clipboard method
        }
      }
      
      // Fallback: Use clipboard method with comprehensive preservation
      const originalClipboardData = await saveCompleteClipboard();
      
      try {
        // Set our text to clipboard
        clipboard.writeText(text);

        // Try text insertion only when Accessibility permission is granted
        const canInsert = permissionManager.hasAccessibilityPermission();
        if (canInsert) {
          await performTextInsertion();
          // Restore original clipboard after automatic paste completes
          setTimeout(async () => {
            await restoreCompleteClipboard(originalClipboardData);
          }, 500);
        }
        // When canInsert is false, leave transcribed text in clipboard so user can manually Cmd+V

        // Provide user feedback based on clipboard complexity
        let message = canInsert
          ? "Text inserted automatically (clipboard preserved)."
          : "Text copied to clipboard. Press Cmd+V to paste.";
        if (canInsert && originalClipboardData.isComplexContent) {
          message = "Text inserted automatically. Note: complex clipboard content may be partially restored.";
        }

        return {
          success: true,
          method: canInsert ? "clipboard_textinsert" : "clipboard",
          message: message,
        };
      } catch (insertError) {
        console.error("Text insertion failed, falling back to clipboard paste:", insertError.message);
        // Insertion failed — leave text in clipboard so user can manually paste
        return {
          success: true,
          method: "clipboard",
          message: "Text copied to clipboard. Press Cmd+V to paste.",
        };
      }
    } else if (process.platform === "win32") {
      // Windows: Try koffi text insertion first, fallback to clipboard
      if (windowsTextInserter) {
        try {
          if (isDevelopment) console.log("Attempting Windows text insertion via koffi:", JSON.stringify(text.substring(0, 50)) + (text.length > 50 ? '...' : ''));
          await windowsTextInserter.insertText(text);
          
          return {
            success: true,
            method: "koffi_sendinput",
            message: "Text inserted directly via Windows API.",
          };
        } catch (koffiError) {
          console.error("Windows koffi text insertion failed:", koffiError);
          
          // Fallback to clipboard if koffi fails
          clipboard.writeText(text);
          return {
            success: true,
            method: "clipboard",
            message: "Direct text insertion failed, text copied to clipboard. Press Ctrl+V to paste.",
          };
        }
      } else {
        // No koffi available, use clipboard
        clipboard.writeText(text);
        return {
          success: true,
          method: "clipboard",
          message: "Text copied to clipboard. Press Ctrl+V to paste.",
        };
      }
    } else {
      // Other platforms: fallback to clipboard
      clipboard.writeText(text);
      return {
        success: true,
        method: "clipboard",
        message: "Text copied to clipboard. Press Ctrl+V to paste.",
      };
    }
  } catch (error) {
    console.error("Failed to process text:", error);
    throw error;
  }
});

// Function to perform text insertion using keyboard shortcut
async function performTextInsertion() {
  return new Promise((resolve, reject) => {
    // AppleScript to simulate Cmd+V
    const script = `
      tell application "System Events"
        delay 0.05
        keystroke "v" using command down
      end tell
    `;
    
    exec(`osascript -e '${script}'`, (error, stdout, stderr) => {
      if (error) {
        console.error("Text insertion error:", error.message);
        reject(new Error(`Text insertion failed: ${error.message}`));
        return;
      }
      if (stderr) {
        console.warn("Text insertion stderr:", stderr);
      }
      // AppleScript executed successfully, but we can't verify if text was actually inserted
      resolve();
    });
  });
}

ipcMain.handle("show-permission-dialog", async () => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "Text Insertion Permission",
    message: "SayType needs permission to insert text into applications.",
    detail:
      "The app will copy text to your clipboard as a fallback method. You can manually paste the transcribed text where needed.",
    buttons: ["Continue with Clipboard", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });

  return result.response;
});

// Check microphone permission status
ipcMain.handle("check-microphone-permission", () => {
  if (process.platform !== "darwin") {
    return { status: "granted" };
  }
  const status = systemPreferences.getMediaAccessStatus("microphone");
  return { status };
});

// Check accessibility permission status
ipcMain.handle("check-accessibility-permission", async () => {
  return permissionManager.getAccessibilityPermissionStatus();
});

// Request accessibility permission
ipcMain.handle("request-accessibility-permission", async () => {
  return await permissionManager.requestAccessibilityPermission();
});

// Manual recheck accessibility permission (for settings page button)
ipcMain.handle("recheck-accessibility-permission", async () => {
  const hasPermission = await permissionManager.recheckAccessibilityPermission();
  return {
    granted: hasPermission,
    status: hasPermission ? "granted" : "denied",
  };
});

// Get recent activities
ipcMain.handle("get-recent-activities", async (event) => {
  try {
    return db.getActivities();
  } catch (error) {
    console.error("Error getting recent activities:", error);
    return [];
  }
});

// Get app version using Electron's official API
ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});

// Dictionary-related IPC handlers
ipcMain.handle("get-dictionary", async (event) => {
  try {
    return store.get("dictionary", "");
  } catch (error) {
    console.error("Error getting dictionary:", error);
    return "";
  }
});

ipcMain.handle("save-dictionary", async (event, text) => {
  try {
    store.set("dictionary", text);
    return true;
  } catch (error) {
    console.error("Error saving dictionary:", error);
    throw error;
  }
});

// Function to save complete clipboard content using Electron APIs
async function saveCompleteClipboard() {
  const formats = clipboard.availableFormats();
  const data = { formats };

  // Standard formats - just read them directly like old code
  data.text = clipboard.readText();
  data.html = clipboard.readHTML();
  data.rtf = clipboard.readRTF();
  data.image = clipboard.readImage();

  // macOS-specific formats
  if (process.platform === 'darwin') {
    try {
      data.bookmark = clipboard.readBookmark();
    } catch (e) {}
    
    try {
      data.findText = clipboard.readFindText();
    } catch (e) {}
  }

  // Custom formats - read all available formats as buffers
  data.customFormats = {};
  for (const format of formats) {
    try {
      data.customFormats[format] = clipboard.readBuffer(format);
    } catch (e) {}
  }

  // Simple check for complex content
  data.isComplexContent = formats.length > 5;

  if (isDevelopment) console.log("Original clipboard saved with formats:", formats);
  return data;
}

// Function to restore complete clipboard content
async function restoreCompleteClipboard(clipboardData) {
  if (!clipboardData || !clipboardData.formats || clipboardData.formats.length === 0) {
    return;
  }

  try {
    clipboard.clear();

    // Restore standard formats - just like old code
    const dataToWrite = {};
    if (clipboardData.text) dataToWrite.text = clipboardData.text;
    if (clipboardData.html) dataToWrite.html = clipboardData.html;
    if (clipboardData.rtf) dataToWrite.rtf = clipboardData.rtf;
    if (clipboardData.image && !clipboardData.image.isEmpty()) {
      dataToWrite.image = clipboardData.image;
    }
    if (clipboardData.bookmark) dataToWrite.bookmark = clipboardData.bookmark;

    if (Object.keys(dataToWrite).length > 0) {
      clipboard.write(dataToWrite);
    }

    // macOS find text
    if (process.platform === 'darwin' && clipboardData.findText) {
      try {
        clipboard.writeFindText(clipboardData.findText);
      } catch (e) {}
    }

    // Restore all custom formats
    if (clipboardData.customFormats) {
      for (const [format, buffer] of Object.entries(clipboardData.customFormats)) {
        try {
          clipboard.writeBuffer(format, buffer);
        } catch (e) {}
      }
    }

    if (isDevelopment) console.log("Original clipboard restored");

  } catch (error) {
    // Fallback to text only
    if (clipboardData.text) {
      try {
        clipboard.writeText(clipboardData.text);
      } catch (e) {}
    }
  }
}
