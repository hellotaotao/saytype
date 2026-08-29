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
      invoke: options.invoke || (async () => null),
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
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "local",
    recordingSessionId: 1,
    pendingInsertionOrder: [1],
    scheduleHidePrompt() {},
    async flushPendingInsertions() {},
  });

  await processOneRecording(prompt);

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

test("one failed chunk leaves a gap instead of losing the dictation", async () => {
  const VoiceInputPrompt = loadForChunking(async (channel, ...args) => {
    if (channel !== "transcribe-audio") return null;
    if (args[4] === 1) throw new Error("chunk decode blew up");
    return `part${args[4]}`;
  });

  const prompt = createBarePrompt(VoiceInputPrompt);
  const chunked = makeChunked();
  for (let i = 0; i < 3; i++) prompt.enqueueChunkDecode(chunked, new Float32Array(160));
  await chunked.queue;

  assert.deepEqual(chunked.results, ["part0", "", "part2"]);
  assert.equal(chunked.failedChunks, 1);
  assert.equal(await prompt.finishChunkedLocal({ chunked }), "part0 part2");
});

test("finishChunkedLocal fails only when nothing survived, not on silence", async () => {
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
