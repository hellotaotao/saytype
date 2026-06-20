if (typeof document !== "undefined" && document.documentElement) {
  document.documentElement.setAttribute("data-input-prompt-js-ran", "1");
}

const ipc = window.__SAYTYPE_IPC__;
const { initI18n, setLanguage, applyI18n, t } = window.SayTypeI18n;

let isDev = false;

const DEFAULT_RECORD_SHORTCUT = "Ctrl+Shift";
const DEFAULT_TRANSLATE_SHORTCUT = "Shift+Alt";
const DEBUG_MICROPHONE_CLEANUP = false;
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
const themeOptions = new Set(["midnight", "elegant"]);

function resolveTheme(value) {
  return themeOptions.has(value) ? value : "elegant";
}

function applyTheme(value) {
  document.documentElement.setAttribute("data-theme", resolveTheme(value));
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

    this.promptElement = document.getElementById("inputPrompt");
    this.promptText = document.getElementById("promptText");
    this.waveContainer = document.getElementById("waveContainer");
    this.statusText = document.getElementById("statusText");
    this.transcriptionText = document.getElementById("transcriptionText");

    this.createWaveBars();
    this.setupEventListeners();
    this.syncShortcutFromSettings();
    this.primeMicrophone();
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
    ipc.on("shortcut-updated", (event, payload) => {
      if (!payload) {
        return;
      }
      const recordShortcut = payload.recordShortcut || DEFAULT_RECORD_SHORTCUT;
      const translateShortcut =
        payload.translateShortcut || DEFAULT_TRANSLATE_SHORTCUT;
      this.updateShortcutHint(recordShortcut, translateShortcut);
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
    ipc.on("start-recording", async (event, translateMode = false) => {
      if (this.isRecording || this.starting) {
        return;
      }
      this.stopRequested = false;
      this.translateMode = translateMode;
      await this.startRecording();
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
  }

  async syncShortcutFromSettings() {
    try {
      const settings = await ipc.invoke("get-settings");
      if (!settings) {
        return;
      }
      this.updateShortcutHint(
        settings.shortcut || DEFAULT_RECORD_SHORTCUT,
        settings.translateShortcut || DEFAULT_TRANSLATE_SHORTCUT
      );
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
    const isMac = window.navigator?.platform?.includes("Mac");
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
    this.transcriptionText.textContent = transcription;
    this.transcriptionText.classList.add("visible");
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
        this.statusText.textContent = t("inputPrompt.insertFailed");
        this.statusText.style.color = "var(--status-warning-strong)";
        this.scheduleHidePrompt(2500);
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

  async hasUsableApiKey() {
    try {
      const settings = await ipc.invoke("get-settings");
      if (!settings) {
        return true;
      }
      // Mirror the backend's selected_api_key(): OpenAI uses the OpenAI key
      // (falling back to the legacy shared key), any other provider uses Groq.
      const key =
        settings.provider === "openai"
          ? settings.apiKeyOpenAI || settings.apiKey
          : settings.apiKeyGroq || settings.apiKey;
      return hasMeaningfulText(key);
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

  async startRecording() {
    if (this.isRecording || this.starting) return;

    this.clearHidePromptTimer();
    this.clearActualHideTimer();
    this.starting = true;
    try {
      // Pre-flight: without an API key the request can only fail, so tell the
      // user immediately instead of recording and failing after they speak.
      if (!(await this.hasUsableApiKey())) {
        this.showApiKeyRequired();
        return;
      }

      // Do NOT reveal the prompt during "starting": the window appearing is the
      // signal users act on, and if it shows before the mic is actually open
      // they start talking while getUserMedia is still spinning up and lose the
      // first words. We only prep state here; the prompt is revealed (straight
      // into the Listening state) after getUserMedia resolves below.
      this.statusText.textContent = "";
      if (!this.pendingInsertionOrder.length && this.transcriptionInProgressCount === 0) {
        this.transcriptionText.textContent = "";
        this.transcriptionText.classList.remove("visible");
      }

      // Acquire a fresh stream for this recording; it is fully released when
      // recording stops, so the mic indicator only shows while recording. The
      // launch prime keeps the first dictation fast despite the fresh open.
      // On macOS, microphone/Accessibility permissions are handled by the OS and the Rust backend.
      const stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);

      if (this.stopRequested) {
        this.mediaStream = stream;
        this.cleanup();
        this.hidePrompt();
        return;
      }

      this.mediaStream = stream;

      // Reveal the prompt now — the mic is open, so the instant the window
      // appears it already means "you can talk" (Listening), never "starting".
      this.promptElement.classList.add("visible", "recording");
      if (this.translateMode) {
        this.promptText.textContent = t("inputPrompt.listeningEnglish");
      } else {
        this.promptText.textContent = t("inputPrompt.listening");
      }

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

      this.mediaRecorder.start();
      this.recordingStartedAt = Date.now();
      this.cancelledShortPress = false;
      this.isRecording = true;
      this.startWaveAnimation();
      this.startRecordingTimer();

      if (this.stopRequested) {
        this.stopRecording();
      }
    } catch (error) {
      console.error("Error starting recording:", error);
      if (this.activeRecordingSession) {
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
      this.transcriptionText.textContent = "";
      this.transcriptionText.classList.remove("visible");
    } else {
      this.promptText.textContent = t("inputPrompt.processing");
      this.statusText.textContent = t("inputPrompt.transcribing");
    }

    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      this.mediaRecorder.stop();
    }

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
    this.clearPendingInsertions();

    if (this.transcriptionInProgressCount > 0) {
      ipc.invoke("cancel-transcription").catch(() => {});
      this.promptText.textContent = t("inputPrompt.cancelled");
      this.statusText.textContent = "";
      this.cleanup();
      this.stopWaveAnimation();
      this.scheduleHidePrompt(300);
      return;
    }

    if (this.isRecording) {
      this.cancelledShortPress = true;
      this.stopRecording();
      return;
    }

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
    const allowUi = sessionId === this.recordingSessionId && !this.isRecording && !this.starting;

    this.transcriptionInProgressCount += 1;
    this.updateStatusText();
    try {
      if (cancelledShortPress) {
        this.removePendingInsertion(sessionId);
        if (allowUi) {
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
        console.warn("No audio chunks captured; skipping transcription request");
        this.removePendingInsertion(sessionId);
        if (allowUi) {
          this.statusText.textContent = t("inputPrompt.noAudio");
          this.statusText.style.color = "var(--status-warning)";
          this.scheduleHidePrompt(1500);
        }
        return;
      }

      const audioBlob = new Blob(chunks, {
        type: mimeType || "audio/webm", // Use actual recording format
      });
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioBuffer = Array.from(new Uint8Array(arrayBuffer));

      const transcription = await ipc.invoke(
        "transcribe-audio",
        audioBuffer,
        translateMode,
        mimeType // Pass the actual MIME type
      );

      if (transcription && transcription.trim()) {
        this.storeTranscriptionResult(sessionId, transcription);
        this.updateStatusText();
        await this.flushPendingInsertions();
      } else {
        this.removePendingInsertion(sessionId);
        if (allowUi) {
          this.statusText.textContent = t("inputPrompt.noSpeech");
          this.scheduleHidePrompt(2000);
        }
      }
    } catch (error) {
      console.error("Transcription error:", error);
      this.removePendingInsertion(sessionId);
      // Tauri rejects with the command's Err value, which is the raw string for
      // a Result<_, String>, so handle both string and Error shapes.
      const message =
        typeof error === "string"
          ? error
          : typeof error?.message === "string"
            ? error.message
            : String(error ?? "");
      const isCancelled =
        (error && error.name === "TranscriptionCancelledError") ||
        message.includes("TRANSCRIPTION_CANCELLED");
      if (allowUi) {
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
        } else {
          this.statusText.textContent = message
            ? t("inputPrompt.transcriptionFailedReason", { reason: message })
            : t("inputPrompt.transcriptionFailed");
          this.statusText.style.color = "var(--status-warning-strong)";
          this.scheduleHidePrompt(4000);
        }
      }
    } finally {
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
      const result = await ipc.invoke("type-text", text);

      if (result?.success && result.method === "cgevent_unicode") {
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
    const GAIN = 6; // speech RMS is small (~0.05–0.3); amplify to fill height
    const MAX_HEIGHT = 25; // container is 28px tall
    const ACTIVE_THRESHOLD = 0.04; // glow bars where sound is actually present

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
        const level = history[i];
        const amplitude = Math.min(1, level * GAIN);
        bars[i].style.height = `${Math.max(3, amplitude * MAX_HEIGHT)}px`;
        bars[i].classList.toggle("active", level > ACTIVE_THRESHOLD);
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
    this.transcriptionText.classList.remove("visible");
    this.updateShortcutHint(this.recordShortcut, this.translateShortcut);
    this.statusText.textContent = "";
    this.statusText.style.color = "";
    this.transcriptionText.textContent = "";

    // Reset recording state
    this.isRecording = false;
    this.stopRequested = false;
    this.starting = false;
    this.recordingStartedAt = null;
    this.cancelledShortPress = false;
    this.cancelInProgress = false;

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
  new VoiceInputPrompt();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void initializeInputPromptPage();
  }, { once: true });
} else {
  void initializeInputPromptPage();
}
