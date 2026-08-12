import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

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
      on() {},
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
      transcriptionInProgressCount: 0,
      recordingSessionId: 0,
      currentProvider: "openai",
      hidePromptTimerId: null,
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
