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
  const context = vm.createContext({
    ArrayBuffer,
    Blob,
    console: quietConsole,
    DataView,
    document,
    navigator: {},
    performance,
    requestAnimationFrame: options.requestAnimationFrame || (() => 1),
    cancelAnimationFrame: options.cancelAnimationFrame || (() => {}),
    setInterval: options.setInterval || setInterval,
    clearInterval: options.clearInterval || clearInterval,
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
    Uint8Array,
    window,
  });

  vm.runInContext(
    `${source}\n;globalThis.__VoiceInputPrompt = VoiceInputPrompt;`,
    context,
    { filename: sourcePath }
  );

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
