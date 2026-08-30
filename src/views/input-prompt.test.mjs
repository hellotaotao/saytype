import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as chunkDecision from "./chunk-decision.mjs";
import { encodeWavPcm16 } from "./vad-decision.mjs";

const defaultSourcePath = fileURLToPath(new URL("./input-prompt.js", import.meta.url));

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function loadVoiceInputPrompt(options = {}) {
  const sourcePath = process.env.SAYTYPE_INPUT_PROMPT_SOURCE || defaultSourcePath;
  const source = readFileSync(sourcePath, "utf8");
  const quietConsole = {
    log() {},
    warn() {},
    error() {},
  };
  const documentElement = {
    setAttribute() {},
  };
  const document = {
    documentElement,
    readyState: "complete",
    addEventListener() {},
    // setTranscriptionPreview/clearTranscriptionPreview toggle a class here to
    // drive the layering CSS; stub it so those paths don't NPE under the vm.
    body: { classList: { add() {}, remove() {}, toggle() {} } },
  };
  const window = {
    __sayTypeInputPromptStarted: true,
    __SAYTYPE_IPC__: {
      invoke(command, ...args) {
        if (command === "report-transcription-lifecycle" && !options.captureLifecycle) {
          return Promise.resolve(null);
        }
        return options.invoke ? options.invoke(command, ...args) : Promise.resolve(null);
      },
      on: options.on || (() => {}),
    },
    SayTypeI18n: {
      initI18n() {},
      setLanguage() {},
      applyI18n() {},
      t(key, values) {
        return values?.reason ? `${key}: ${values.reason}` : key;
      },
    },
    SayTypeVadGate: null,
    matchMedia() {
      return {
        matches: false,
        addEventListener() {},
      };
    },
    addEventListener() {},
  };
  Object.assign(window, options.window || {});
  const context = vm.createContext({
    ArrayBuffer,
    Blob,
    console: quietConsole,
    DataView,
    document,
    navigator: {},
    performance: options.performance || performance,
    requestAnimationFrame: options.requestAnimationFrame || (() => 1),
    cancelAnimationFrame: options.cancelAnimationFrame || (() => {}),
    setInterval: options.setInterval || setInterval,
    clearInterval: options.clearInterval || clearInterval,
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
    Float32Array,
    Uint8Array,
    window,
    ...(options.globals || {}),
  });

  vm.runInContext(
    `${source}\n;globalThis.__VoiceInputPrompt = VoiceInputPrompt;\n;globalThis.__normalizeRecordingStartPayload = typeof normalizeRecordingStartPayload === "function" ? normalizeRecordingStartPayload : null;`,
    context,
    { filename: sourcePath }
  );

  context.__VoiceInputPrompt.normalizeRecordingStartPayload =
    context.__normalizeRecordingStartPayload;
  return context.__VoiceInputPrompt;
}

function createBarePrompt(VoiceInputPrompt, overrides = {}) {
  return Object.assign(
    Object.create(VoiceInputPrompt.prototype),
    {
      isRecording: false,
      starting: false,
      isFlushingInsertQueue: false,
      pendingInsertionOrder: [],
      pendingInsertionsById: new Map(),
      activeTranscriptionSessionIds: new Set(),
      cancelledTranscriptionSessionIds: new Set(),
      localTranscriptionTail: Promise.resolve(),
      transcriptionInProgressCount: 0,
      recordingSessionId: 0,
      currentProvider: "openai",
      hidePromptTimerId: null,
      promptText: { textContent: "" },
      statusText: { textContent: "", style: {} },
      updateStatusText() {},
      updateShortcutHint() {},
      setTranscriptionPreview() {},
      flushPendingInsertions: VoiceInputPrompt.prototype.flushPendingInsertions,
      ...overrides,
    }
  );
}

test("a stale hide timer cannot hide an active or starting recording", () => {
  let scheduledCallback = null;
  let hideCalls = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    setTimeout(callback) {
      scheduledCallback = callback;
      return 42;
    },
    clearTimeout() {},
  });

  for (const state of [
    { isRecording: true, starting: false },
    { isRecording: false, starting: true },
  ]) {
    const prompt = createBarePrompt(VoiceInputPrompt, {
      ...state,
      hidePrompt() {
        hideCalls += 1;
      },
    });

    prompt.scheduleHidePrompt(100);
    assert.equal(prompt.hidePromptTimerId, 42);
    scheduledCallback();
    assert.equal(prompt.hidePromptTimerId, null);
  }

  assert.equal(hideCalls, 0);
});

test("a hide timer still hides the prompt when the app remains idle", () => {
  let scheduledCallback = null;
  let hideCalls = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    setTimeout(callback) {
      scheduledCallback = callback;
      return 42;
    },
    clearTimeout() {},
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    hidePrompt() {
      hideCalls += 1;
    },
  });

  prompt.scheduleHidePrompt(100);
  scheduledCallback();

  assert.equal(hideCalls, 1);
  assert.equal(prompt.hidePromptTimerId, null);
});

test("a hide timer waits while an older transcription is still pending", () => {
  let scheduledCallback = null;
  let hideCalls = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    setTimeout(callback) {
      scheduledCallback = callback;
      return 42;
    },
    clearTimeout() {},
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    transcriptionInProgressCount: 1,
    pendingInsertionOrder: [1],
    hidePrompt() {
      hideCalls += 1;
    },
  });

  prompt.scheduleHidePrompt(100);
  scheduledCallback();

  assert.equal(hideCalls, 0);
  assert.deepEqual(prompt.pendingInsertionOrder, [1]);
  assert.equal(prompt.hidePromptTimerId, null);
});

test("Escape cancels the active recording before an older transcription", () => {
  const invoked = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, ...args) {
      invoked.push([command, ...args]);
      return Promise.resolve(true);
    },
  });
  const activeRecordingSession = { id: 2, cancelledShortPress: false };
  let stopCalls = 0;
  const prompt = createBarePrompt(VoiceInputPrompt, {
    isRecording: true,
    transcriptionInProgressCount: 1,
    activeRecordingSession,
    cancelInProgress: false,
    stopRequested: false,
    pendingInsertionOrder: [1, 2],
    stopRecordingTimer() {},
    clearHidePromptTimer() {},
    clearActualHideTimer() {},
    clearInsertFailedUi() {},
    stopWaveAnimation() {},
    stopRecording() {
      stopCalls += 1;
      this.isRecording = false;
    },
  });

  prompt.cancelRecording();

  assert.equal(stopCalls, 1);
  assert.equal(activeRecordingSession.cancelledShortPress, true);
  assert.deepEqual(prompt.pendingInsertionOrder, [1, 2]);
  assert.equal(invoked.some(([command]) => command === "cancel-transcription"), false);
});

test("Escape cancels only the latest transcription while preserving older work", () => {
  const invoked = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, ...args) {
      invoked.push([command, ...args]);
      return Promise.resolve(true);
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    transcriptionInProgressCount: 2,
    activeTranscriptionSessionIds: new Set([1, 2]),
    cancelInProgress: false,
    stopRequested: false,
    pendingInsertionOrder: [1, 2],
    pendingInsertionsById: new Map([[1, "older"]]),
    stopRecordingTimer() {},
    clearHidePromptTimer() {},
    clearActualHideTimer() {},
    clearInsertFailedUi() {},
    cleanup() {},
    stopWaveAnimation() {},
    scheduleHidePrompt() {},
  });

  prompt.cancelRecording();

  assert.deepEqual(invoked, [["cancel-transcription", 2]]);
  assert.equal(prompt.cancelledTranscriptionSessionIds.has(2), true);
  assert.deepEqual(prompt.pendingInsertionOrder, [1]);
  assert.equal(prompt.pendingInsertionsById.get(1), "older");
});

test("local partial text is shown only for the latest non-recording session", () => {
  const handlers = new Map();
  const VoiceInputPrompt = loadVoiceInputPrompt({
    on(channel, handler) {
      handlers.set(channel, handler);
    },
  });
  const previews = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 2,
    transcriptionInProgressCount: 2,
    transcriptionText: {},
    setTranscriptionPreview(text) {
      previews.push(text);
    },
    updateModelBadge() {},
  });
  prompt.setupEventListeners();
  const onPartial = handlers.get("local-transcription-partial");

  prompt.isRecording = true;
  onPartial(null, { sessionId: 1, text: "old while recording" });
  prompt.isRecording = false;
  onPartial(null, { sessionId: 1, text: "old" });
  onPartial(null, { sessionId: 2, text: "latest" });

  assert.deepEqual(previews, ["latest"]);
});

test("Nemotron partials render during recording but not after the session is idle", () => {
  const handlers = new Map();
  const VoiceInputPrompt = loadVoiceInputPrompt({
    on(channel, handler) {
      handlers.set(channel, handler);
    },
  });
  const previews = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 4,
    transcriptionInProgressCount: 0,
    transcriptionText: {},
    activeRecordingSession: { live: { sessionId: 4 } },
    isRecording: true,
    setTranscriptionPreview(text) {
      previews.push(text);
    },
    updateModelBadge() {},
  });
  prompt.setupEventListeners();
  const onPartial = handlers.get("local-transcription-partial");

  onPartial(null, { sessionId: 4, text: "live" });
  prompt.isRecording = false;
  prompt.starting = false;
  onPartial(null, { sessionId: 4, text: "late" });

  assert.deepEqual(previews, ["live"]);
});

