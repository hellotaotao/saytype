if (typeof document !== "undefined" && document.documentElement) {
  document.documentElement.setAttribute("data-input-prompt-js-ran", "1");
}

const ipc = window.__SAYTYPE_IPC__;
const { initI18n, setLanguage, applyI18n, t } = window.SayTypeI18n;

let isDev = false;

const DEFAULT_RECORD_SHORTCUT = "Ctrl+Shift";
const DEFAULT_TRANSLATE_SHORTCUT = "Shift+Alt";
const DEBUG_MICROPHONE_CLEANUP = false;
// B: keep the microphone "warm" after a recording so the next one starts
// instantly instead of paying the getUserMedia cold-start cost (which is what
// drops the first words). The stream is only released once we've been fully
// idle — no recording AND no in-flight transcription — for MIC_IDLE_RELEASE_MS.
const MIC_KEEP_WARM = true;
const MIC_IDLE_RELEASE_MS = 6000;
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
    this.idleReleaseTimerId = null;
    this.keepMicWarm = MIC_KEEP_WARM;
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

    ipc.on("keep-mic-warm-updated", (event, payload) => {
      if (!payload) {
        return;
      }
      this.keepMicWarm = payload.keepMicWarm !== false;
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
      // When keeping the mic warm, hiding the window must NOT tear down the
      // stream — the idle-release timer owns that. Otherwise release now.
      if (this.shouldKeepWarm() && this.mediaStream) {
        this.maybeScheduleIdleRelease();
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
      this.keepMicWarm = settings.keepMicWarm !== false;
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
        // Clipboard fallback succeeded — brief acknowledgement.
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
    // A warm stream may be queued for release — claim it before that fires.
    this.clearIdleReleaseTimer();
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

      // Reuse a still-warm stream from a recent recording when we have one —
      // this is what eliminates the getUserMedia cold-start delay (and the
      // dropped first words) on back-to-back recordings. Otherwise acquire a
      // fresh one.
      // On macOS, microphone/Accessibility permissions are handled by the OS and the Rust backend
      let stream = this.takeWarmStream();
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 44100,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
      }

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

    // Keep the mic warm after a real recording so the next one starts
    // instantly; a cancelled/short press releases it right away. The idle
    // release countdown is (re)armed once transcription settles — see
    // processRecording's finally block and maybeScheduleIdleRelease().
    const keepWarm = this.shouldKeepWarm() && !shouldCancel;
    this.cleanup({ preserveAudioChunks: true, preserveStream: keepWarm });
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
    const { preserveAudioChunks = false, preserveStream = false } = options;
    logMicrophoneCleanup("Starting microphone cleanup...");

    // Stop all media tracks — unless we're intentionally keeping the stream
    // warm for the next recording. When we DO release, also cancel any pending
    // idle-release timer since the mic is gone.
    if (this.mediaStream && !preserveStream) {
      this.clearIdleReleaseTimer();
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

  shouldKeepWarm() {
    return this.keepMicWarm;
  }

  clearIdleReleaseTimer() {
    if (this.idleReleaseTimerId) {
      clearTimeout(this.idleReleaseTimerId);
      this.idleReleaseTimerId = null;
    }
  }

  // Return the warm mic stream if one is still live and reusable, claiming it
  // (cancelling its pending release). Returns null when there's nothing warm
  // or the tracks have since ended, so the caller acquires a fresh stream.
  takeWarmStream() {
    if (!this.shouldKeepWarm() || !this.mediaStream) {
      return null;
    }
    const audioTracks = this.mediaStream.getAudioTracks();
    const live =
      audioTracks.length > 0 &&
      audioTracks.every((track) => track.readyState === "live");
    if (!live) {
      this.releaseWarmStream();
      return null;
    }
    this.clearIdleReleaseTimer();
    return this.mediaStream;
  }

  // Arm the idle-release countdown, but only when we're genuinely idle: not
  // recording, not starting, and no transcription still in flight. This is why
  // the timer is anchored to "transcription finished", not "recording stopped".
  maybeScheduleIdleRelease() {
    this.clearIdleReleaseTimer();
    if (!this.shouldKeepWarm() || !this.mediaStream) {
      return;
    }
    if (this.isRecording || this.starting || this.transcriptionInProgressCount > 0) {
      return;
    }
    this.idleReleaseTimerId = setTimeout(() => {
      this.idleReleaseTimerId = null;
      // Re-check: a recording/transcription may have begun during the wait.
      if (this.isRecording || this.starting || this.transcriptionInProgressCount > 0) {
        return;
      }
      this.releaseWarmStream();
    }, MIC_IDLE_RELEASE_MS);
  }

  // Hard-release the warm stream and its audio graph. Driven by the idle timer.
  releaseWarmStream() {
    this.clearIdleReleaseTimer();
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;
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
      // Once the last transcription settles we may be fully idle — start the
      // countdown to release the warm mic. Anchored here (not at recording
      // stop) so the 6s window covers "saw the result, decide to add a line".
      this.maybeScheduleIdleRelease();
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

  async handleTextProcessingFailure(text, messageOverride, options = {}) {
    const { suppressUi = false } = options;
    if (!hasMeaningfulText(text)) {
      if (!suppressUi) {
        this.statusText.textContent = t("inputPrompt.noSpeech");
        this.statusText.style.color = "var(--status-warning)";
        this.scheduleHidePrompt(1500);
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
        this.scheduleHidePrompt(3000);
      }
    } catch (clipboardError) {
      console.error("Failed to copy to clipboard:", clipboardError);
      if (!suppressUi) {
        this.statusText.textContent = t("inputPrompt.errorCouldNotProcess");
        this.statusText.style.color = "var(--status-danger)";
        this.scheduleHidePrompt(3000);
      }
    }
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

    // Send the transcribed text to the active application
    try {
      const result = await ipc.invoke("type-text", text);

      if (!result || !result.success) {
        if (result?.skippedNoText) {
          if (!suppressUi) {
            this.statusText.textContent = t("inputPrompt.noSpeech");
            this.statusText.style.color = "var(--status-warning)";
            this.scheduleHidePrompt(1500);
          }
          return { ok: false, noText: true };
        }
        console.warn("Text processing failed in main process:", result);
        await this.handleTextProcessingFailure(text, result?.message, { suppressUi });
        return { ok: false, message: result?.message };
      }

      const directMethods = new Set(["cgevent_unicode"]);
      const isDirect = directMethods.has(result.method);
      const pasteShortcut = this.getPasteShortcutLabel();

      if (result.method === "cgevent_unicode") {
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
          this.scheduleHidePrompt(3000);
        }
      } else {
        if (!suppressUi) {
          this.statusText.textContent = result.message || t("inputPrompt.textInserted");
          this.statusText.style.color = "var(--status-success)";
          this.hidePrompt();
        }
      }
      return { ok: true, method: result.method, direct: isDirect };
    } catch (error) {
      console.error("Failed to process text:", error);
      await this.handleTextProcessingFailure(text, null, options);
      return { ok: false, message: error?.message };
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
    // Keep the mic warm across the window hiding when enabled — only release the
    // stream here if we're NOT keeping it warm. When kept warm, the idle-release
    // timer (armed below) is the single owner of releasing the mic. (On cancel/
    // error paths the stream is already gone, so this preserves nothing.)
    this.cleanup({ preserveStream: this.shouldKeepWarm() });
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

    // If a warm stream survived the cleanup above, start its release countdown.
    this.maybeScheduleIdleRelease();

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
