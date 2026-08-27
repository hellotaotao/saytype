if (typeof document !== "undefined" && document.documentElement) {
  document.documentElement.setAttribute("data-input-prompt-js-ran", "1");
}

const ipc = window.__SAYTYPE_IPC__;
const { initI18n, setLanguage, applyI18n, t } = window.SayTypeI18n;

let isDev = false;

const DEFAULT_RECORD_SHORTCUT = "Ctrl+Shift";
const DEFAULT_TRANSLATE_SHORTCUT = "Shift+Alt";
const DEBUG_MICROPHONE_CLEANUP = false;
// Mirror of commands.rs perform_transcription_request model selection, so the
// badge shows the model that will ACTUALLY run (incl. the translate-mode
// override and the empty-model default). Keep in sync with the Rust side.
const RECORD_DEFAULT_MODEL = { openai: "gpt-4o-mini-transcribe", groq: "whisper-large-v3-turbo" };
const TRANSLATE_MODEL = { openai: "whisper-1", groq: "whisper-large-v3" };
const QWEN_LOCAL_MODEL_ID = "qwen3-asr-0.6b-q8_0";
const NEMOTRON_LOCAL_MODEL_ID = "nemotron-3.5-asr-streaming-0.6b-q8_0";
const MODEL_LABEL = {
  "gpt-4o-transcribe": "OpenAI GPT-4o",
  "gpt-4o-mini-transcribe": "OpenAI GPT-4o mini",
  "whisper-1": "OpenAI Whisper",
  "whisper-large-v3": "Groq Whisper v3",
  "whisper-large-v3-turbo": "Groq Whisper v3 Turbo",
  [QWEN_LOCAL_MODEL_ID]: "Qwen3 · Local",
  [NEMOTRON_LOCAL_MODEL_ID]: "Nemotron 3.5 · Live Local",
};
// Audio capture constraints, shared by the launch prime and every recording.
const AUDIO_CONSTRAINTS = {
  audio: {
    // Whisper resamples everything to 16 kHz mono anyway, so capturing at
    // 16 kHz (instead of 44.1 kHz) shrinks the upload with no quality loss.
    // Treated as a hint — browsers that ignore it still work.
    sampleRate: 16000,
    channelCount: 1,
    // echoCancellation routes capture through macOS's VoiceProcessingIO audio
    // unit, which cold-starts in ~1–2s on an external/USB mic and swallows the
    // first second(s) of speech. Dictation needs no echo cancellation, so keep
    // it off. (noiseSuppression/autoGainControl don't exist in this WebKit build
    // — getSettings() reports them undefined — but are pinned off for clarity.)
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
};
const THEME_PREFS = new Set(["auto", "midnight", "elegant"]);
let currentThemePref = "elegant";

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

function logMicrophoneCleanup(...args) {
  if (!DEBUG_MICROPHONE_CLEANUP) {
    return;
  }
  console.log(...args);
}

function hasMeaningfulText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeMilliseconds(value) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function normalizeRecordingStartPayload(payload, receivedAtUnixMs = Date.now()) {
  if (!payload || typeof payload !== "object") {
    return {
      translateMode: !!payload,
      nativeMs: 0,
      eventDeliveryMs: 0,
    };
  }

  const dispatchedAtUnixMs = Number(payload.dispatchedAtUnixMs);
  return {
    translateMode: !!payload.translateMode,
    nativeMs: nonNegativeMilliseconds(Number(payload.nativeMs)),
    eventDeliveryMs: Number.isFinite(dispatchedAtUnixMs)
      ? nonNegativeMilliseconds(receivedAtUnixMs - dispatchedAtUnixMs)
      : 0,
  };
}

// Extracts a human-readable message from a Tauri command rejection, which may
// be a raw string (Result<_, String>) or an Error.
function errorMessage(error) {
  return typeof error === "string"
    ? error
    : typeof error?.message === "string"
      ? error.message
      : String(error ?? "");
}

// Whether a failed transcription is worth one automatic retry. A hung/timed-out
// decode is transient — the local watchdog (local_asr.rs) aborts a wedged
// subprocess with a "treating as hung" message, and a network/hard timeout is
// likewise worth one more shot. Deterministic failures (bad key, clip too long,
// cancelled) must NOT be retried: a retry only re-fails after doubling the wait.
function isRetryableTranscriptionError(message) {
  return /treating as hung/i.test(message) || /timed out/i.test(message);
}

// Shape-only text metric (counts, never content) sent alongside type-text /
// copy-to-clipboard; the backend logs it next to its own count of the received
// string, so a mismatch pins text corruption to the JS→Rust IPC leg. Must
// mirror text_shape() in commands.rs.
function textShape(text) {
  let chars = 0;
  let cjk = 0;
  let latin1 = 0;
  for (const ch of text) {
    chars += 1;
    const c = ch.codePointAt(0);
    if (c >= 0x3000 && c <= 0x9fff) {
      cjk += 1;
    } else if (c >= 0x80 && c <= 0xff) {
      latin1 += 1;
    }
  }
  return `chars=${chars} cjk=${cjk} latin1sup=${latin1}`;
}

class VoiceInputPrompt {
  constructor() {
    this.isRecording = false;
    this.translateMode = false;
    this.audioContext = null;
    this.mediaStream = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.analyser = null;
    this.dataArray = null;
    this.animationId = null;
    this.starting = false;
    this.stopRequested = false;
    this.recordingStartedAt = null;
    this.cancelledShortPress = false;
    this.cancelInProgress = false;
    this.transcriptionInProgressCount = 0;
    this.activeTranscriptionSessionIds = new Set();
    this.cancelledTranscriptionSessionIds = new Set();
    this.localTranscriptionTail = Promise.resolve();
    this.recordingSessionId = 0;
    this.activeRecordingSession = null;
    this.pendingInsertionOrder = [];
    this.pendingInsertionsById = new Map();
    this.isFlushingInsertQueue = false;
    this.recordingTimerId = null;
    this.hidePromptTimerId = null;
    this.actualHideTimerId = null;
    this.recordShortcut = DEFAULT_RECORD_SHORTCUT;
    this.translateShortcut = DEFAULT_TRANSLATE_SHORTCUT;
    this.pageStartedAt = performance.now();

    this.promptElement = document.getElementById("inputPrompt");
    this.promptText = document.getElementById("promptText");
    this.waveContainer = document.getElementById("waveContainer");
    this.statusText = document.getElementById("statusText");
    this.transcriptionText = document.getElementById("transcriptionText");
    this.transcriptionTextInner = document.getElementById("transcriptionTextInner");
    this.modelBadge = document.getElementById("modelBadge");
    this.copyBtn = document.getElementById("copyBtn");
    this.copyBtnLabel = document.getElementById("copyBtnLabel");
    this.currentProvider = null;
    this.currentModel = "";
    this.currentLanguage = "auto";
    this._failedText = "";

    this.createWaveBars();
    this.setupEventListeners();
    this.syncShortcutFromSettings();
    this.primeMicrophone();
    this.primeVad();
  }

  // Prewarm the neural VAD (onnxruntime wasm + Silero model) at launch, same
  // idea as primeMicrophone: move the ~0.5-1s first-load off the user's first
  // dictation. window.SayTypeVadGate is defined by vad-gate.js (loaded first).
  primeVad() {
    window.SayTypeVadGate?.warmup?.();
  }

  // Prime the WebKit audio stack once at launch. The first getUserMedia in a
  // fresh process pays a one-time init cost (~150ms+); a throwaway capture here
  // — stopped immediately — moves that cost off the user's first dictation. The
  // mic indicator only blips briefly at startup; nothing is recorded or sent.
  async primeMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return;
    }
    try {
      // The hidden input window loads before onboarding. Query the native TCC
      // state first so prewarming never becomes the action that triggers the
      // first permission prompt behind the onboarding UI.
      const permission = await ipc.invoke("check-microphone-permission");
      if (permission?.status !== "granted") {
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
      stream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      // No mic permission yet or no device — the first real recording will just
      // pay the init cost as before. Nothing actionable here.
    }
  }

  createWaveBars() {
    // Enough bars to fill the 120px container (3px bar + 2px gap ≈ 5px each).
    for (let i = 0; i < 24; i++) {
      const bar = document.createElement("div");
      bar.className = "wave-bar";
      bar.style.height = "3px";
      this.waveContainer.appendChild(bar);
    }
  }

  setupEventListeners() {
    // Qwen emits preview text while decoding after release; Nemotron emits it
    // during recording. Preview text is never inserted. The selected engine's
    // authoritative final replaces it before insertion and history storage.
    ipc.on("local-transcription-partial", (event, payload) => {
      const text = payload && payload.text;
      if (!text || !this.transcriptionText) {
        return;
      }
      const sessionMatches = Number(payload.sessionId) === this.recordingSessionId;
      const isLiveNemotron =
        sessionMatches &&
        this.activeRecordingSession?.live?.sessionId === Number(payload.sessionId) &&
        (this.isRecording || this.starting || this.transcriptionInProgressCount > 0);
      if (!sessionMatches || (!isLiveNemotron && this.transcriptionInProgressCount <= 0)) {
        return;
      }
      if (!isLiveNemotron && (this.isRecording || this.starting)) {
        return;
      }
      this.setTranscriptionPreview(text);
    });

    ipc.on("shortcut-updated", (event, payload) => {
      if (!payload) {
        return;
      }
      const recordShortcut = payload.recordShortcut || DEFAULT_RECORD_SHORTCUT;
      const translateShortcut =
        payload.translateShortcut || DEFAULT_TRANSLATE_SHORTCUT;
      this.updateShortcutHint(recordShortcut, translateShortcut);
      if (payload.provider !== undefined) this.currentProvider = payload.provider;
      if (payload.model !== undefined) this.currentModel = payload.model;
      this.updateModelBadge();
    });

    ipc.on("ui-language-updated", (event, payload) => {
      if (!payload) {
        return;
      }
      setLanguage(payload.language);
      applyI18n(document);
      this.updateShortcutHint(this.recordShortcut, this.translateShortcut);
    });

    ipc.on("ui-theme-updated", (event, payload) => {
      if (!payload) {
        return;
      }
      applyTheme(payload.theme);
    });

    // Listen for start recording from main process
    ipc.on("start-recording", async (event, payload = false) => {
      if (this.isRecording || this.starting) {
        return;
      }
      const startupTiming = normalizeRecordingStartPayload(payload);
      this.stopRequested = false;
      this.translateMode = startupTiming.translateMode;
      this.updateModelBadge();
      await this.startRecording(startupTiming);
    });

    // Listen for stop recording from main process
    ipc.on("stop-recording", () => {
      this.stopRequested = true;
      this.stopRecording();
    });

    ipc.on("cancel-recording", () => {
      this.cancelRecording();
    });

    // Listen for cleanup microphone signal
    ipc.on("cleanup-microphone", () => {
      // Ignore stale cleanup if a new recording is already in flight,
      // otherwise it would tear down the freshly acquired mediaStream.
      if (this.isRecording || this.starting) {
        return;
      }
      this.cleanup();
    });

    // Legacy support for toggle recording
    ipc.on("toggle-recording", async () => {
      if (!this.isRecording) {
        await this.startRecording();
      } else {
        this.stopRecording();
      }
    });

    // ESC key to cancel recording when window is focused
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.cancelRecording();
      }
    });

    // Add window beforeunload event to ensure cleanup
    window.addEventListener("beforeunload", () => {
      this.cleanup();
    });

    // Insertion-failure "Copy" affordance — explicit click only (no auto copy).
    if (this.copyBtn) {
      this.copyBtn.addEventListener("click", () => this.copyFailedText());
    }
  }

  async syncShortcutFromSettings() {
    try {
      const settings = await ipc.invoke("get-settings");
      if (!settings) {
        return;
      }
      this.osName = settings.os || this.osName;
      this.currentProvider = settings.provider || "openai";
      this.currentModel = settings.model || "";
      this.currentLanguage = settings.language || "auto";
      this.updateShortcutHint(
        settings.shortcut || DEFAULT_RECORD_SHORTCUT,
        settings.translateShortcut || DEFAULT_TRANSLATE_SHORTCUT
      );
      this.updateModelBadge();
    } catch (error) {
      console.error("Failed to load shortcut hint settings:", error);
      this.updateShortcutHint(this.recordShortcut, this.translateShortcut);
    }
  }

  formatShortcutLabel(shortcut) {
    if (typeof shortcut !== "string") {
      return "";
    }
    const label = shortcut.replace(/\+/g, " + ");
    // macOS labels Alt as Option; Windows/Linux keep Alt. Use the backend `os`
    // field (set in syncShortcutFromSettings), falling back to navigator only
    // before settings have loaded.
    const isMac = this.osName
      ? this.osName === "macos"
      : /Mac/i.test(window.navigator?.platform || "");
    return isMac ? label.replace(/Alt/g, "Option") : label;
  }

  updateShortcutHint(recordShortcut, translateShortcut) {
    if (!this.promptText) {
      return;
    }
    const safeRecordShortcut =
      recordShortcut || this.recordShortcut || DEFAULT_RECORD_SHORTCUT;
    const safeTranslateShortcut =
      translateShortcut || this.translateShortcut || DEFAULT_TRANSLATE_SHORTCUT;
    this.recordShortcut = safeRecordShortcut;
    this.translateShortcut = safeTranslateShortcut;
    const recordLabel = this.formatShortcutLabel(safeRecordShortcut);
    const translateLabel = this.formatShortcutLabel(safeTranslateShortcut);
    this.promptText.textContent = t("inputPrompt.hint", {
      record: recordLabel,
      translate: translateLabel,
    });
  }

  resolveActiveModel() {
    if (this.currentProvider == null) {
      return null; // settings not loaded yet
    }
    if (this.currentProvider === "local") {
      // Translate mode falls back to a cloud Whisper (commands.rs picks the
      // provider by key presence — the exact one isn't known here).
      const model = this.currentModel === NEMOTRON_LOCAL_MODEL_ID
        ? NEMOTRON_LOCAL_MODEL_ID
        : QWEN_LOCAL_MODEL_ID;
      return this.translateMode ? "Cloud Whisper" : MODEL_LABEL[model];
    }
    const provider = this.currentProvider === "groq" ? "groq" : "openai";
    let model;
    if (this.translateMode) {
      model = TRANSLATE_MODEL[provider];
    } else if (!String(this.currentModel || "").trim()) {
      model = RECORD_DEFAULT_MODEL[provider];
    } else {
      model = this.currentModel;
    }
    return MODEL_LABEL[model] || model || "";
  }

  updateModelBadge() {
    if (!this.modelBadge) {
      return;
    }
    this.modelBadge.textContent = this.resolveActiveModel() || "";
  }

  // --- Insertion-failure "click to Copy" UI (never an automatic clipboard touch) ---
  showInsertFailed(text) {
    this.clearHidePromptTimer();
    this._failedText = typeof text === "string" ? text : "";
    this.promptElement.classList.remove("recording");
    this.promptElement.classList.add("insert-failed");
    this.promptText.textContent = t("inputPrompt.insertFailedTitle");
    this.statusText.textContent = t("inputPrompt.insertFailedHint");
    this.statusText.style.color = "var(--status-warning)";
    if (this.copyBtnLabel) {
      this.copyBtnLabel.textContent = t("inputPrompt.copyButton");
    }
    // Swap the (now-stopped) waveform for the Copy button.
    if (this.waveContainer) this.waveContainer.style.display = "none";
    if (this.copyBtn) this.copyBtn.hidden = false;
    // Safety net: don't let an always-on-top overlay sit forever if ignored.
    this.scheduleHidePrompt(15000);
  }

  async copyFailedText() {
    if (!hasMeaningfulText(this._failedText)) {
      return;
    }
    try {
      await ipc.invoke("copy-to-clipboard", this._failedText, textShape(this._failedText));
      this.statusText.textContent = t("inputPrompt.copied");
      this.statusText.style.color = "var(--status-success)";
      if (this.copyBtn) this.copyBtn.hidden = true;
      this.scheduleHidePrompt(1200);
    } catch (error) {
      console.error("Clipboard copy failed:", error);
      // Keep the window + failure UI up so the user can retry.
    }
  }

  clearInsertFailedUi() {
    this._failedText = "";
    if (this.copyBtn) this.copyBtn.hidden = true;
    if (this.waveContainer) this.waveContainer.style.display = "";
    if (this.promptElement) this.promptElement.classList.remove("insert-failed");
  }

  formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  getReadyInsertionCount() {
    let count = 0;
    for (const sessionId of this.pendingInsertionOrder) {
      if (this.pendingInsertionsById.has(sessionId)) {
        count += 1;
      }
    }
    return count;
  }

  updateStatusText() {
    if (!this.statusText) {
      return;
    }

    if (this.isFlushingInsertQueue) {
      this.statusText.textContent = t("inputPrompt.inserting");
      this.statusText.style.color = "var(--status-success)";
      return;
    }

    if (this.isRecording) {
      const duration = this.formatDuration(
        Date.now() - (this.recordingStartedAt || Date.now())
      );
      let status = t("inputPrompt.recordingWithDuration", { duration });
      if (this.transcriptionInProgressCount > 0) {
        status += `${t("inputPrompt.statusSeparator")}${t(
          "inputPrompt.transcribing"
        )}`;
      }
      this.statusText.textContent = status;
      this.statusText.style.color = "";
      return;
    }

    if (this.transcriptionInProgressCount > 0) {
      this.statusText.textContent = t("inputPrompt.transcribing");
      this.statusText.style.color = "";
      return;
    }

    this.statusText.textContent = "";
    this.statusText.style.color = "";
  }

  startRecordingTimer() {
    this.stopRecordingTimer();
    this.updateStatusText();
    this.recordingTimerId = setInterval(() => {
      if (!this.isRecording) {
        return;
      }
      this.updateStatusText();
    }, 200);
  }

  stopRecordingTimer() {
    if (this.recordingTimerId) {
      clearInterval(this.recordingTimerId);
      this.recordingTimerId = null;
    }
  }

  clearHidePromptTimer() {
    if (this.hidePromptTimerId) {
      clearTimeout(this.hidePromptTimerId);
      this.hidePromptTimerId = null;
    }
  }

  scheduleHidePrompt(delayMs) {
    this.clearHidePromptTimer();
    this.hidePromptTimerId = setTimeout(() => {
      this.hidePromptTimerId = null;
      // A scheduled hide always belongs to a terminal state. If a recording
      // (re)started in the meantime, firing now would tear down the live mic
      // and clear the insertion queue — drop the stale hide instead. (Any
      // legitimate hide during recording is a direct hidePrompt() call.)
      if (
        this.isRecording ||
        this.starting ||
        this.transcriptionInProgressCount > 0 ||
        this.pendingInsertionOrder.length > 0 ||
        this.isFlushingInsertQueue
      ) {
        return;
      }
      this.hidePrompt();
    }, delayMs);
  }

  clearActualHideTimer() {
    if (this.actualHideTimerId) {
      clearTimeout(this.actualHideTimerId);
      this.actualHideTimerId = null;
    }
  }

  removePendingInsertion(sessionId) {
    this.pendingInsertionsById.delete(sessionId);
    this.pendingInsertionOrder = this.pendingInsertionOrder.filter(
      (id) => id !== sessionId
    );
  }

  storeTranscriptionResult(sessionId, transcription) {
    this.pendingInsertionsById.set(sessionId, transcription);
    this.setTranscriptionPreview(transcription);
  }

  /// Shows `text` in the height-capped preview bubble, pinned to the tail so
  /// the newest (streamed) text is what's visible. `.scrolled` drives the
  /// top-edge fade mask — only when older lines are actually hidden above,
  /// so a short transcript renders at full strength.
  setTranscriptionPreview(text) {
    const inner = this.transcriptionTextInner;
    if (!inner) {
      return;
    }
    inner.textContent = text;
    this.transcriptionText.classList.add("visible");
    // Drives CSS to dim the prompt box so the streamed-text bubble reads as the
    // front-most layer (the prompt box keeps its .recording class throughout
    // transcription, so this body flag is what tells "bubble is up" apart from
    // "still just listening").
    document.body.classList.add("has-transcription");
    inner.scrollTop = inner.scrollHeight;
    inner.classList.toggle("scrolled", inner.scrollTop > 0);
  }

  clearTranscriptionPreview() {
    if (this.transcriptionTextInner) {
      this.transcriptionTextInner.textContent = "";
      this.transcriptionTextInner.classList.remove("scrolled");
    }
    this.transcriptionText.classList.remove("visible");
    document.body.classList.remove("has-transcription");
  }

  async flushPendingInsertions() {
    if (this.isFlushingInsertQueue || this.isRecording || this.starting) {
      return;
    }

    if (!this.pendingInsertionOrder.length) {
      return;
    }

    const nextId = this.pendingInsertionOrder[0];
    if (!this.pendingInsertionsById.has(nextId)) {
      return;
    }

    this.isFlushingInsertQueue = true;
    this.updateStatusText();
    let insertedAny = false;
    let allDirect = true;
    let lastFailureMessage = null;
    let lastFailedText = null;

    try {
      while (this.pendingInsertionOrder.length) {
        const nextId = this.pendingInsertionOrder[0];
        if (!this.pendingInsertionsById.has(nextId)) {
          // Result not yet available — wait for next flush trigger
          break;
        }
        const text = this.pendingInsertionsById.get(nextId);
        this.pendingInsertionsById.delete(nextId);
        this.pendingInsertionOrder.shift();
        if (hasMeaningfulText(text)) {
          const result = await this.typeText(text, { suppressUi: true });
          if (result?.ok) {
            insertedAny = true;
            if (!result.direct) allDirect = false;
          } else if (result && !result.noText) {
            allDirect = false;
            if (result.message) lastFailureMessage = result.message;
            lastFailedText = text;
          }
        }
      }
    } finally {
      this.isFlushingInsertQueue = false;
    }

    if (!this.isRecording && !this.starting && !this.pendingInsertionOrder.length) {
      // Best path: text already appeared in the focused field — close silently.
      if (insertedAny && allDirect) {
        this.hidePrompt();
        return;
      }
      this.updateShortcutHint(this.recordShortcut, this.translateShortcut);
      if (insertedAny) {
        // A batch mixed inserted + failed items — brief acknowledgement.
        this.statusText.textContent = t("inputPrompt.textInserted");
        this.statusText.style.color = "var(--status-success)";
        this.scheduleHidePrompt(1200);
      } else if (lastFailureMessage) {
        // Keep the window open with a calm "click Copy" affordance instead of
        // auto-hiding: the text isn't in the focused app and there's no auto
        // clipboard fallback, so let the user copy it on an explicit click.
        this.showInsertFailed(lastFailedText);
      } else {
        this.statusText.textContent = t("inputPrompt.noSpeech");
        this.statusText.style.color = "var(--status-warning)";
        this.scheduleHidePrompt(1500);
      }
    } else {
      this.updateStatusText();
    }
  }

  clearPendingInsertions() {
    this.pendingInsertionOrder = [];
    this.pendingInsertionsById.clear();
  }

  async acquireLocalTranscriptionSlot() {
    const previous = this.localTranscriptionTail || Promise.resolve();
    let release = null;
    this.localTranscriptionTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  async hasUsableApiKey() {
    try {
      const settings = await ipc.invoke("get-settings");
      if (!settings) {
        return true;
      }
      // The backend now reports key presence (get_settings no longer ships the
      // raw keys to this window). Fail open if the flag is somehow absent.
      return settings.hasApiKey !== false;
    } catch (error) {
      console.error("Failed to check API key before recording:", error);
      // Don't block recording on a settings-read failure — the backend will
      // still return a clear error if the key really is missing.
      return true;
    }
  }

  showApiKeyRequired() {
    this.clearHidePromptTimer();
    this.clearActualHideTimer();
    this.stopWaveAnimation();
    this.promptElement.classList.add("visible");
    this.promptElement.classList.remove("recording");
    this.promptText.textContent = t("inputPrompt.noApiKeyTitle");
    this.statusText.textContent = t("inputPrompt.noApiKey");
    this.statusText.style.color = "var(--status-warning-strong)";
    this.scheduleHidePrompt(2800);
  }

  shouldUseNemotronLive(translateMode = this.translateMode) {
    return (
      this.currentProvider === "local" &&
      this.currentModel === NEMOTRON_LOCAL_MODEL_ID &&
      !translateMode
    );
  }

  async setupNemotronLive(recordingSession, source) {
    if (!this.shouldUseNemotronLive(recordingSession.translateMode)) {
      return;
    }
    if (!this.audioContext?.audioWorklet) {
      throw new Error("AudioWorklet is required for Nemotron live transcription");
    }

    await this.audioContext.audioWorklet.addModule("live-pcm-worklet.js");
    await ipc.invoke(
      "start-live-transcription",
      recordingSession.id,
      Math.round(this.audioContext.sampleRate),
      this.currentLanguage || "auto"
    );

    const live = {
      sessionId: recordingSession.id,
      node: null,
      mutedOutput: null,
      uploadTail: Promise.resolve(),
      uploadError: null,
      pendingPcm: [],
      pendingPcmBytes: 0,
      stopped: false,
    };
    recordingSession.live = live;

    const node = new AudioWorkletNode(this.audioContext, "saytype-pcm16-capture");
    const mutedOutput = this.audioContext.createGain();
    mutedOutput.gain.value = 0;
    live.node = node;
    live.mutedOutput = mutedOutput;

    node.port.onmessage = (event) => {
      if (live.stopped || !(event.data instanceof ArrayBuffer)) {
        return;
      }
      live.pendingPcm.push(new Uint8Array(event.data));
      live.pendingPcmBytes += event.data.byteLength;
      if (live.pendingPcmBytes >= 4096) {
        this.flushNemotronPcm(live);
      }
    };
    source.connect(node);
    node.connect(mutedOutput);
    mutedOutput.connect(this.audioContext.destination);
  }

  stopNemotronCapture(recordingSession) {
    const live = recordingSession?.live;
    if (!live || live.stopped) {
      return;
    }
    this.flushNemotronPcm(live);
    live.stopped = true;
    if (live.node) {
      live.node.port.onmessage = null;
    }
    try {
      live.node?.disconnect();
      live.mutedOutput?.disconnect();
    } catch {
      // The AudioContext may already be closing.
    }
  }

  flushNemotronPcm(live) {
    if (!live?.pendingPcmBytes) {
      return;
    }
    const bytes = new Uint8Array(live.pendingPcmBytes);
    let offset = 0;
    for (const chunk of live.pendingPcm) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    live.pendingPcm = [];
    live.pendingPcmBytes = 0;
    live.uploadTail = live.uploadTail
      .then(() => ipc.invoke("push-live-audio", bytes, live.sessionId))
      .catch((error) => {
        live.uploadError = error;
      });
  }

  async finishNemotronLive(recordingSession) {
    const live = recordingSession?.live;
    if (!live) {
      throw new Error("Nemotron realtime session was not initialized");
    }
    await live.uploadTail;
    if (live.uploadError) {
      throw live.uploadError;
    }
    return ipc.invoke("finish-live-transcription", live.sessionId);
  }

  cancelNemotronLive(recordingSession) {
    const sessionId = recordingSession?.live?.sessionId;
    if (sessionId == null) {
      return;
    }
    void ipc.invoke("cancel-live-transcription", sessionId).catch(() => {});
  }

  async startRecording(startupTiming = {}) {
    if (this.isRecording || this.starting) return;

    // A prior Escape may have cancelled an older transcription without hiding
    // the prompt yet. A new recording is a fresh operation and must not inherit
    // that cancellation state when stopRecording decides whether to process it.
    this.cancelInProgress = false;
    const startupStartedAt = performance.now();
    this.clearHidePromptTimer();
    this.clearActualHideTimer();
    this.clearInsertFailedUi();
    this.starting = true;
    try {
      // Pre-flight: without an API key the request can only fail, so tell the
      // user immediately instead of recording and failing after they speak.
      if (!(await this.hasUsableApiKey())) {
        this.showApiKeyRequired();
        return;
      }
      const preflightReadyAt = performance.now();

      // Do NOT reveal the prompt during "starting": the window appearing is the
      // signal users act on, and if it shows before the mic is actually open
      // they start talking while getUserMedia is still spinning up and lose the
      // first words. We only prep state here; the prompt is revealed (straight
      // into the Listening state) after getUserMedia resolves below.
      this.statusText.textContent = "";
      if (!this.pendingInsertionOrder.length && this.transcriptionInProgressCount === 0) {
        this.clearTranscriptionPreview();
      }

      // Acquire a fresh stream for this recording; it is fully released when
      // recording stops, so the mic indicator only shows while recording. The
      // launch prime keeps the first dictation fast despite the fresh open.
      // On macOS, microphone/Accessibility permissions are handled by the OS and the Rust backend.
      const stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
      const microphoneReadyAt = performance.now();

      if (this.stopRequested) {
        this.mediaStream = stream;
        this.cleanup();
        this.hidePrompt();
        return;
      }

      this.mediaStream = stream;

      // Setup audio context for visualization
      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)();
      const source = this.audioContext.createMediaStreamSource(
        this.mediaStream
      );
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      // Time-domain samples (one per fftSize) — used to compute a per-frame
      // volume (RMS) for the scrolling waveform, not a frequency spectrum.
      this.dataArray = new Uint8Array(this.analyser.fftSize);

      // Setup media recorder
      // Try to use the best supported format, fallback to webm
      let mimeType = "audio/webm;codecs=opus"; // Default fallback
      if (MediaRecorder.isTypeSupported("audio/mp4")) {
        mimeType = "audio/mp4"; // Better compression than WebM, widely supported
      } else if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        mimeType = "audio/webm;codecs=opus"; // Good compression, modern browsers
      }
      
      if (isDev) console.log("Using audio format:", mimeType);
      // Keep per-recording state so overlapping recordings don't clobber each other.
      const sessionId = ++this.recordingSessionId;
      const recordingSession = {
        id: sessionId,
        chunks: [],
        mimeType: mimeType,
        translateMode: this.translateMode,
        cancelledShortPress: false,
      };
      this.activeRecordingSession = recordingSession;
      this.pendingInsertionOrder.push(sessionId);
      this.audioChunks = recordingSession.chunks;
      this.recordingMimeType = mimeType; // Store for later use
      
      this.mediaRecorder = new MediaRecorder(this.mediaStream, {
        mimeType: mimeType,
      });

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordingSession.chunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this.processRecording(recordingSession);
      };

      await this.setupNemotronLive(recordingSession, source);

      // Reveal the prompt only after every selected engine is ready to receive
      // audio. The visible Listening state therefore never drops first words.
      this.promptElement.classList.add("visible", "recording");
      if (this.translateMode) {
        this.promptText.textContent = t("inputPrompt.listeningEnglish");
      } else {
        this.promptText.textContent = t("inputPrompt.listening");
      }

      this.mediaRecorder.start();
      this.recordingStartedAt = Date.now();
      this.cancelledShortPress = false;
      this.isRecording = true;
      this.startWaveAnimation();
      this.startRecordingTimer();

      const setupReadyAt = performance.now();
      requestAnimationFrame((paintedAt) => {
        const nativeMs = nonNegativeMilliseconds(Number(startupTiming.nativeMs));
        const eventDeliveryMs = nonNegativeMilliseconds(Number(startupTiming.eventDeliveryMs));
        const frontendMs = nonNegativeMilliseconds(paintedAt - startupStartedAt);
        void ipc.invoke("report-recording-startup", {
          recordingNumber: sessionId,
          uptimeMs: nonNegativeMilliseconds(startupStartedAt - this.pageStartedAt),
          nativeMs,
          eventDeliveryMs,
          preflightMs: nonNegativeMilliseconds(preflightReadyAt - startupStartedAt),
          microphoneMs: nonNegativeMilliseconds(microphoneReadyAt - preflightReadyAt),
          setupMs: nonNegativeMilliseconds(setupReadyAt - microphoneReadyAt),
          renderMs: nonNegativeMilliseconds(paintedAt - setupReadyAt),
          frontendMs,
          endToEndMs: nativeMs + eventDeliveryMs + frontendMs,
        }).catch((error) => {
          if (isDev) console.warn("Failed to report recording startup timing:", error);
        });
      });

      if (this.stopRequested) {
        this.stopRecording();
      }
    } catch (error) {
      console.error("Error starting recording:", error);
      if (this.activeRecordingSession) {
        this.cancelNemotronLive(this.activeRecordingSession);
        this.removePendingInsertion(this.activeRecordingSession.id);
      }
      await this.handleRecordingError(error);
    } finally {
      this.starting = false;
    }
  }

  stopRecording() {
    if (!this.isRecording) {
      return;
    }

    this.isRecording = false;
    this.stopRecordingTimer();
    // Mis-trigger discarding now lives in the Rust hotkey layer, which measures
    // the real key-hold time (independent of mic cold-start). The frontend only
    // cancels when explicitly told to (Esc, or Rust's Cancel → cancelRecording).
    const shouldCancel = this.cancelledShortPress || this.cancelInProgress;
    this.cancelledShortPress = shouldCancel;
    if (this.activeRecordingSession) {
      this.activeRecordingSession.cancelledShortPress = shouldCancel;
    }

    if (shouldCancel) {
      this.promptText.textContent = t("inputPrompt.cancelled");
      this.statusText.textContent = "";
      this.clearTranscriptionPreview();
    } else {
      this.promptText.textContent = t("inputPrompt.processing");
      this.statusText.textContent = t("inputPrompt.transcribing");
    }

    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      this.mediaRecorder.stop();
    }
    this.stopNemotronCapture(this.activeRecordingSession);

    // Release the mic as soon as recording stops; we keep the recorded audio
    // chunks for transcription. The mic indicator only shows while recording.
    this.cleanup({ preserveAudioChunks: true });
    this.stopWaveAnimation();
    this.flushPendingInsertions();
  }

  cancelRecording() {
    if (this.cancelInProgress) {
      return;
    }
    this.cancelInProgress = true;
    this.stopRequested = true;
    this.stopRecordingTimer();
    this.clearHidePromptTimer();
    this.clearActualHideTimer();
    // Dismiss the insert-failed affordance immediately so Esc shows a clean
    // "Cancelled", not the Copy button + amber glow lingering for ~300ms.
    this.clearInsertFailedUi();

    // A live recording is always the operation Escape refers to, even while an
    // older session is still transcribing. Cancelling the backend first would
    // leave the new MediaRecorder session unmarked and let its partial clip run
    // through transcription after the mic tracks stop.
    if (this.isRecording) {
      this.cancelledShortPress = true;
      if (this.activeRecordingSession) {
        this.activeRecordingSession.cancelledShortPress = true;
      }
      this.stopRecording();
      return;
    }

    // getUserMedia may still be resolving. stopRequested makes startRecording
    // release the stream as soon as it arrives instead of creating a session.
    if (this.starting) {
      this.stopRequested = true;
      this.promptText.textContent = t("inputPrompt.cancelled");
      this.statusText.textContent = "";
      return;
    }

    if (this.transcriptionInProgressCount > 0) {
      const sessionId = this.activeTranscriptionSessionIds.size
        ? Math.max(...this.activeTranscriptionSessionIds)
        : null;
      if (sessionId !== null) {
        this.cancelledTranscriptionSessionIds.add(sessionId);
        this.removePendingInsertion(sessionId);
      }
      ipc.invoke("cancel-transcription", sessionId).catch(() => {});
      if (this.activeRecordingSession?.live?.sessionId === sessionId) {
        ipc.invoke("cancel-live-transcription", sessionId).catch(() => {});
      }
      this.promptText.textContent = t("inputPrompt.cancelled");
      this.statusText.textContent = "";
      this.cleanup();
      this.stopWaveAnimation();
      this.scheduleHidePrompt(300);
      return;
    }

    this.clearPendingInsertions();
    this.promptText.textContent = t("inputPrompt.cancelled");
    this.statusText.textContent = "";
    this.cleanup();
    this.stopWaveAnimation();
    this.scheduleHidePrompt(300);
  }

  cleanup(options = {}) {
    const { preserveAudioChunks = false } = options;
    logMicrophoneCleanup("Starting microphone cleanup...");

    // Stop all media tracks — the mic is released as soon as a recording ends.
    if (this.mediaStream) {
      logMicrophoneCleanup("Stopping media stream tracks...");
      this.mediaStream.getTracks().forEach((track) => {
        logMicrophoneCleanup(
          `Stopping track: ${track.kind}, state: ${track.readyState}`
        );
        track.stop();
        logMicrophoneCleanup(
          `Track stopped: ${track.kind}, new state: ${track.readyState}`
        );
      });
      this.mediaStream = null;
      logMicrophoneCleanup("Media stream cleared");
    }

    // Close audio context
    if (this.audioContext) {
      logMicrophoneCleanup(
        `Closing audio context, current state: ${this.audioContext.state}`
      );
      if (this.audioContext.state !== 'closed') {
        this.audioContext.close().then(() => {
          logMicrophoneCleanup("Audio context closed successfully");
        }).catch(err => {
          console.error('Error closing audio context:', err);
        });
      }
      this.audioContext = null;
    }

    // Clean up media recorder
    if (this.mediaRecorder) {
      logMicrophoneCleanup("Cleaning up media recorder...");
      if (!preserveAudioChunks) {
        this.mediaRecorder = null;
      }
    }

    // Clean up analyser
    if (this.analyser) {
      logMicrophoneCleanup("Cleaning up analyser...");
      this.analyser = null;
    }
    
    if (this.dataArray) {
      this.dataArray = null;
    }

    // Reset audio chunks
    if (!preserveAudioChunks) {
      this.audioChunks = [];
    }
    
    logMicrophoneCleanup("Microphone cleanup completed");
  }

  // Runs the transcribe IPC with a single automatic retry on a transient
  // (hung / timed-out) failure. Across the retry the recording's session id
  // stays at the head of the insertion queue, so a later completed segment
  // waits its turn rather than jumping ahead — recording order is preserved.
  // Only after the retry also fails does the caller's catch give up (drop the
  // session, surface the failure). Deterministic errors rethrow immediately.
  async transcribeWithRetry(uploadBuffer, translateMode, uploadMime, sessionId) {
    const MAX_ATTEMPTS = 2; // original + one retry
    for (let attempt = 1; ; attempt++) {
      try {
        return await ipc.invoke(
          "transcribe-audio",
          uploadBuffer,
          translateMode,
          uploadMime,
          sessionId
        );
      } catch (error) {
        if (
          attempt >= MAX_ATTEMPTS ||
          !isRetryableTranscriptionError(errorMessage(error))
        ) {
          throw error;
        }
        if (isDev) {
          console.warn(
            `Transcription attempt ${attempt} failed (${errorMessage(error)}); auto-retrying once.`
          );
        }
      }
    }
  }

  async processRecording(recordingSession) {
    if (!recordingSession) {
      console.warn("Missing recording session; skipping transcription.");
      return;
    }

    const {
      id: sessionId,
      chunks,
      mimeType,
      translateMode,
      cancelledShortPress,
    } = recordingSession;
    // Recomputed at every use, NOT captured once: transcriptions outlive this
    // stack frame, and a slow failure can land while the user is already
    // recording the next session. The old one-shot capture stayed stale-true
    // and let that failure repaint the prompt and schedule hidePrompt — which
    // tears down the live mic and clears the insertion queue mid-recording.
    const allowUi = () =>
      sessionId === this.recordingSessionId && !this.isRecording && !this.starting;

    // Hoisted so the catch (give-up path) can stash the exact uploaded bytes as
    // a re-transcribable pending entry — see the hang-recovery branch below.
    let uploadBuffer = null;
    let uploadMime = mimeType || "audio/webm";
    let releaseLocalTranscriptionSlot = null;
    let audioBlob = null;
    const useNemotronLive = !!recordingSession.live && !translateMode;

    this.transcriptionInProgressCount += 1;
    this.activeTranscriptionSessionIds.add(sessionId);
    this.updateStatusText();
    try {
      if (
        cancelledShortPress ||
        this.cancelledTranscriptionSessionIds.has(sessionId)
      ) {
        this.cancelNemotronLive(recordingSession);
        this.removePendingInsertion(sessionId);
        if (allowUi()) {
          this.cancelledShortPress = false;
          this.recordingStartedAt = null;
          this.audioChunks = [];
          this.statusText.textContent = t("inputPrompt.cancelled");
          this.statusText.style.color = "var(--status-warning)";
          this.scheduleHidePrompt(300);
        }
        return;
      }
      if (!chunks.length) {
        this.cancelNemotronLive(recordingSession);
        console.warn("No audio chunks captured; skipping transcription request");
        this.removePendingInsertion(sessionId);
        if (allowUi()) {
          this.statusText.textContent = t("inputPrompt.noAudio");
          this.statusText.style.color = "var(--status-warning)";
          this.scheduleHidePrompt(1500);
        }
        return;
      }

      const useLocalWav =
        this.currentProvider === "local" && !translateMode && !useNemotronLive;
      if (useLocalWav) {
        // Keep the full local pipeline single-flight, not just the stateful VAD
        // call. Waiting sessions retain only compressed MediaRecorder chunks;
        // they do not each hold decoded PCM, a WAV copy, and a queued native
        // request while llama.cpp is already using its model-sized memory.
        releaseLocalTranscriptionSlot = await this.acquireLocalTranscriptionSlot();
        if (this.cancelledTranscriptionSessionIds.has(sessionId)) {
          this.removePendingInsertion(sessionId);
          return;
        }
      }

      audioBlob = new Blob(chunks, {
        type: mimeType || "audio/webm", // Use actual recording format
      });

      let transcription;
      if (useNemotronLive) {
        if (this.cancelledTranscriptionSessionIds.has(sessionId)) {
          this.cancelNemotronLive(recordingSession);
          this.removePendingInsertion(sessionId);
          return;
        }
        transcription = await this.finishNemotronLive(recordingSession);
      } else {
        // Batch engines run the neural VAD after release. Nemotron has already
        // processed the live PCM stream and returns an empty final for silence.
        try {
          if (window.SayTypeVadGate) {
            const verdict = await window.SayTypeVadGate.analyze(audioBlob, { forceWav: useLocalWav });
            if (!verdict.speech) {
              this.removePendingInsertion(sessionId);
              if (allowUi()) {
                this.statusText.textContent = t("inputPrompt.noSpeech");
                this.scheduleHidePrompt(2000);
              }
              return;
            }
            if (verdict.wav) {
              uploadBuffer = verdict.wav;
              uploadMime = "audio/wav";
              if (verdict.trimmedMs > 0) {
                console.log(
                  `VAD trim: cut ${verdict.trimmedMs}ms of head/tail silence from a ${Math.round(verdict.durationMs)}ms clip`
                );
              }
            }
          }
        } catch (vadError) {
          console.warn("VAD gate failed; proceeding to transcription:", vadError);
        }
        if (useLocalWav && !uploadBuffer) {
          try {
            uploadBuffer = await window.SayTypeVadGate.encodeFullWav(audioBlob);
            uploadMime = "audio/wav";
          } catch (wavError) {
            console.warn("full-WAV fallback failed; sending original bytes:", wavError);
          }
        }

        if (this.cancelledTranscriptionSessionIds.has(sessionId)) {
          this.removePendingInsertion(sessionId);
          return;
        }

        if (!uploadBuffer) {
          uploadBuffer = new Uint8Array(await audioBlob.arrayBuffer());
        }

        transcription = await this.transcribeWithRetry(
          uploadBuffer,
          translateMode,
          uploadMime,
          sessionId
        );
      }

      if (transcription && transcription.trim()) {
        this.storeTranscriptionResult(sessionId, transcription);
        this.updateStatusText();
        await this.flushPendingInsertions();
      } else {
        this.removePendingInsertion(sessionId);
        if (allowUi()) {
          this.statusText.textContent = t("inputPrompt.noSpeech");
          this.scheduleHidePrompt(2000);
        }
      }
    } catch (error) {
      console.error("Transcription error:", error);
      this.cancelNemotronLive(recordingSession);
      this.removePendingInsertion(sessionId);
      // Tauri rejects with the command's Err value, which is the raw string for
      // a Result<_, String>, so handle both string and Error shapes.
      const message = errorMessage(error);
      const isCancelled =
        (error && error.name === "TranscriptionCancelledError") ||
        message.includes("TRANSCRIPTION_CANCELLED");

      // Give-up recovery: preserve a failed local dictation for manual retry.
      // Stash the exact WAV as a re-transcribable pending history entry so the
      // clip isn't lost — even when the user has moved on and the prompt is gone
      // (so this runs regardless of allowUi()). Best-effort; a save failure just
      // logs. Cloud audio isn't persisted; retries always use a local engine.
      let savedPending = false;
      if (!isCancelled && useNemotronLive && !uploadBuffer && audioBlob) {
        try {
          uploadBuffer = await window.SayTypeVadGate.encodeFullWav(audioBlob);
          uploadMime = "audio/wav";
        } catch (wavError) {
          console.warn("failed to preserve Nemotron recording as WAV:", wavError);
        }
      }
      if (
        !isCancelled &&
        (useNemotronLive || this.currentProvider === "local") &&
        (useNemotronLive || isRetryableTranscriptionError(message)) &&
        uploadBuffer
      ) {
        try {
          await ipc.invoke("save-pending-transcription", uploadBuffer, uploadMime);
          savedPending = true;
        } catch (saveError) {
          console.warn("failed to save pending audio for retry:", saveError);
        }
      }

      if (allowUi()) {
        if (isCancelled) {
          this.statusText.textContent = t("inputPrompt.cancelled");
          this.statusText.style.color = "var(--status-warning)";
          this.scheduleHidePrompt(300);
        } else if (/api key not configured/i.test(message) || /no api key/i.test(message)) {
          this.statusText.textContent = t("inputPrompt.noApiKey");
          this.statusText.style.color = "var(--status-warning-strong)";
          this.scheduleHidePrompt(3500);
        } else if (/unauthorized/i.test(message) || /invalid api key/i.test(message) || /\b401\b/.test(message)) {
          this.statusText.textContent = t("inputPrompt.invalidApiKey");
          this.statusText.style.color = "var(--status-warning-strong)";
          this.scheduleHidePrompt(3500);
        } else if (savedPending) {
          // Hung and unrecoverable now, but the audio is saved — point the user
          // to History rather than showing a dead-end failure.
          this.statusText.textContent = t("inputPrompt.transcriptionHungSaved");
          this.statusText.style.color = "var(--status-warning)";
          this.scheduleHidePrompt(4000);
        } else {
          this.statusText.textContent = message
            ? t("inputPrompt.transcriptionFailedReason", { reason: message })
            : t("inputPrompt.transcriptionFailed");
          this.statusText.style.color = "var(--status-warning-strong)";
          this.scheduleHidePrompt(4000);
        }
      }
    } finally {
      if (releaseLocalTranscriptionSlot) {
        releaseLocalTranscriptionSlot();
      }
      this.cancelledTranscriptionSessionIds.delete(sessionId);
      this.activeTranscriptionSessionIds.delete(sessionId);
      this.transcriptionInProgressCount = Math.max(0, this.transcriptionInProgressCount - 1);
      // Only refresh status when concurrent transcriptions are still running.
      // If count reached 0, the try/catch or flushPendingInsertions have already
      // set the terminal status ("Cancelled", "No speech", "Text inserted", etc.)
      // — calling updateStatusText() here would overwrite them with an empty string.
      if (this.transcriptionInProgressCount > 0) {
        this.updateStatusText();
      }
      await this.flushPendingInsertions();
    }
  }

  async handleRecordingError(error) {
    this.isRecording = false;
    this.stopRecordingTimer();

    // Force cleanup of resources
    this.cleanup();

    let errorMessageKey = "inputPrompt.recordingFailed";

    if (
      error.name === "NotAllowedError" ||
      error.name === "PermissionDeniedError"
    ) {
      errorMessageKey = "inputPrompt.permissionDenied";
    } else if (error.name === "NotFoundError") {
      errorMessageKey = "inputPrompt.noMicrophone";
    } else if (error.name === "NotReadableError") {
      errorMessageKey = "inputPrompt.microphoneBusy";
    } else if (error.name === "OverconstrainedError") {
      errorMessageKey = "inputPrompt.microphoneUnsupported";
    }

    // The prompt is no longer shown during "starting", so a getUserMedia
    // failure must reveal it here to surface the error.
    this.promptElement.classList.add("visible");
    this.promptText.textContent = t(errorMessageKey);
    this.statusText.textContent = t("inputPrompt.checkMicrophone");

    this.scheduleHidePrompt(3000);
  }

  async typeText(text, options = {}) {
    const { suppressUi = false } = options;
    if (!hasMeaningfulText(text)) {
      if (!suppressUi) {
        this.statusText.textContent = t("inputPrompt.noSpeech");
        this.statusText.style.color = "var(--status-warning)";
        this.scheduleHidePrompt(1500);
      }
      return { ok: false, noText: true };
    }

    // Send the transcribed text to the active application.
    try {
      const result = await ipc.invoke("type-text", text, textShape(text));

      // Any backend success means the text was injected directly (there is no
      // clipboard fallback). `method` differs per OS ("cgevent_unicode" on
      // macOS, "enigo_text" on Windows/Linux) and is kept only for diagnostics.
      if (result?.success) {
        if (!suppressUi) {
          this.statusText.textContent = t("inputPrompt.textInserted");
          this.statusText.style.color = "var(--status-success)";
          this.hidePrompt();
        }
        return { ok: true, method: result.method, direct: true };
      }

      if (result?.skippedNoText) {
        if (!suppressUi) {
          this.statusText.textContent = t("inputPrompt.noSpeech");
          this.statusText.style.color = "var(--status-warning)";
          this.scheduleHidePrompt(1500);
        }
        return { ok: false, noText: true };
      }

      // Insertion failed. By design there is NO clipboard fallback: the
      // transcription is already saved to history (and still shown on this
      // prompt), so we point the user there instead of touching their clipboard.
      console.warn("Text insertion failed in backend:", result);
      if (!suppressUi) {
        this.statusText.textContent = t("inputPrompt.insertFailed");
        this.statusText.style.color = "var(--status-warning-strong)";
        this.scheduleHidePrompt(2500);
      }
      return { ok: false, message: result?.message };
    } catch (error) {
      console.error("Failed to process text:", error);
      if (!suppressUi) {
        this.statusText.textContent = t("inputPrompt.insertFailed");
        this.statusText.style.color = "var(--status-warning-strong)";
        this.scheduleHidePrompt(2500);
      }
      return { ok: false, message: error?.message };
    }
  }

  startWaveAnimation() {
    // Scrolling volume history: x-axis is time. Each tick we measure the
    // current loudness (RMS) and push it in from the right; older samples
    // slide left and off the edge — like a real moving waveform, not a
    // static frequency spectrum.
    const bars = Array.from(this.waveContainer.querySelectorAll(".wave-bar"));
    const barCount = bars.length;
    const history = new Array(barCount).fill(0);

    const SAMPLE_INTERVAL_MS = 65; // ~1.5s of audio spread across the bars
    const MAX_HEIGHT = 25; // container is 28px tall
    const MIN_HEIGHT = 3;

    // Perceived loudness is logarithmic (dB), so the old LINEAR map (rms * 6)
    // made soft-but-clear speech barely lift off the floor — RMS ~0.02–0.05
    // gave only 3–7.5px of 25 — while it saturated by RMS ~0.17. The meter
    // looked dead when the mic was fine, so you couldn't tell it was hearing
    // you. Map RMS in dBFS across a window tuned for dictation instead: quiet
    // speech already fills a good chunk of the bar, and the whole usable range
    // is spread out rather than crammed into the loud end. Display-only — this
    // never touches the audio uploaded for transcription.
    const FLOOR_DB = -50; // ~RMS 0.003 (room tone) → empty
    const CEIL_DB = -12; //  ~RMS 0.25 (loud speech) → full
    const ACTIVE_AMPLITUDE = 0.3; // glow once mapped level clears this (~RMS 0.012)

    const rmsToAmplitude = (rms) => {
      if (rms <= 0) return 0;
      const db = 20 * Math.log10(rms);
      const span = CEIL_DB - FLOOR_DB;
      return Math.max(0, Math.min(1, (db - FLOOR_DB) / span));
    };

    const sampleVolume = () => {
      if (!this.analyser || !this.dataArray) {
        return Math.random() * 0.15; // fallback so the wave still scrolls
      }
      this.analyser.getByteTimeDomainData(this.dataArray);
      let sumSquares = 0;
      for (let i = 0; i < this.dataArray.length; i++) {
        const v = (this.dataArray[i] - 128) / 128; // centered samples, -1..1
        sumSquares += v * v;
      }
      return Math.sqrt(sumSquares / this.dataArray.length);
    };

    const render = () => {
      for (let i = 0; i < barCount; i++) {
        const amplitude = rmsToAmplitude(history[i]);
        bars[i].style.height = `${Math.max(MIN_HEIGHT, amplitude * MAX_HEIGHT)}px`;
        bars[i].classList.toggle("active", amplitude > ACTIVE_AMPLITUDE);
      }
    };

    let lastSampleAt = 0;
    const animate = (now) => {
      if (!this.isRecording) return;

      const t = now || performance.now();
      if (t - lastSampleAt >= SAMPLE_INTERVAL_MS) {
        lastSampleAt = t;
        history.shift(); // drop the oldest (leftmost) sample
        history.push(sampleVolume()); // newest enters on the right
        render(); // CSS height transition smooths the leftward scroll
      }

      this.animationId = requestAnimationFrame(animate);
    };

    this.animationId = requestAnimationFrame(animate);
  }

  stopWaveAnimation() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    // Reset wave bars
    const bars = this.waveContainer.querySelectorAll(".wave-bar");
    bars.forEach((bar) => {
      bar.style.height = "3px";
      bar.classList.remove("active");
    });
  }

  hidePrompt() {
    this.cleanup();
    this.stopRecordingTimer();
    this.clearHidePromptTimer();
    this.clearActualHideTimer();
    this.clearPendingInsertions();
    this.isFlushingInsertQueue = false;
    
    this.promptElement.classList.remove("visible", "recording");
    this.clearTranscriptionPreview();
    this.updateShortcutHint(this.recordShortcut, this.translateShortcut);
    this.statusText.textContent = "";
    this.statusText.style.color = "";

    // Reset recording state
    this.isRecording = false;
    this.stopRequested = false;
    this.starting = false;
    this.recordingStartedAt = null;
    this.cancelledShortPress = false;
    this.cancelInProgress = false;
    // translateMode is set per-session on start-recording and is reset NOWHERE
    // else; without this the model badge would stick on the translate model
    // after any Shift+Alt session.
    this.translateMode = false;
    this.clearInsertFailedUi();
    this.updateModelBadge();

    this.actualHideTimerId = setTimeout(() => {
      this.actualHideTimerId = null;
      ipc.invoke("hide-input-prompt");
    }, 300);
  }
}

async function initializeInputPromptPage() {
  // This entry script is delivered twice — once via the <script> tag in
  // input-prompt.html and once via the on-page-load injection from the Rust
  // backend. Without a guard both run and construct two VoiceInputPrompt
  // instances, so every utterance is recorded, transcribed and inserted twice.
  // The flag lives on `window` so both script scopes share it.
  if (window.__sayTypeInputPromptStarted) {
    return;
  }
  window.__sayTypeInputPromptStarted = true;

  try {
    const settings = await ipc.invoke("get-settings");
    isDev = settings?.isDev ?? false;
    initI18n(settings?.uiLanguage);
    applyTheme(settings?.uiTheme);
  } catch (error) {
    console.error("Failed to load UI language settings:", error);
    initI18n("auto");
    applyTheme("elegant");
  }
  watchSystemTheme();
  new VoiceInputPrompt();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void initializeInputPromptPage();
  }, { once: true });
} else {
  void initializeInputPromptPage();
}