test("start event timing includes native work and renderer delivery delay", () => {
  const VoiceInputPrompt = loadVoiceInputPrompt();
  const normalize = VoiceInputPrompt.normalizeRecordingStartPayload;

  assert.equal(typeof normalize, "function");
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalize({
      translateMode: true,
      dispatchedAtUnixMs: 1000,
      nativeMs: 80,
    }, 1300))),
    {
      translateMode: true,
      nativeMs: 80,
      eventDeliveryMs: 300,
    }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalize(false, 1300))),
    {
      translateMode: false,
      nativeMs: 0,
      eventDeliveryMs: 0,
    }
  );
});

test("recording startup reports native, delivery, microphone, and first-paint timing", async () => {
  const calls = [];
  const clock = [1000, 1010, 1160, 1170];
  const stream = {};
  class FakeAudioContext {
    createMediaStreamSource() {
      return { connect() {} };
    }

    createAnalyser() {
      return { fftSize: 0 };
    }
  }
  class FakeMediaRecorder {
    static isTypeSupported() {
      return true;
    }

    constructor() {
      this.state = "inactive";
    }

    start() {
      this.state = "recording";
    }
  }
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, payload) {
      calls.push([command, payload]);
      return Promise.resolve(null);
    },
    performance: { now: () => clock.shift() },
    requestAnimationFrame(callback) {
      callback(1550);
      return 1;
    },
    window: { AudioContext: FakeAudioContext },
    globals: {
      MediaRecorder: FakeMediaRecorder,
      navigator: { mediaDevices: { getUserMedia: async () => stream } },
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    pageStartedAt: 0,
    translateMode: false,
    cancelInProgress: true,
    stopRequested: false,
    activeRecordingSession: null,
    mediaStream: null,
    mediaRecorder: null,
    audioChunks: [],
    promptElement: { classList: { add() {} } },
    promptText: { textContent: "" },
    clearHidePromptTimer() {},
    clearActualHideTimer() {},
    clearInsertFailedUi() {},
    clearTranscriptionPreview() {},
    updateModelBadge() {},
    hasUsableApiKey: async () => true,
    startWaveAnimation() {},
    startRecordingTimer() {},
  });
  await prompt.startRecording({ nativeMs: 80, eventDeliveryMs: 300 });
  await Promise.resolve();

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[
    "report-recording-startup",
    {
      recordingNumber: 1,
      uptimeMs: 1000,
      nativeMs: 80,
      eventDeliveryMs: 300,
      preflightMs: 10,
      microphoneMs: 150,
      setupMs: 10,
      renderMs: 380,
      frontendMs: 550,
      endToEndMs: 930,
    },
  ]]);
  assert.equal(prompt.cancelInProgress, false);
});

test("Qwen prewarm eligibility requires an active non-translation recording", async () => {
  const calls = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      calls.push(command);
      return Promise.resolve(true);
    },
  });
  const recordingSession = { translateMode: false };
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "local",
    currentModel: "qwen3-asr-0.6b-q8_0",
    activeRecordingSession: recordingSession,
  });

  prompt.prewarmQwenWorker(recordingSession);
  assert.deepEqual(calls, []);

  prompt.isRecording = true;
  prompt.prewarmQwenWorker(recordingSession);
  await Promise.resolve();
  assert.deepEqual(calls, ["prewarm-qwen-worker"]);

  recordingSession.translateMode = true;
  prompt.prewarmQwenWorker(recordingSession);
  recordingSession.translateMode = false;
  prompt.currentModel = "nemotron-3.5-asr-streaming-0.6b-q8_0";
  prompt.prewarmQwenWorker(recordingSession);
  assert.deepEqual(calls, ["prewarm-qwen-worker"]);
});

test("Qwen prewarm waits for probation after first paint and skips a cancelled recording", async () => {
  const events = [];
  let paintCallback = null;
  let scheduledPrewarm = null;
  const stream = {};
  class FakeAudioContext {
    createMediaStreamSource() {
      return { connect() {} };
    }

    createAnalyser() {
      return { fftSize: 0 };
    }
  }
  class FakeMediaRecorder {
    static isTypeSupported() {
      return true;
    }

    start() {
      this.state = "recording";
      events.push("recorder-started");
    }
  }
  const clock = [1000, 1010, 1160, 1170];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      events.push(command);
      return Promise.resolve(true);
    },
    performance: { now: () => clock.shift() },
    requestAnimationFrame(callback) {
      paintCallback = callback;
      return 1;
    },
    setTimeout(callback, delay) {
      scheduledPrewarm = { callback, delay };
      return 42;
    },
    window: { AudioContext: FakeAudioContext },
    globals: {
      MediaRecorder: FakeMediaRecorder,
      navigator: { mediaDevices: { getUserMedia: async () => stream } },
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    pageStartedAt: 0,
    currentProvider: "local",
    currentModel: "qwen3-asr-0.6b-q8_0",
    translateMode: false,
    cancelInProgress: false,
    stopRequested: false,
    activeRecordingSession: null,
    mediaStream: null,
    mediaRecorder: null,
    audioChunks: [],
    promptElement: { classList: { add() {} } },
    clearHidePromptTimer() {},
    clearActualHideTimer() {},
    clearInsertFailedUi() {},
    clearTranscriptionPreview() {},
    updateModelBadge() {},
    hasUsableApiKey: async () => true,
    startWaveAnimation() {},
    startRecordingTimer() {},
  });

  await prompt.startRecording({ nativeMs: 0, eventDeliveryMs: 0 });
  assert.deepEqual(events, ["recorder-started"]);

  paintCallback(1200);
  await Promise.resolve();
  assert.deepEqual(events, [
    "recorder-started",
    "report-recording-startup",
  ]);
  assert.equal(scheduledPrewarm.delay, 300);

  prompt.isRecording = false;
  scheduledPrewarm.callback();
  await Promise.resolve();
  assert.deepEqual(events, [
    "recorder-started",
    "report-recording-startup",
  ]);

  prompt.isRecording = true;
  prompt.scheduleQwenPrewarm(prompt.activeRecordingSession, 500);
  await Promise.resolve();
  assert.deepEqual(events, [
    "recorder-started",
    "report-recording-startup",
    "prewarm-qwen-worker",
  ]);
});

test("microphone priming does not trigger an unrequested permission prompt", async () => {
  let microphoneOpens = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      assert.equal(command, "check-microphone-permission");
      return Promise.resolve({ status: "not-determined" });
    },
    globals: {
      navigator: {
        mediaDevices: {
          async getUserMedia() {
            microphoneOpens += 1;
            return { getTracks: () => [] };
          },
        },
      },
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt);

  await prompt.primeMicrophone();

  assert.equal(microphoneOpens, 0);
});

test("microphone priming still warms an already granted device", async () => {
  let microphoneOpens = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke() {
      return Promise.resolve({ status: "granted" });
    },
    globals: {
      navigator: {
        mediaDevices: {
          async getUserMedia() {
            microphoneOpens += 1;
            return { getTracks: () => [{ stop() {} }] };
          },
        },
      },
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt);

  await prompt.primeMicrophone();

  assert.equal(microphoneOpens, 1);
});

test("a failed old transcription cannot repaint or hide a newer recording", async () => {
  const transcription = createDeferred();
  const invokeStarted = createDeferred();
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      assert.equal(command, "transcribe-audio");
      invokeStarted.resolve();
      return transcription.promise;
    },
  });
  const scheduledHides = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 1,
    pendingInsertionOrder: [1, 2],
    statusText: { textContent: "processing first", style: {} },
    scheduleHidePrompt(delayMs) {
      scheduledHides.push(delayMs);
    },
    async flushPendingInsertions() {},
  });

  const processing = prompt.processRecording({
    id: 1,
    chunks: [new Blob([new Uint8Array([1, 2, 3])])],
    mimeType: "audio/webm",
    translateMode: false,
    cancelledShortPress: false,
  });
  await invokeStarted.promise;

  prompt.recordingSessionId = 2;
  prompt.isRecording = true;
  prompt.statusText.textContent = "recording second";
  transcription.reject(new Error("network timeout"));
  await processing;

  assert.equal(prompt.statusText.textContent, "recording second");
  assert.deepEqual(scheduledHides, []);
  assert.deepEqual(prompt.pendingInsertionOrder, [2]);
});

test("transcription IPC carries the recording session id", async () => {
  const calls = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, ...args) {
      if (command === "transcribe-audio") {
        calls.push(args);
        return Promise.resolve("session text");
      }
      return Promise.resolve(null);
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 7,
    pendingInsertionOrder: [7],
    async flushPendingInsertions() {},
  });

  await prompt.processRecording({
    id: 7,
    chunks: [new Blob([new Uint8Array([1, 2, 3])])],
    mimeType: "audio/webm",
    translateMode: false,
    cancelledShortPress: false,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][3], 7);
});

