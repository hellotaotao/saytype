import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8");

const mainHtml = read("src/views/main.html");
const mainJs = read("src/views/main.js");
const settingsJs = read("src/views/settings.js");
const settingsCss = read("src/views/settings.css");
const i18nJs = read("src/views/i18n.js");
const commandsRs = read("src-tauri/src/commands.rs");
const libRs = read("src-tauri/src/lib.rs");
const trayRs = read("src-tauri/src/tray.rs");
const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));

function sectionSource(id) {
  const start = mainHtml.indexOf(`id="${id}"`);
  assert.notEqual(start, -1, `${id} is missing`);
  const next = mainHtml.indexOf('<section id="settings-panel-', start + id.length);
  return mainHtml.slice(start, next === -1 ? mainHtml.length : next);
}

test("Tauri config has no standalone settings window", () => {
  const labels = tauriConfig.app.windows.map((window) => window.label);
  assert.ok(labels.includes("main"));
  assert.ok(!labels.includes("settings"));
  assert.equal(existsSync(path.join(repoRoot, "src/views/settings.html")), false);
});

test("main sidebar treats Settings as a normal page", () => {
  assert.match(mainHtml, /class="nav-item"[^>]*data-page="settings"/);
  assert.match(mainHtml, /id="settings-page"\s+class="page"/);
  assert.match(mainJs, /showPage\("settings"/);
});

test("Settings uses three horizontal accessible tabs", () => {
  assert.match(mainHtml, /class="settings-tabs"[^>]*role="tablist"/);
  for (const tab of ["voice-input", "transcription", "app"]) {
    assert.match(mainHtml, new RegExp(`data-settings-tab="${tab}"`));
    assert.match(mainHtml, new RegExp(`id="settings-panel-${tab}"`));
  }
  assert.doesNotMatch(mainHtml, /class="sidebar-item"/);
  assert.match(settingsCss, /\.settings-tabs/);
  assert.match(settingsJs, /event\.key === "ArrowRight"/);
  assert.match(settingsJs, /event\.key === "ArrowLeft"/);
});

test("existing settings are redistributed by purpose", () => {
  const voiceInput = sectionSource("settings-panel-voice-input");
  for (const id of [
    "shortcutSelect",
    "languageSelect",
    "permissionStatus",
    "accessibilityStatus",
  ]) {
    assert.match(voiceInput, new RegExp(`id="${id}"`));
  }

  const transcription = sectionSource("settings-panel-transcription");
  for (const id of [
    "providerSelect",
    "apiKeyGroq",
    "apiKeyOpenAI",
    "modelSelect",
    "localModelItem",
  ]) {
    assert.match(transcription, new RegExp(`id="${id}"`));
  }

  const app = sectionSource("settings-panel-app");
  for (const id of [
    "uiLanguageSelect",
    "themeSelect",
    "autoLaunchCheck",
    "startMinimizedCheck",
    "checkUpdatesBtn",
  ]) {
    assert.match(app, new RegExp(`id="${id}"`));
  }
});

test("main page owns the Settings controller and dirty navigation guard", () => {
  assert.match(mainHtml, /<script src="main\.js"><\/script>\s*<script src="settings\.js"><\/script>/);
  assert.match(settingsJs, /window\.SayTypeSettings\s*=/);
  assert.match(settingsJs, /confirmLeave/);
  assert.match(settingsJs, /#settings-page/);
  assert.doesNotMatch(settingsJs, /invoke\("close-settings"\)/);
  assert.match(mainJs, /SayTypeSettings\?\.confirmLeave/);
  assert.match(mainJs, /ipc\.on\("open-settings-page"/);
});

test("backend routes every Settings entry into the main window", () => {
  assert.match(commandsRs, /window\.label\(\) != "main"/);
  assert.match(commandsRs, /get_webview_window\("main"\)/);
  assert.match(commandsRs, /emit_to\("main",\s*"open-settings-page"/);
  assert.doesNotMatch(commandsRs, /get_webview_window\("settings"\)/);
  assert.doesNotMatch(libRs, /SETTINGS_ENTRY_SCRIPT/);
  assert.doesNotMatch(libRs, /label == "main" \|\| label == "settings"/);
  assert.match(trayRs, /commands::open_settings/);
  assert.doesNotMatch(trayRs, /get_webview_window\("settings"\)/);
});

test("new Settings page labels exist in both locales", () => {
  for (const value of [
    'pageTitle: "Settings"',
    'voiceInput: "Voice Input"',
    'transcription: "Transcription"',
    'app: "App"',
    'pageTitle: "设置"',
    'voiceInput: "语音输入"',
    'transcription: "转写"',
    'app: "应用"',
  ]) {
    assert.ok(i18nJs.includes(value), `missing i18n entry: ${value}`);
  }
});
