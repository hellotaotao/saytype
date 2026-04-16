const { ipcRenderer } = require("electron");
const { initI18n, setLanguage, applyI18n, t } = window.WhispLineI18n;

let isDev = false;

const SHORT_PRESS_THRESHOLD_MS = 500;
const DEFAULT_RECORD_SHORTCUT = "Ctrl+Shift";
const DEFAULT_TRANSLATE_SHORTCUT = "Shift+Alt";
const DEBUG_MICROPHONE_CLEANUP = false;
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
  }

  createWaveBars() {
    for (let i = 0; i < 16; i++) {
      const bar = document.createElement("div");
      bar.className = "wave-bar";
      bar.style.height = "3px";
      this.waveContainer.appendChild(bar);
    }
  }

  setupEventListeners() {
    ipcRenderer.on("shortcut-updated", (event, payload) => {
      if (!payload) {
        return;
      }
      const recordShortcut = payload.recordShortcut || DEFAULT_RECORD_SHORTCUT;
      const translateShortcut =
        payload.translateShortcut || DEFAULT_TRANSLATE_SHORTCUT;
      this.updateShortcutHint(recordShortcut, translateShortcut);
    });

    ipcRenderer.on("ui-language-updated", (event, payload) => {
      if (!payload) {
        return;
      }
      setLanguage(payload.language);
      applyI18n(document);
      this.updateShortcutHint(this.recordShortcut, this.translateShortcut);
    });

    ipcRenderer.on("ui-theme-updated", (event, payload) => {
      if (!payload) {
        return;
      }
      applyTheme(payload.theme);
    });

    // Listen for start recording from main process
    ipcRenderer.on("start-recording", async (event, translateMode = false) => {
      if (this.isRecording || this.starting) {
        return;
      }
      this.stopRequested = false;
      this.translateMode = translateMode;
      await this.startRecording();
    });

    // Listen for stop recording from main process
    ipcRenderer.on("stop-recording", () => {
      this.stopRequested = true;
      this.stopRecording();
    });

    ipcRenderer.on("cancel-recording", () => {
      this.cancelRecording();
    });

    // Listen for cleanup microphone signal
    ipcRenderer.on("cleanup-microphone", () => {
      this.cleanup();
    });

    // Legacy support for toggle recording
    ipcRenderer.on("toggle-recording", async () => {
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
      const settings = await ipcRenderer.invoke("get-settings");
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
          await this.typeText(text, { suppressUi: true });
          insertedAny = true;
        }
      }
    } finally {
      this.isFlushingInsertQueue = false;
    }

    if (!this.isRecording && !this.starting && !this.pendingInsertionOrder.length) {
      if (insertedAny) {
        this.statusText.textContent = t("inputPrompt.textInserted");
        this.statusText.style.color = "var(--status-success)";
        setTimeout(() => this.hidePrompt(), 1200);
      } else {
        this.statusText.textContent = t("inputPrompt.noSpeech");
        this.statusText.style.color = "var(--status-warning)";
        setTimeout(() => this.hidePrompt(), 1500);
      }
    } else {
      this.updateStatusText();
    }
  }

  clearPendingInsertions() {
    this.pendingInsertionOrder = [];
    this.pendingInsertionsById.clear();
  }

  async startRecording() {
    if (this.isRecording || this.starting) return;

    this.starting = true;
    try {
      // Show prompt immediately
      this.promptElement.classList.add("visible");
      this.promptText.textContent = t("inputPrompt.starting");
      this.statusText.textContent = "";
      if (!this.pendingInsertionOrder.length && this.transcriptionInProgressCount === 0) {
        this.transcriptionText.textContent = "";
        this.transcriptionText.classList.remove("visible");
      }

      // Create media stream directly using getUserMedia
      // In Electron, system-level permissions are handled by main process
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 44100,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      if (this.stopRequested) {
        this.mediaStream = stream;
        this.cleanup();
        this.hidePrompt();
        return;
      }

      this.mediaStream = stream;

      // Update UI for recording state after permissions resolve
      this.promptElement.classList.add("recording");
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

      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

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
    const elapsedMs = this.recordingStartedAt
      ? Date.now() - this.recordingStartedAt
      : 0;
    const isShortPress = elapsedMs <= SHORT_PRESS_THRESHOLD_MS;
    const shouldCancel = this.cancelledShortPress || this.cancelInProgress || isShortPress;
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
    this.clearPendingInsertions();

    if (this.transcriptionInProgressCount > 0) {
      ipcRenderer.invoke("cancel-transcription").catch(() => {});
      this.promptText.textContent = t("inputPrompt.cancelled");
      this.statusText.textContent = "";
      this.cleanup();
      this.stopWaveAnimation();
      setTimeout(() => this.hidePrompt(), 300);
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
    setTimeout(() => this.hidePrompt(), 300);
  }

  cleanup(options = {}) {
    const { preserveAudioChunks = false } = options;
    logMicrophoneCleanup("Starting microphone cleanup...");
    
    // Stop all media tracks
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
          setTimeout(() => this.hidePrompt(), 300);
        }
        return;
      }
      if (!chunks.length) {
        console.warn("No audio chunks captured; skipping transcription request");
        this.removePendingInsertion(sessionId);
        if (allowUi) {
          this.statusText.textContent = t("inputPrompt.noAudio");
          this.statusText.style.color = "var(--status-warning)";
          setTimeout(() => this.hidePrompt(), 1500);
        }
        return;
      }

      const audioBlob = new Blob(chunks, {
        type: mimeType || "audio/webm", // Use actual recording format
      });
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);

      const transcription = await ipcRenderer.invoke(
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
          setTimeout(() => this.hidePrompt(), 2000);
        }
      }
    } catch (error) {
      console.error("Transcription error:", error);
      this.removePendingInsertion(sessionId);
      const isCancelled =
        error &&
        (error.name === "TranscriptionCancelledError" ||
          (typeof error.message === "string" && error.message.includes("TRANSCRIPTION_CANCELLED")));
      if (allowUi) {
        if (isCancelled) {
          this.statusText.textContent = t("inputPrompt.cancelled");
          this.statusText.style.color = "var(--status-warning)";
          setTimeout(() => this.hidePrompt(), 300);
        } else {
          this.statusText.textContent = t("inputPrompt.transcriptionFailed");
          setTimeout(() => this.hidePrompt(), 3000);
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

    this.promptText.textContent = t(errorMessageKey);
    this.statusText.textContent = t("inputPrompt.checkMicrophone");

    setTimeout(() => this.hidePrompt(), 3000);
  }

  async handleTextProcessingFailure(text, messageOverride, options = {}) {
    const { suppressUi = false } = options;
    if (!hasMeaningfulText(text)) {
      if (!suppressUi) {
        this.statusText.textContent = t("inputPrompt.noSpeech");
        this.statusText.style.color = "var(--status-warning)";
        setTimeout(() => this.hidePrompt(), 1500);
      }
      return;
    }

    const fallbackMessage =
      typeof messageOverride === "string" && messageOverride.trim()
        ? messageOverride
        : t("inputPrompt.textProcessingFailed");

    if (!suppressUi) {
      this.statusText.textContent = fallbackMessage;
      this.statusText.style.color = "var(--status-warning-strong)";
    }

    // Final fallback: copy to clipboard
    try {
      const pasteShortcut = this.getPasteShortcutLabel();
      await navigator.clipboard.writeText(text);
      if (!suppressUi) {
        this.statusText.textContent = t("inputPrompt.textCopiedFallback", {
          shortcut: pasteShortcut,
        });
        this.statusText.style.color = "var(--status-warning)";
        setTimeout(() => this.hidePrompt(), 3000);
      }
    } catch (clipboardError) {
      console.error("Failed to copy to clipboard:", clipboardError);
      if (!suppressUi) {
        this.statusText.textContent = t("inputPrompt.errorCouldNotProcess");
        this.statusText.style.color = "var(--status-danger)";
        setTimeout(() => this.hidePrompt(), 3000);
      }
    }
  }

  async typeText(text, options = {}) {
    const { suppressUi = false } = options;
    if (!hasMeaningfulText(text)) {
      if (!suppressUi) {
        this.statusText.textContent = t("inputPrompt.noSpeech");
        this.statusText.style.color = "var(--status-warning)";
        setTimeout(() => this.hidePrompt(), 1500);
      }
      return;
    }

    // Send the transcribed text to the active application
    try {
      const result = await ipcRenderer.invoke("type-text", text);

      if (!result || !result.success) {
        if (result?.skippedNoText) {
          if (!suppressUi) {
            this.statusText.textContent = t("inputPrompt.noSpeech");
            this.statusText.style.color = "var(--status-warning)";
            setTimeout(() => this.hidePrompt(), 1500);
          }
          return;
        }
        console.warn("Text processing failed in main process:", result);
        await this.handleTextProcessingFailure(text, result?.message, { suppressUi });
        return;
      }

      const pasteShortcut = this.getPasteShortcutLabel();

      if (result.method === "direct_typing") {
        if (!suppressUi) {
          this.statusText.textContent = t("inputPrompt.textTypedDirect");
          this.statusText.style.color = "var(--status-success)";
          setTimeout(() => this.hidePrompt(), 1500);
        }
      } else if (result.method === "koffi_sendinput") {
        // Windows SendInput method
        if (!suppressUi) {
          this.statusText.textContent = t("inputPrompt.textInserted");
          this.statusText.style.color = "var(--status-success)";
          // Hide prompt immediately after successful insertion on Windows
          this.hidePrompt();
        }
      } else if (result.method === "cgevent_unicode") {
        // macOS CGEvent Unicode method
        if (!suppressUi) {
          this.statusText.textContent = t("inputPrompt.textInserted");
          this.statusText.style.color = "var(--status-success)";
          // Hide prompt immediately after successful insertion
          this.hidePrompt();
        }
      } else if (result.method === "clipboard_textinsert") {
        const isPartial =
          typeof result.message === "string" &&
          result.message.includes("partially restored");
        if (!suppressUi) {
          this.statusText.textContent = isPartial
            ? t("inputPrompt.textInsertedPartial")
            : t("inputPrompt.textInsertedAuto");

          // Different colors based on message complexity
          if (isPartial) {
            this.statusText.style.color = "var(--status-warning)"; // Orange for partial restoration
          } else {
            this.statusText.style.color = "var(--status-success)"; // Green for full restoration
          }

          // Close immediately after successful insertion
          this.hidePrompt();
        }
      } else if (result.method === "clipboard") {
        if (!suppressUi) {
          this.statusText.textContent = t("inputPrompt.textCopied", {
            shortcut: pasteShortcut,
          });
          this.statusText.style.color = "var(--status-warning)";
          setTimeout(() => this.hidePrompt(), 3000);
        }
      } else {
        if (!suppressUi) {
          this.statusText.textContent = result.message || t("inputPrompt.textInserted");
          this.statusText.style.color = "var(--status-success)";
          this.hidePrompt();
        }
      }
    } catch (error) {
      console.error("Failed to process text:", error);
      await this.handleTextProcessingFailure(text, null, options);
    }
  }

  getPasteShortcutLabel() {
    const isMac = window.navigator?.platform?.includes("Mac");
    return isMac ? "Cmd+V" : "Ctrl+V";
  }

  startWaveAnimation() {
    const bars = this.waveContainer.querySelectorAll(".wave-bar");

    const animate = () => {
      if (!this.isRecording) return;

      if (this.analyser && this.dataArray) {
        this.analyser.getByteFrequencyData(this.dataArray);

        bars.forEach((bar, index) => {
          const dataIndex = Math.floor(
            (index / bars.length) * this.dataArray.length
          );
          const amplitude = this.dataArray[dataIndex] / 255;
          const height = Math.max(3, amplitude * 25);

          bar.style.height = `${height}px`;
          bar.classList.toggle("active", amplitude > 0.1);
        });
      } else {
        // Fallback random animation
        bars.forEach((bar) => {
          const height = Math.random() * 20 + 3;
          bar.style.height = `${height}px`;
          bar.classList.toggle("active", Math.random() > 0.5);
        });
      }

      this.animationId = requestAnimationFrame(animate);
    };

    animate();
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
    // Force cleanup of any remaining resources
    this.cleanup();
    this.stopRecordingTimer();
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

    setTimeout(() => {
      ipcRenderer.invoke("hide-input-prompt");
    }, 300);
  }
}

// Initialize when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  const initialize = async () => {
    try {
      const settings = await ipcRenderer.invoke("get-settings");
      isDev = settings?.isDev ?? false;
      initI18n(settings?.uiLanguage);
      applyTheme(settings?.uiTheme);
    } catch (error) {
      console.error("Failed to load UI language settings:", error);
      initI18n("auto");
      applyTheme("elegant");
    }
    new VoiceInputPrompt();
  };
  initialize();
});