test("Nemotron final is inserted without running the Qwen batch path", async () => {
  const calls = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, ...args) {
      calls.push([command, ...args]);
      if (command === "finish-live-transcription") {
        return Promise.resolve("live final");
      }
      return Promise.resolve(null);
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "local",
    currentModel: "nemotron-3.5-asr-streaming-0.6b-q8_0",
    recordingSessionId: 9,
    pendingInsertionOrder: [9],
    async flushPendingInsertions() {},
  });

  await prompt.processRecording({
    id: 9,
    chunks: [new Blob([new Uint8Array([1, 2, 3])])],
    mimeType: "audio/webm",
    translateMode: false,
    cancelledShortPress: false,
    live: {
      sessionId: 9,
      uploadTail: Promise.resolve(),
      uploadError: null,
    },
  });

  assert.deepEqual(calls, [["finish-live-transcription", 9]]);
  assert.equal(prompt.pendingInsertionsById.get(9), "live final");
});

test("local recording pipelines stay single-flight through transcription", async () => {
  const firstTranscription = createDeferred();
  const firstStarted = createDeferred();
  let transcriptionCalls = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      if (command !== "transcribe-audio") {
        return Promise.resolve(null);
      }
      transcriptionCalls += 1;
      if (transcriptionCalls === 1) {
        firstStarted.resolve();
        return firstTranscription.promise;
      }
      return Promise.resolve("second text");
    },
    window: {
      SayTypeVadGate: {
        async analyze() {
          return {
            speech: true,
            wav: new Uint8Array([1, 2, 3]),
            trimmedMs: 0,
            durationMs: 1000,
          };
        },
      },
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "local",
    recordingSessionId: 2,
    pendingInsertionOrder: [1, 2],
    async flushPendingInsertions() {},
  });

  const first = processOneRecording(prompt, 1);
  await firstStarted.promise;
  const second = processOneRecording(prompt, 2);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(transcriptionCalls, 1);
  firstTranscription.resolve("first text");
  await Promise.all([first, second]);
  assert.equal(transcriptionCalls, 2);
});

test("a queued local transcription can be cancelled before native IPC", async () => {
  const firstTranscription = createDeferred();
  const firstStarted = createDeferred();
  const invoked = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, ...args) {
      invoked.push([command, ...args]);
      if (command === "transcribe-audio" && args[3] === 1) {
        firstStarted.resolve();
        return firstTranscription.promise;
      }
      if (command === "transcribe-audio") {
        return Promise.resolve("unexpected second text");
      }
      return Promise.resolve(true);
    },
    window: {
      SayTypeVadGate: {
        async analyze() {
          return {
            speech: true,
            wav: new Uint8Array([1, 2, 3]),
            trimmedMs: 0,
            durationMs: 1000,
          };
        },
      },
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "local",
    recordingSessionId: 2,
    pendingInsertionOrder: [1, 2],
    cancelInProgress: false,
    stopRequested: false,
    stopRecordingTimer() {},
    clearHidePromptTimer() {},
    clearActualHideTimer() {},
    clearInsertFailedUi() {},
    cleanup() {},
    stopWaveAnimation() {},
    scheduleHidePrompt() {},
    async flushPendingInsertions() {},
  });

  const first = processOneRecording(prompt, 1);
  await firstStarted.promise;
  const second = processOneRecording(prompt, 2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  prompt.cancelRecording();

  assert.equal(prompt.cancelledTranscriptionSessionIds.has(2), true);
  firstTranscription.resolve("first text");
  await Promise.all([first, second]);
  assert.equal(
    invoked.filter(([command]) => command === "transcribe-audio").length,
    1
  );
  assert.equal(
    invoked.some(
      ([command, sessionId]) =>
        command === "cancel-transcription" && sessionId === 2
    ),
    true
  );
});

test("the insertion queue waits for the earliest session result", async () => {
  const VoiceInputPrompt = loadVoiceInputPrompt();
  const inserted = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    pendingInsertionOrder: [1, 2],
    pendingInsertionsById: new Map([[2, "second"]]),
    async typeText(text) {
      inserted.push(text);
      return { ok: true, direct: true };
    },
  });

  await prompt.flushPendingInsertions();

  assert.deepEqual(inserted, []);
  assert.deepEqual(prompt.pendingInsertionOrder, [1, 2]);
  assert.equal(prompt.pendingInsertionsById.get(2), "second");
});

test("completed transcriptions are inserted in recording order", async () => {
  const VoiceInputPrompt = loadVoiceInputPrompt();
  const inserted = [];
  let hideCalls = 0;
  const prompt = createBarePrompt(VoiceInputPrompt, {
    pendingInsertionOrder: [1, 2, 3],
    pendingInsertionsById: new Map([
      [3, "third"],
      [1, "first"],
      [2, "second"],
    ]),
    async typeText(text, options) {
      assert.equal(options.suppressUi, true);
      inserted.push(text);
      return { ok: true, direct: true };
    },
    hidePrompt() {
      hideCalls += 1;
    },
  });

  await prompt.flushPendingInsertions();

  assert.deepEqual(inserted, ["first", "second", "third"]);
  assert.deepEqual(prompt.pendingInsertionOrder, []);
  assert.equal(prompt.pendingInsertionsById.size, 0);
  assert.equal(hideCalls, 1);
});

test("pending transcriptions are not inserted while recording", async () => {
  const VoiceInputPrompt = loadVoiceInputPrompt();
  const inserted = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    isRecording: true,
    pendingInsertionOrder: [1],
    pendingInsertionsById: new Map([[1, "first"]]),
    async typeText(text) {
      inserted.push(text);
      return { ok: true, direct: true };
    },
  });

  await prompt.flushPendingInsertions();

  assert.deepEqual(inserted, []);
  assert.deepEqual(prompt.pendingInsertionOrder, [1]);
  assert.equal(prompt.pendingInsertionsById.get(1), "first");
});

function hungError() {
  return new Error(
    "local ASR stalled mid-decode (no progress for 20s) — treating as hung"
  );
}

function processOneRecording(prompt, id = 1) {
  return prompt.processRecording({
    id,
    chunks: [new Blob([new Uint8Array([1, 2, 3])])],
    mimeType: "audio/webm",
    translateMode: false,
    cancelledShortPress: false,
  });
}

test("a hung transcription is auto-retried once and then succeeds", async () => {
  let calls = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      if (command !== "transcribe-audio") return null;
      calls += 1;
      return calls === 1
        ? Promise.reject(hungError())
        : Promise.resolve("recovered text");
    },
  });
  let flushes = 0;
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 1,
    pendingInsertionOrder: [1],
    async flushPendingInsertions() {
      flushes += 1;
    },
  });

  await processOneRecording(prompt);

  assert.equal(calls, 2, "should invoke twice: original + one retry");
  assert.equal(prompt.pendingInsertionsById.get(1), "recovered text");
  // Head stays queued through the retry (flush is mocked, so nothing drains it).
  assert.deepEqual(prompt.pendingInsertionOrder, [1]);
  assert.ok(flushes >= 1);
});

test("a transcription still hung after one retry gives up and unblocks the queue", async () => {
  let calls = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      if (command !== "transcribe-audio") return null;
      calls += 1;
      return Promise.reject(hungError());
    },
  });
  const removed = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 1,
    pendingInsertionOrder: [1],
    scheduleHidePrompt() {},
    removePendingInsertion(id) {
      removed.push(id);
      VoiceInputPrompt.prototype.removePendingInsertion.call(this, id);
    },
    async flushPendingInsertions() {},
  });

  await processOneRecording(prompt);

  assert.equal(calls, 2, "one retry, then give up — never a third attempt");
  assert.deepEqual(removed, [1], "the hung session is dropped from the queue");
  assert.deepEqual(prompt.pendingInsertionOrder, []);
  assert.equal(prompt.statusText.style.color, "var(--status-warning-strong)");
});

test("a local hang surviving the retry is saved as a pending entry", async () => {
  const commands = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      commands.push(command);
      if (command === "transcribe-audio") return Promise.reject(hungError());
      if (command === "save-pending-transcription") return Promise.resolve("entry-1");
      return null;
    },
    window: { SayTypeVadGate: { analyze: async () => ({ speech: true, wav: new Uint8Array([1, 2, 3]) }) } },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "local",
    recordingSessionId: 1,
    pendingInsertionOrder: [1],
    scheduleHidePrompt() {},
    async flushPendingInsertions() {},
  });

  await processOneRecording(prompt);
  await settlePromises();

  assert.equal(commands.filter((c) => c === "transcribe-audio").length, 2);
  assert.ok(
    commands.includes("save-pending-transcription"),
    "the hung clip must be stashed for later re-transcription"
  );
});

test("a cloud hang is not saved as a pending entry", async () => {
  const commands = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      commands.push(command);
      if (command === "transcribe-audio") return Promise.reject(hungError());
      return null;
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "openai",
    recordingSessionId: 1,
    pendingInsertionOrder: [1],
    scheduleHidePrompt() {},
    async flushPendingInsertions() {},
  });

  await processOneRecording(prompt);

  assert.ok(
    !commands.includes("save-pending-transcription"),
    "cloud audio is not persisted for re-transcription"
  );
});

test("a non-retryable transcription error is not retried", async () => {
  let calls = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      if (command !== "transcribe-audio") return null;
      calls += 1;
      return Promise.reject(new Error("api key not configured"));
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 1,
    pendingInsertionOrder: [1],
    scheduleHidePrompt() {},
    async flushPendingInsertions() {},
  });

  await processOneRecording(prompt);

  assert.equal(calls, 1, "deterministic errors must not be retried");
  assert.deepEqual(prompt.pendingInsertionOrder, []);
});

// ---- chunked local (Qwen) transcription --------------------------------

// A live chunk session as setupChunkedLocal builds it. 16 kHz means
// resampleTo16k is a no-op, so these tests exercise the real WAV encoding
// without needing an OfflineAudioContext.
function makeChunked(overrides = {}) {
  return {
    sessionId: 7,
    sampleRate: 16000,
    node: null,
    mutedOutput: null,
    blocks: [],
    blockSamples: 0,
    state: chunkDecision.createChunkState(),
    nextChunkIndex: 0,
    results: [],
    failedChunks: 0,
    queue: Promise.resolve(),
    livePartial: null,
    aborted: false,
    stopped: false,
    ...overrides,
  };
}

function loadForChunking(invoke) {
  return loadVoiceInputPrompt({
    invoke,
    window: {
      SayTypeChunk: chunkDecision,
      SayTypeVad: { encodeWavPcm16 },
    },
  });
}

test("closeChunk splits mid-block and carries the remainder into the next chunk", () => {
  const VoiceInputPrompt = loadForChunking(async () => null);
  const enqueued = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    enqueueChunkDecode(_chunked, pcm) {
      enqueued.push(Array.from(pcm));
    },
  });

  const chunked = makeChunked();
  const blocks = [
    Float32Array.from([0.1, 0.2, 0.3]),
    Float32Array.from([0.4, 0.5, 0.6]),
    Float32Array.from([0.7, 0.8, 0.9]),
  ];
  for (const block of blocks) {
    chunked.blocks.push(block);
    chunked.blockSamples += block.length;
    chunkDecision.pushFrame(chunked.state, chunkDecision.frameRms(block), block.length);
  }

  prompt.closeChunk(chunked, 4); // cut inside the second block

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].length, 4);
  enqueued[0].forEach((value, index) => {
    assert.ok(Math.abs(value - (index + 1) / 10) < 1e-6);
  });
  assert.equal(chunked.blockSamples, 5, "the tail carries over sample-exactly");
  assert.equal(chunked.state.samples, 5, "the cut state is re-based with the audio");
});

test("chunks decode in order, one at a time, each tagged with its chunk index", async () => {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const VoiceInputPrompt = loadForChunking(async (channel, ...args) => {
    if (channel !== "transcribe-audio") return null;
    calls.push(args);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return `chunk${args[4]}`;
  });

  const prompt = createBarePrompt(VoiceInputPrompt);
  const chunked = makeChunked();
  prompt.enqueueChunkDecode(chunked, new Float32Array(160));
  prompt.enqueueChunkDecode(chunked, new Float32Array(160));
  prompt.enqueueChunkDecode(chunked, new Float32Array(160));
  await chunked.queue;

  assert.deepEqual(chunked.results, ["chunk0", "chunk1", "chunk2"]);
  assert.equal(maxInFlight, 1, "decodes must stay serial — one llama worker");
  assert.equal(calls.length, 3);
  assert.equal(calls[0][1], false, "chunked dictation never runs translate mode");
  assert.equal(calls[0][2], "audio/wav");
  assert.equal(calls[0][3], 7, "the recording session id rides along");
  assert.deepEqual(calls.map((args) => args[4]), [0, 1, 2]);
  assert.ok(calls[0][0].length > 44, "a real WAV, header included, is uploaded");
});

test("one failed chunk stops queued work and refuses to return a gapped final", async () => {
  const VoiceInputPrompt = loadForChunking(async (channel, ...args) => {
    if (channel !== "transcribe-audio") return null;
    if (args[4] === 1) throw new Error("chunk decode blew up");
    return `part${args[4]}`;
  });

  const prompt = createBarePrompt(VoiceInputPrompt);
  const chunked = makeChunked();
  for (let i = 0; i < 3; i++) prompt.enqueueChunkDecode(chunked, new Float32Array(160));
  await chunked.queue;

  assert.deepEqual(chunked.results, ["part0", "", ""]);
  assert.equal(chunked.failedChunks, 1);
  await assert.rejects(() => prompt.finishChunkedLocal({ chunked }), /chunk decode blew up/);
});

test("finishChunkedLocal reports failed chunks but accepts silence", async () => {
  const VoiceInputPrompt = loadForChunking(async () => {
    throw new Error("every chunk failed");
  });
  const prompt = createBarePrompt(VoiceInputPrompt);

  const allFailed = makeChunked();
  prompt.enqueueChunkDecode(allFailed, new Float32Array(160));
  await allFailed.queue;
  await assert.rejects(() => prompt.finishChunkedLocal({ chunked: allFailed }));

  // Silence decodes to empty text with no error — a legitimate "no speech".
  const silent = makeChunked({ results: ["", ""], failedChunks: 0 });
  assert.equal(await prompt.finishChunkedLocal({ chunked: silent }), "");
});

test("releasing the key flushes the buffered remainder as the final chunk", () => {
  const VoiceInputPrompt = loadForChunking(async () => null);
  const enqueued = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    enqueueChunkDecode(_chunked, pcm) {
      enqueued.push(pcm.length);
    },
  });

  const chunked = makeChunked();
  const block = new Float32Array(320);
  chunked.blocks.push(block);
  chunked.blockSamples = block.length;
  chunkDecision.pushFrame(chunked.state, 0.1, block.length);

  prompt.stopChunkedCapture({ chunked });

  assert.deepEqual(enqueued, [320], "the residual audio is not dropped on release");
  assert.equal(chunked.stopped, true);
});

test("cancelling stops dispatching chunks that have not started", async () => {
  const attempted = [];
  const VoiceInputPrompt = loadForChunking(async (channel, ...args) => {
    if (channel === "transcribe-audio") attempted.push(args[4]);
    return "text";
  });

  const prompt = createBarePrompt(VoiceInputPrompt);
  const chunked = makeChunked();
  prompt.cancelChunkedLocal({ chunked });
  prompt.enqueueChunkDecode(chunked, new Float32Array(160));
  await chunked.queue;

  assert.deepEqual(attempted, [], "no audio is sent after a cancel");
  assert.equal(chunked.aborted, true);
  assert.equal(chunked.blockSamples, 0, "buffered audio is released on cancel");
});

test("a chunk's streaming text renders in its own slot, not over finalized chunks", () => {
  const VoiceInputPrompt = loadForChunking(async () => null);
  let preview = null;
  const prompt = createBarePrompt(VoiceInputPrompt, {
    setTranscriptionPreview(text) {
      preview = text;
    },
  });

  const chunked = makeChunked({
    results: ["the first chunk is done.", ""],
    livePartial: { index: 1, text: "the second chunk so far" },
  });
  prompt.renderChunkedPreview(chunked);
  assert.equal(preview, "the first chunk is done. the second chunk so far");

  chunked.aborted = true;
  preview = null;
  prompt.renderChunkedPreview(chunked);
  assert.equal(preview, null, "a cancelled session stops updating the preview");
});

test("the assembled dictation is recorded once, and history never costs the text", async () => {
  const calls = [];
  const VoiceInputPrompt = loadForChunking(async (channel, ...args) => {
    calls.push([channel, ...args]);
    if (channel === "record-assembled-transcription") return "scrubbed text";
    return null;
  });
  const prompt = createBarePrompt(VoiceInputPrompt);

  // The scrubbed text the backend returns is what gets inserted, so the insert
  // and the history row cannot drift apart.
  assert.equal(await prompt.recordAssembledTranscription("joined text"), "scrubbed text");
  assert.deepEqual(calls, [["record-assembled-transcription", "joined text"]]);

  // Empty means silence — nothing to record.
  calls.length = 0;
  assert.equal(await prompt.recordAssembledTranscription(""), "");
  assert.deepEqual(calls, []);

  const failing = loadForChunking(async () => {
    throw new Error("history write failed");
  });
  const failingPrompt = createBarePrompt(failing);
  assert.equal(
    await failingPrompt.recordAssembledTranscription("joined text"),
    "joined text",
    "a failed history write must not lose the dictation"
  );
});

test("cancelling on release does not decode a final chunk that is about to be killed", () => {
  const VoiceInputPrompt = loadForChunking(async () => null);
  const enqueued = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    enqueueChunkDecode(_chunked, pcm) {
      enqueued.push(pcm.length);
    },
  });

  const chunked = makeChunked();
  chunked.blocks.push(new Float32Array(320));
  chunked.blockSamples = 320;
  chunkDecision.pushFrame(chunked.state, 0.1, 320);

  prompt.stopChunkedCapture({ chunked }, { flush: false });

  assert.deepEqual(enqueued, []);
  assert.equal(chunked.stopped, true, "capture still tears down on cancel");
});

// ---- Session lifecycle and recorder-event recovery ---------------------

function createFakeTimers() {
  const pending = new Map();
  let nextId = 0;
  return {
    pending,
    setTimeout(callback, delay) {
      const id = ++nextId;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fire(delay) {
      const timer = [...pending.entries()].find(([, item]) => item.delay === delay);
      assert.ok(timer, `expected a pending ${delay}ms timer`);
      pending.delete(timer[0]);
      timer[1].callback();
    },
  };
}

async function settlePromises() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

async function createLifecycleHarness(options = {}) {
  const timers = createFakeTimers();
  const calls = [];
  const inserted = [];
  const recovered = [];
  const streams = [];
  let hides = 0;
  class FakeAudioContext {
    constructor() { this.sampleRate = 16000; this.state = "running"; }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 0 }; }
    async close() { this.state = "closed"; }
  }
  class FakeMediaRecorder {
    static isTypeSupported() { return true; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; }
  }
  const VoiceInputPrompt = loadVoiceInputPrompt({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    captureLifecycle: options.captureLifecycle,
    invoke(command, ...args) {
      calls.push([command, ...args]);
      if (options.invoke) return options.invoke(command, ...args);
      if (command === "transcribe-audio") return Promise.resolve(`final ${args[4]}`);
      if (command === "record-assembled-transcription") return Promise.resolve(args[0]);
      return Promise.resolve(null);
    },
    window: {
      AudioContext: FakeAudioContext,
      SayTypeChunk: chunkDecision,
      SayTypeVad: { encodeWavPcm16 },
      SayTypeVadGate: options.vadGate || null,
    },
    globals: {
      MediaRecorder: FakeMediaRecorder,
      navigator: { mediaDevices: { async getUserMedia() {
        const stream = { stops: 0, getTracks() { return [{ stop() { stream.stops++; } }]; } };
        streams.push(stream);
        return options.getUserMedia ? options.getUserMedia(stream, streams.length) : stream;
      } } },
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "local",
    currentModel: "qwen3-asr-0.6b-q8_0",
    translateMode: false,
    cancelInProgress: false,
    stopRequested: false,
    promptElement: { classList: { add() {}, remove() {} } },
    clearHidePromptTimer: VoiceInputPrompt.prototype.clearHidePromptTimer,
    clearActualHideTimer() {},
    clearInsertFailedUi: VoiceInputPrompt.prototype.clearInsertFailedUi,
    clearTranscriptionPreview() {},
    updateModelBadge() {},
    hasUsableApiKey: async () => true,
    startWaveAnimation() {},
    stopWaveAnimation() {},
    startRecordingTimer() {},
    stopRecordingTimer() {},
    async setupNemotronLive() {},
    async setupChunkedLocal(session) {
      if (options.batch) return;
      session.chunked = makeChunked({ sessionId: session.id, sampleRate: options.sampleRate || 16000 });
      const pcm = new Float32Array(320);
      session.chunked.blocks.push(pcm);
      session.chunked.blockSamples = pcm.length;
      chunkDecision.pushFrame(session.chunked.state, 0.1, pcm.length);
    },
    async typeText(text) { inserted.push(text); return { ok: true, direct: true }; },
    showInsertFailed(text) { recovered.push(text); this._failedText = text; },
    hidePrompt() { hides++; },
  });
  await prompt.startRecording();
  return { prompt, session: prompt.activeRecordingSession, recorder: prompt.mediaRecorder,
    calls, inserted, recovered, streams, timers, get hides() { return hides; } };
}

test("a chunked session finalizes on release, and late onstop events cannot repeat it", async () => {
  const h = await createLifecycleHarness();
  h.prompt.stopRecording();
  await settlePromises();
  // Chunked audio is captured through the worklet and its final segment is
  // closed by stopRecording, so the dictation is finished before the recorder
  // reports anything at all.
  assert.deepEqual(h.inserted, ["final 0"]);
  assert.equal(h.calls.filter(([command]) => command === "record-assembled-transcription").length, 1);
  h.recorder.onstop();
  h.recorder.onstop();
  await settlePromises();
  assert.deepEqual(h.inserted, ["final 0"]);
  assert.equal(h.calls.filter(([command]) => command === "record-assembled-transcription").length, 1);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  // A real stop clears the diagnostic watch, so it cannot log a false absence.
  assert.equal([...h.timers.pending.values()].some((timer) => timer.delay === 2000), false);
});

test("the chunked stop watch is diagnostic only and changes nothing when it fires", async () => {
  const h = await createLifecycleHarness({ captureLifecycle: true });
  h.prompt.stopRecording();
  await settlePromises();
  assert.deepEqual(h.inserted, ["final 0"]);
  h.timers.fire(2000);
  await settlePromises();
  assert.deepEqual(h.inserted, ["final 0"]);
  assert.equal(h.calls.filter(([command]) => command === "record-assembled-transcription").length, 1);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  // It reports the missing stop event and nothing else.
  const reports = h.calls.filter(([command]) => command === "report-transcription-lifecycle");
  assert.equal(reports.some(([, report]) => report.phase === "recorder-stop" && report.event === "timeout"), true);
  assert.equal(reports.some(([, report]) => report.phase === "recorder-stop" && report.event === "complete"), false);
});

test("a failed chunked dictation still keeps retry audio the recorder delivers after release", async () => {
  const h = await createLifecycleHarness({
    vadGate: { encodeFullWav: async () => new Uint8Array([1, 2, 3]) },
    invoke(command) {
      if (command === "transcribe-audio") return Promise.reject(new Error("decode failed"));
      if (command === "save-pending-transcription") return Promise.resolve("audio-history-id");
      return Promise.resolve(null);
    },
  });
  h.prompt.stopRecording();
  // Finalization now starts before the recorder hands over its Blob, so the
  // container arrives while the chunk decode is still in flight.
  h.recorder.ondataavailable({ data: new Blob(["late container"]) });
  await settlePromises();
  assert.deepEqual(h.inserted, []);
  assert.equal(h.calls.filter(([command]) => command === "save-pending-transcription").length, 1);
});

test("a chunked failure before any recorder data still saves the late container", async () => {
  const h = await createLifecycleHarness({
    vadGate: { encodeFullWav: async () => new Uint8Array([4, 5, 6]) },
    invoke(command) {
      if (command === "transcribe-audio") return Promise.reject(new Error("decode failed"));
      if (command === "save-pending-transcription") return Promise.resolve("audio-history-id");
      return Promise.resolve(null);
    },
  });
  h.prompt.stopRecording();
  await settlePromises();
  assert.equal(h.calls.some(([command]) => command === "save-pending-transcription"), false);
  h.recorder.ondataavailable({ data: new Blob(["container after the failure"]) });
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.calls.filter(([command]) => command === "save-pending-transcription").length, 1);
  assert.deepEqual(h.inserted, []);
});

test("a chunked failure saves the late container even when onstop never arrives", async () => {
  const h = await createLifecycleHarness({
    vadGate: { encodeFullWav: async () => new Uint8Array([7, 8, 9]) },
    invoke(command) {
      if (command === "transcribe-audio") return Promise.reject(new Error("decode failed"));
      if (command === "save-pending-transcription") return Promise.resolve("audio-history-id");
      return Promise.resolve(null);
    },
  });
  h.prompt.stopRecording();
  await settlePromises();
  // The container is delivered by its own dataavailable event; the stop event
  // that follows it is exactly the one WebKit is known to drop.
  h.recorder.ondataavailable({ data: new Blob(["container, no stop event"]) });
  await settlePromises();
  assert.equal(h.calls.filter(([command]) => command === "save-pending-transcription").length, 1);
});

test("a chunked final survives an empty MediaRecorder Blob", async () => {
  const h = await createLifecycleHarness();
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.session.chunks.length, 0);
  assert.deepEqual(h.inserted, ["final 0"]);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
});

test("a missing batch onstop never submits an unfinalized Blob", async () => {
  const h = await createLifecycleHarness({ batch: true });
  h.recorder.ondataavailable({ data: new Blob(["partial container"]) });
  h.prompt.stopRecording();
  h.timers.fire(2000);
  h.timers.fire(15000);
  await settlePromises();
  assert.equal(h.calls.some(([command]) => command === "transcribe-audio"), false);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
});

test("resampling timeout terminates the session and cannot repaint a newer recording", async () => {
  const resample = createDeferred();
  const h = await createLifecycleHarness({ sampleRate: 48000 });
  h.prompt.resampleTo16k = () => resample.promise;
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  h.prompt.stopRequested = false;
  await h.prompt.startRecording();
  h.prompt.statusText.textContent = "new recording";
  h.timers.fire(30000);
  await settlePromises();
  assert.equal(h.prompt.pendingInsertionOrder.includes(h.session.id), false);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  assert.equal(h.streams[1].stops, 0);
  assert.equal(h.prompt.isRecording, true);
  assert.equal(h.prompt.statusText.textContent, "new recording");
  resample.resolve(new Float32Array(320));
  await settlePromises();
  assert.equal(h.calls.some(([command]) => command === "transcribe-audio"), false);
  assert.deepEqual(h.inserted, []);
});

test("a chunk IPC timeout releases the queue and ignores a late final", async () => {
  const transcription = createDeferred();
  const h = await createLifecycleHarness({ invoke(command, ...args) {
    if (command === "transcribe-audio") return transcription.promise;
    if (command === "record-assembled-transcription") return Promise.resolve(args[0]);
    return Promise.resolve(null);
  } });
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  h.timers.fire(450000);
  await settlePromises();
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  transcription.resolve("too late");
  await settlePromises();
  assert.deepEqual(h.inserted, []);
  assert.equal(h.calls.some(([command]) => command === "record-assembled-transcription"), false);
});

test("history timeout preserves a complete final and late history never inserts twice", async () => {
  const history = createDeferred();
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "transcribe-audio") return Promise.resolve("complete final");
    if (command === "record-assembled-transcription") return history.promise;
    return Promise.resolve(null);
  } });
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  h.timers.fire(5000);
  await settlePromises();
  assert.deepEqual(h.inserted, ["complete final"]);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  history.resolve("late scrubbed final");
  await settlePromises();
  assert.deepEqual(h.inserted, ["complete final"]);
});

test("Escape cancels a nonsettling chunk immediately and late results cannot reenter", async () => {
  const transcription = createDeferred();
  const h = await createLifecycleHarness({ invoke(command, ...args) {
    if (command === "transcribe-audio") return transcription.promise;
    if (command === "record-assembled-transcription") return Promise.resolve(args[0]);
    return Promise.resolve(null);
  } });
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  transcription.resolve("cancelled final");
  await settlePromises();
  assert.deepEqual(h.inserted, []);
});

test("Escape cancels a waiting recorder session without cancelling an earlier transcription", async () => {
  const h = await createLifecycleHarness();
  h.prompt.pendingInsertionOrder.unshift(0);
  h.prompt.activeTranscriptionSessionIds.add(0);
  h.prompt.transcriptionInProgressCount = 1;
  h.prompt.stopRecording();
  h.prompt.cancelRecording();
  await settlePromises();
  assert.deepEqual(Array.from(h.prompt.pendingInsertionOrder), [0]);
  assert.equal(h.session.chunked.aborted, true);
  assert.equal(h.calls.some(([command, id]) => command === "cancel-transcription" && id === 0), false);
  h.recorder.onstop();
  await settlePromises();
  assert.deepEqual(h.inserted, []);
});

test("an incomplete chunked dictation keeps completed text for Copy and never inserts a gap", async () => {
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "transcribe-audio") return Promise.reject(new Error("chunk failure"));
    return Promise.resolve(null);
  } });
  h.session.chunked.results = ["preserved first chunk"];
  h.session.chunked.nextChunkIndex = 1;
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  assert.deepEqual(h.inserted, []);
  assert.deepEqual(h.recovered, ["preserved first chunk"]);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
});

test("a completed newer session keeps FIFO order behind an older valid session", async () => {
  const first = createDeferred();
  const h = await createLifecycleHarness({ invoke(command, ...args) {
    if (command === "transcribe-audio") return args[3] === 1 ? first.promise : Promise.resolve("second final");
    if (command === "record-assembled-transcription") return Promise.resolve(args[0]);
    return Promise.resolve(null);
  } });
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  h.prompt.stopRequested = false;
  await h.prompt.startRecording();
  const secondRecorder = h.prompt.mediaRecorder;
  h.prompt.stopRecording();
  secondRecorder.onstop();
  await settlePromises();
  assert.deepEqual(h.inserted, []);
  assert.deepEqual(Array.from(h.prompt.pendingInsertionOrder), [1, 2]);
  first.resolve("first final");
  await settlePromises();
  assert.deepEqual(h.inserted, ["first final", "second final"]);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
});

test("old incomplete text stays hidden after the newer successful recording finishes", async () => {
  const first = createDeferred();
  const h = await createLifecycleHarness({ invoke(command, ...args) {
    if (command === "transcribe-audio") return args[3] === 1 ? first.promise : Promise.resolve("new final");
    if (command === "record-assembled-transcription") return Promise.resolve(args[0]);
    return Promise.resolve(null);
  } });
  h.session.chunked.results = ["old recovered text"];
  h.session.chunked.nextChunkIndex = 1;
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  h.prompt.stopRequested = false;
  await h.prompt.startRecording();
  const secondRecorder = h.prompt.mediaRecorder;
  first.reject(new Error("old chunk failed"));
  await settlePromises();
  assert.deepEqual(h.recovered, [], "an old failure must not cover the new recording");
  assert.equal(h.streams[1].stops, 0);
  h.prompt.stopRecording();
  secondRecorder.onstop();
  await settlePromises();
  assert.deepEqual(h.inserted, ["new final"]);
  assert.deepEqual(h.recovered, []);
  assert.equal(h.hides, 1, "old recovery custody must not block a later successful hide");
  assert.equal(h.prompt.recoverableTranscriptions.get(1).text, "old recovered text");
});

test("cancelling during history ignores a late result and does not revive recovery UI", async () => {
  const history = createDeferred();
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "transcribe-audio") return Promise.resolve("final before cancel");
    if (command === "record-assembled-transcription") return history.promise;
    return Promise.resolve(null);
  } });
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  history.resolve("late history final");
  await settlePromises();
  assert.deepEqual(h.inserted, []);
  assert.deepEqual(h.recovered, []);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
});

test("an old cleanup cannot close the microphone owned by a newer session", async () => {
  const h = await createLifecycleHarness();
  h.prompt.stopRecording();
  h.prompt.stopRequested = false;
  await h.prompt.startRecording();
  h.prompt.cleanup({ recordingSession: h.session });
  assert.equal(h.streams[1].stops, 0);
  assert.equal(h.prompt.audioContext.state, "running");
  assert.equal(h.prompt.mediaStream, h.streams[1]);
});

test("late chunk partials cannot overwrite a final waiting on history", async () => {
  const handlers = new Map();
  const VoiceInputPrompt = loadVoiceInputPrompt({ on(channel, callback) { handlers.set(channel, callback); } });
  const previews = [];
  const chunked = makeChunked({ inFlightChunkIndex: null, results: ["final text"] });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 7,
    transcriptionInProgressCount: 1,
    transcriptionText: {},
    activeRecordingSession: { id: 7, lifecycle: { state: "processing" }, chunked },
    setTranscriptionPreview(text) { previews.push(text); },
  });
  prompt.setupEventListeners();
  handlers.get("local-transcription-partial")(null, { sessionId: 7, chunkIndex: 0, text: "late partial" });
  assert.deepEqual(previews, []);
});

test("lifecycle diagnostics contain phase metadata but never transcription content", async () => {
  const reports = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    captureLifecycle: true,
    invoke(command, ...args) {
      if (command === "report-transcription-lifecycle") reports.push(args[0]);
      if (command === "transcribe-audio") return Promise.resolve("private dictation content");
      return Promise.resolve(null);
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 1,
    pendingInsertionOrder: [1],
    async flushPendingInsertions() {},
  });
  await processOneRecording(prompt);
  assert.ok(reports.some(({ phase, event }) => phase === "chunk-ipc" && event === "complete"));
  for (const report of reports) {
    assert.equal(report.sessionId, 1);
    assert.ok(Number.isInteger(report.elapsedMs) && report.elapsedMs >= 0);
    assert.ok(Object.keys(report).every((key) => ["sessionId", "phase", "event", "elapsedMs", "pendingCount", "chunkIndex"].includes(key)));
  }
  assert.equal(JSON.stringify(reports).includes("private"), false);
});

test("cancelling a queued local slot cannot let its successor overtake the holder", async () => {
  const VoiceInputPrompt = loadVoiceInputPrompt();
  const prompt = createBarePrompt(VoiceInputPrompt);
  const first = { id: 1 };
  const second = { id: 2 };
  const third = { id: 3 };
  const releaseFirst = await prompt.acquireLocalTranscriptionSlot(first);
  const secondSlot = prompt.acquireLocalTranscriptionSlot(second);
  await settlePromises();
  prompt.cancelRecordingSession(second);
  await assert.rejects(secondSlot, /TRANSCRIPTION_CANCELLED/);
  let thirdAcquired = false;
  const thirdSlot = prompt.acquireLocalTranscriptionSlot(third).then((release) => {
    thirdAcquired = true;
    return release;
  });
  await settlePromises();
  assert.equal(thirdAcquired, false);
  releaseFirst();
  const releaseThird = await thirdSlot;
  assert.equal(thirdAcquired, true);
  releaseThird();
});

function createInsertionHarness(options = {}) {
  const timers = createFakeTimers();
  const firstInsertion = createDeferred();
  const attempts = [];
  const uiEvents = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    invoke: async () => null,
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 2,
    pendingInsertionOrder: [1, 2],
    pendingInsertionsById: new Map([[1, "first"], [2, "second"]]),
    async typeText(text) {
      attempts.push(text);
      return text === "first" ? firstInsertion.promise : { ok: true, direct: true };
    },
    updateStatusText() { uiEvents.push("update"); },
    hidePrompt() { uiEvents.push("hide"); },
    showInsertFailed(text) { uiEvents.push(`copy:${text}`); },
    scheduleHidePrompt() { uiEvents.push("schedule-hide"); },
    ...options,
  });
  const firstSession = { id: 1 };
  const secondSession = { id: 2 };
  prompt.ensureRecordingSession(firstSession).state = "ready";
  prompt.ensureRecordingSession(secondSession).state = "ready";
  return { prompt, firstSession, firstInsertion, attempts, uiEvents, timers };
}

test("insertion holds FIFO until the actual native reply without a synthetic timeout", async () => {
  const h = createInsertionHarness();
  const flushing = h.prompt.flushPendingInsertions();
  await settlePromises();
  assert.deepEqual(h.attempts, ["first"]);
  assert.equal([...h.timers.pending.values()].some(({ delay }) => delay === 15000), false);
  assert.equal(h.prompt.isFlushingInsertQueue, true);
  h.firstInsertion.resolve({ ok: true, direct: true });
  await flushing;
  assert.deepEqual(h.attempts, ["first", "second"]);
});

test("cancelling an already dispatched insertion cannot release its FIFO lock", async () => {
  const h = createInsertionHarness();
  const flushing = h.prompt.flushPendingInsertions();
  await settlePromises();
  h.prompt.cancelRecordingSession(h.firstSession);
  await settlePromises();
  assert.deepEqual(h.attempts, ["first"], "the second native side effect must still wait");
  assert.equal(h.prompt.isFlushingInsertQueue, true);
  h.firstInsertion.resolve({ ok: true, direct: true });
  await flushing;
  assert.deepEqual(h.attempts, ["first", "second"]);
  assert.equal(h.uiEvents.some((event) => event.startsWith("copy:")), false);
});

test("a cancelled native insertion reply cannot update or hide a newer recording", async () => {
  const h = createInsertionHarness();
  const flushing = h.prompt.flushPendingInsertions();
  await settlePromises();
  h.prompt.cancelRecordingSession(h.firstSession);
  h.prompt.recordingSessionId = 3;
  h.prompt.isRecording = true;
  h.prompt.statusText.textContent = "new recording";
  h.uiEvents.length = 0;
  h.firstInsertion.resolve({ ok: false, message: "late native result" });
  await flushing;
  assert.deepEqual(h.attempts, ["first"]);
  assert.deepEqual(h.uiEvents, []);
  assert.equal(h.prompt.statusText.textContent, "new recording");
  assert.deepEqual(Array.from(h.prompt.pendingInsertionOrder), [2]);
});

test("Escape cancels the selected recording without discarding hidden older recovery", async () => {
  const h = await createLifecycleHarness();
  h.prompt.preserveCompletedChunks({ id: 0, finalText: "older recoverable text" });
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.isRecording, false);
  assert.equal(h.prompt.cancelInProgress, false, "the recording-cancel gate must be released");
  assert.deepEqual(h.recovered, []);
  h.timers.fire(300);
  assert.equal(h.hides, 1, "hidden recovery is not a pending UI operation");
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.size, 1);
  h.timers.fire(300);
  assert.equal(h.hides, 2);
});

test("an old cancel callback cannot clear a newer startup cancellation gate", async () => {
  const h = await createLifecycleHarness();
  h.prompt.cancelRecording();
  const preflight = createDeferred();
  h.prompt.hasUsableApiKey = () => preflight.promise;
  h.prompt.stopRequested = false;
  const starting = h.prompt.startRecording();
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.starting, true);
  assert.equal(h.prompt.cancelInProgress, true, "the new startup cancellation still owns the gate");
  preflight.resolve(true);
  await starting;
});

test("current failed final remains copyable without resurfacing older recovery", async () => {
  const copied = [];
  const h = await createLifecycleHarness({ invoke(command, ...args) {
    if (command === "transcribe-audio") return Promise.resolve("new complete final");
    if (command === "record-assembled-transcription") return Promise.reject(new Error("history unavailable"));
    if (command === "copy-to-clipboard") copied.push(args[0]);
    return Promise.resolve(null);
  } });
  h.prompt.preserveCompletedChunks({ id: 0, finalText: "older recovered text" });
  const showInsertFailed = Object.getPrototypeOf(h.prompt).showInsertFailed;
  h.prompt.showInsertFailed = function(text) {
    h.recovered.push(text);
    showInsertFailed.call(this, text);
  };
  h.prompt.typeText = async () => ({ ok: false, message: "No editable text field" });
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.size, 2);
  assert.equal(h.prompt.recoverableTranscriptions.get(0).kind, "incomplete");
  assert.equal(h.prompt.recoverableTranscriptions.get(h.session.id).kind, "insert-failed");
  assert.equal(h.prompt._failedText, "new complete final");
  assert.equal(h.prompt.promptText.textContent, "inputPrompt.insertFailedTitle");
  assert.deepEqual(h.recovered, ["new complete final"]);
  await h.prompt.copyFailedText();
  assert.equal(h.prompt.recoverableTranscriptions.size, 2, "Copy is not a persistence ACK");
  assert.deepEqual(copied, ["new complete final"]);
  h.timers.fire(1200);
  assert.equal(h.hides, 1);
});

test("startup cancellation keeps its gate through worklet setup and releases it after stop", async () => {
  const h = await createLifecycleHarness();
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  h.prompt.preserveCompletedChunks({ id: 0, finalText: "old recovery" });
  const setup = createDeferred();
  const originalSetup = h.prompt.setupChunkedLocal;
  h.prompt.setupChunkedLocal = async function(session, source) {
    await setup.promise;
    return originalSetup.call(this, session, source);
  };
  h.prompt.stopRequested = false;
  const starting = h.prompt.startRecording();
  await settlePromises();
  const cancelledSessionId = h.prompt.activeRecordingSession.id;
  assert.equal(cancelledSessionId, 2, "the session exists before AudioWorklet setup completes");
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.starting, true);
  assert.equal(h.prompt.cancelInProgress, true, "setup must still see the pending cancellation");
  setup.resolve();
  await starting;
  await settlePromises();
  assert.equal(h.prompt.cancelInProgress, false, "completed startup cancellation must release its gate");
  assert.equal(h.prompt.isRecording, false);
  assert.equal(h.calls.some(([command, ...args]) => command === "transcribe-audio" && args[3] === cancelledSessionId), false);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  assert.deepEqual(h.recovered, []);
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.size, 1);
});

test("cancelling pending microphone acquisition does not hide older recovery text", async () => {
  const microphone = createDeferred();
  const h = await createLifecycleHarness({ getUserMedia(stream, count) {
    return count === 2 ? microphone.promise.then(() => stream) : stream;
  } });
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  const hidesBeforeStartup = h.hides;
  h.prompt.preserveCompletedChunks({ id: 0, finalText: "old recovery" });
  h.prompt.stopRequested = false;
  const starting = h.prompt.startRecording();
  await settlePromises();
  h.prompt.cancelRecording();
  microphone.resolve();
  await starting;
  await settlePromises();
  assert.equal(h.streams[1].stops, 1, "the late microphone stream is released");
  assert.equal(h.hides, hidesBeforeStartup, "older recovery must not disappear with the cancelled startup");
  assert.deepEqual(h.recovered, []);
  assert.equal(h.prompt.cancelInProgress, false);
});

function useRealRecoveryUi(h) {
  const show = Object.getPrototypeOf(h.prompt).showInsertFailed;
  h.prompt.showInsertFailed = function(text) { h.recovered.push(text); show.call(this, text); };
}

test("hidden old recovery neither resurfaces nor prevents a later successful dictation from hiding", async () => {
  const h = await createLifecycleHarness();
  h.prompt.preserveCompletedChunks({ id: 0, finalText: "old unsaved text" });
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  assert.deepEqual(h.inserted, ["final 0"]);
  assert.equal(h.hides, 1);
  assert.deepEqual(h.recovered, []);
  assert.equal(h.prompt.recoverableTranscriptions.get(0).text, "old unsaved text");
});

test("current recovery auto-hides after fifteen seconds without deleting unsaved content", async () => {
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "transcribe-audio") return Promise.reject(new Error("decode failed"));
    if (command === "save-recovered-transcription") return Promise.reject(new Error("disk unavailable"));
    return Promise.resolve(null);
  } });
  useRealRecoveryUi(h);
  h.session.chunked.results = ["recover me"];
  h.session.chunked.nextChunkIndex = 1;
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  assert.deepEqual(h.recovered, ["recover me"]);
  h.timers.fire(15000);
  assert.equal(h.hides, 1);
  assert.equal(h.prompt.recoverableTranscriptions.get(1).text, "recover me");
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
});

test("recovery timeout retains content until its late durable acknowledgment arrives", async () => {
  const saved = createDeferred();
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "save-recovered-transcription") return saved.promise;
    return Promise.resolve(null);
  } });
  h.prompt.preserveCompletedChunks({ id: 0, finalText: "durable text" });
  await settlePromises();
  const save = h.calls.find(([command]) => command === "save-recovered-transcription");
  assert.ok(save);
  assert.equal(save[1].text, "durable text");
  assert.equal(save[1].kind, "incomplete");
  assert.match(save[1].id, /^recovery-/);
  h.timers.fire(5000);
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.get(0).text, "durable text");
  saved.resolve("existing-history-id");
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.has(0), false);
  assert.deepEqual(h.recovered, []);
});

test("failed recovery persistence retries with its same id on the next recording result", async () => {
  let saves = 0;
  const h = await createLifecycleHarness({ invoke(command, ...args) {
    if (command === "save-recovered-transcription") {
      saves++;
      return saves === 1 ? Promise.reject(new Error("disk unavailable")) : Promise.resolve("history-id");
    }
    if (command === "transcribe-audio") return Promise.resolve("new text");
    if (command === "record-assembled-transcription") return Promise.resolve(args[0]);
    return Promise.resolve(null);
  } });
  h.prompt.preserveCompletedChunks({ id: 0, finalText: "retry me" });
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.size, 1);
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  const ids = h.calls.filter(([command]) => command === "save-recovered-transcription").map(([, request]) => request.id);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(h.prompt.recoverableTranscriptions.size, 0);
  assert.deepEqual(h.inserted, ["new text"]);
  assert.equal(h.hides, 1);
});

test("batch onstop after its two-second warning still transcribes before the hard deadline", async () => {
  const h = await createLifecycleHarness({ batch: true,
    vadGate: { analyze: async () => ({ speech: true, wav: new Uint8Array([1, 2, 3]) }) } });
  h.prompt.stopRecording();
  h.timers.fire(2000);
  await settlePromises();
  assert.deepEqual(Array.from(h.prompt.pendingInsertionOrder), [1]);
  assert.equal(h.calls.some(([command]) => command === "transcribe-audio"), false);
  h.recorder.ondataavailable({ data: new Blob(["complete container"]) });
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.inserted.length, 1);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
});

test("a batch hard timeout recovers a late final once without inserting or touching the new recording", async () => {
  const encoded = createDeferred();
  const h = await createLifecycleHarness({ batch: true,
    vadGate: { encodeFullWav: () => encoded.promise },
    invoke(command) { return Promise.resolve(command === "save-pending-transcription" ? "audio-history-id" : null); } });
  h.prompt.stopRecording();
  h.timers.fire(2000);
  h.timers.fire(15000);
  await settlePromises();
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  h.prompt.stopRequested = false;
  await h.prompt.startRecording();
  h.prompt.statusText.textContent = "new recording";
  h.recorder.ondataavailable({ data: new Blob(["complete late container"]) });
  h.recorder.onstop();
  h.recorder.onstop();
  await settlePromises();
  encoded.resolve(new Uint8Array([1, 2, 3]));
  await settlePromises();
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.calls.filter(([command]) => command === "save-pending-transcription").length, 1);
  assert.equal(h.calls.some(([command]) => command === "transcribe-audio"), false);
  assert.deepEqual(h.inserted, []);
  assert.equal(h.prompt.statusText.textContent, "new recording");
  assert.equal(h.streams[1].stops, 0);
});

test("cancelling a hard-timed-out batch discards late recorder recovery", async () => {
  const h = await createLifecycleHarness({ batch: true,
    vadGate: { encodeFullWav: async () => new Uint8Array([1, 2, 3]) } });
  h.prompt.stopRecording();
  h.timers.fire(2000);
  h.timers.fire(15000);
  await settlePromises();
  h.prompt.cancelRecording();
  h.recorder.ondataavailable({ data: new Blob(["cancelled container"]) });
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.calls.some(([command]) => command === "save-pending-transcription"), false);
  assert.deepEqual(h.inserted, []);
});

test("late batch recovery retains its original Blob when WAV encoding times out", async () => {
  const h = await createLifecycleHarness({ batch: true,
    vadGate: { encodeFullWav: () => new Promise(() => {}) } });
  h.prompt.stopRecording();
  h.timers.fire(2000);
  h.timers.fire(15000);
  await settlePromises();
  h.recorder.ondataavailable({ data: new Blob(["complete late container"]) });
  h.recorder.onstop();
  await settlePromises();
  h.timers.fire(30000);
  await settlePromises();
  assert.ok(h.session.audioRecovery.blob.size > 0);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
});

test("a stale recovery ACK cannot delete replacement text for the same session", async () => {
  const first = createDeferred();
  const second = createDeferred();
  let saves = 0;
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "save-recovered-transcription") return ++saves === 1 ? first.promise : second.promise;
    return Promise.resolve(null);
  } });
  h.prompt.preserveRecoveryText(0, "old value", "incomplete");
  await settlePromises();
  const oldId = h.prompt.recoverableTranscriptions.get(0).id;
  h.prompt.preserveRecoveryText(0, "replacement value", "insert-failed");
  await settlePromises();
  const replacement = h.prompt.recoverableTranscriptions.get(0);
  assert.notEqual(replacement.id, oldId);
  first.resolve("first-history-row");
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.get(0), replacement);
  second.resolve("replacement-history-row");
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.size, 0);
});

test("idle Escape dismisses current recovery without discarding current or older text", async () => {
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "transcribe-audio") return Promise.reject(new Error("decode failed"));
    return Promise.resolve(null);
  } });
  h.prompt.preserveRecoveryText(0, "hidden older text", "incomplete");
  h.session.chunked.results = ["current recovered text"];
  h.session.chunked.nextChunkIndex = 1;
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.prompt.recoveryShownId, 1);
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.get(1).text, "current recovered text");
  assert.equal(h.prompt.recoverableTranscriptions.get(0).text, "hidden older text");
});

test("late batch persistence retries the same request id and keeps source audio until ACK", async () => {
  const firstSave = createDeferred();
  let saves = 0;
  const h = await createLifecycleHarness({ batch: true,
    vadGate: { encodeFullWav: async () => new Uint8Array([1, 2, 3]) },
    invoke(command) {
      if (command === "save-pending-transcription") return ++saves === 1 ? firstSave.promise : Promise.resolve("pending-row");
      return Promise.resolve(null);
    } });
  h.prompt.stopRecording();
  h.timers.fire(2000);
  h.timers.fire(15000);
  await settlePromises();
  h.recorder.ondataavailable({ data: new Blob(["late complete container"]) });
  h.recorder.onstop();
  await settlePromises();
  h.timers.fire(5000);
  await settlePromises();
  assert.ok(h.session.audioRecovery.blob.size > 0);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  h.prompt.retryRecoveryPersistence();
  await settlePromises();
  const requests = h.calls.filter(([command]) => command === "save-pending-transcription");
  assert.equal(requests.length, 2);
  assert.match(requests[0][3], /^pending-/);
  assert.equal(requests[0][3], requests[1][3]);
  assert.equal(h.session.audioRecovery.blob, null);
  firstSave.resolve("pending-row");
  await settlePromises();
  assert.equal(h.prompt.recoverableAudioSessions.size, 0);
});

test("late batch onstop before its final data still saves exactly once", async () => {
  const h = await createLifecycleHarness({ batch: true,
    vadGate: { encodeFullWav: async () => new Uint8Array([1, 2, 3]) },
    invoke(command) { return Promise.resolve(command === "save-pending-transcription" ? "pending-row" : null); } });
  h.prompt.stopRecording();
  h.timers.fire(2000);
  h.timers.fire(15000);
  await settlePromises();
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.calls.some(([command]) => command === "save-pending-transcription"), false);
  h.recorder.ondataavailable({ data: new Blob(["late final container"]) });
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.calls.filter(([command]) => command === "save-pending-transcription").length, 1);
  assert.deepEqual(h.inserted, []);
});

test("cancelling late WAV encoding prevents a subsequent audio persistence request", async () => {
  const encoded = createDeferred();
  const h = await createLifecycleHarness({ batch: true, vadGate: { encodeFullWav: () => encoded.promise } });
  h.prompt.stopRecording();
  h.timers.fire(2000);
  h.timers.fire(15000);
  await settlePromises();
  h.recorder.ondataavailable({ data: new Blob(["late final container"]) });
  h.recorder.onstop();
  await settlePromises();
  h.prompt.cancelRecording();
  encoded.resolve(new Uint8Array([1, 2, 3]));
  await settlePromises();
  assert.equal(h.calls.some(([command]) => command === "save-pending-transcription"), false);
  assert.equal(h.prompt.recoverableAudioSessions.size, 0);
});

test("late cloud and translation audio stays in memory without raw persistence or rerouting", async () => {
  for (const route of [{ provider: "openai", translateMode: false }, { provider: "local", translateMode: true }]) {
    const h = await createLifecycleHarness({ batch: true,
      vadGate: { encodeFullWav: async () => { throw new Error("must not encode cloud recovery"); } } });
    Object.assign(h.session, route);
    h.prompt.stopRecording();
    h.timers.fire(2000);
    h.timers.fire(15000);
    await settlePromises();
    h.recorder.ondataavailable({ data: new Blob(["late private cloud audio"]) });
    h.recorder.onstop();
    await settlePromises();
    h.prompt.retryRecoveryPersistence();
    await settlePromises();
    assert.ok(h.session.audioRecovery.blob.size > 0);
    assert.equal(h.calls.some(([command]) => ["save-pending-transcription", "transcribe-audio"].includes(command)), false);
    assert.deepEqual(h.inserted, []);
  }
});

test("idle Escape keeps unsaved current text until its durable ACK without reviving the card", async () => {
  const saved = createDeferred();
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "transcribe-audio") return Promise.reject(new Error("decode failed"));
    if (command === "save-recovered-transcription") return saved.promise;
    return Promise.resolve(null);
  } });
  useRealRecoveryUi(h);
  h.session.chunked.results = ["completed words to preserve"];
  h.session.chunked.nextChunkIndex = 1;
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  assert.equal(h.prompt.recoveryShownId, 1);
  const recovery = h.prompt.recoverableTranscriptions.get(1);
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.get(1), recovery);
  assert.equal(recovery.discarded, undefined);
  assert.equal(h.prompt.pendingRecoveryUi, null);
  h.timers.fire(300);
  assert.equal(h.hides, 1);
  saved.resolve("durable-history-row");
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.has(1), false);
  assert.equal(h.prompt.pendingRecoveryUi, null);
  assert.equal(h.prompt.statusText.textContent, "");
  assert.deepEqual(h.recovered, ["completed words to preserve"]);
});
