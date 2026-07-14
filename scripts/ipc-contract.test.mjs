// Guards the three-place IPC contract documented in CLAUDE.md: every renderer
// channel in ipc-bridge.js must map to a #[tauri::command] fn that is also
// registered in lib.rs's generate_handler! list — and vice versa. A missing
// mapping fails silently at runtime (the frontend swallows invoke errors), so
// this cross-check is the only thing that catches a forgotten third place.
//
// Run directly (node scripts/ipc-contract.test.mjs) or via node --test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- extractors -------------------------------------------------------------

function extractObjectBlock(source, name) {
  const match = source.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n  \\};`));
  if (!match) {
    throw new Error(`${name} map not found in ipc-bridge.js — extractor needs updating`);
  }
  return match[1];
}

// tauriCommands: `"channel-name": "command_name",` pairs → Map(channel → command)
function extractBridgeCommands(source) {
  const commands = new Map();
  for (const [, channel, command] of extractObjectBlock(source, "tauriCommands").matchAll(
    /"([^"]+)":\s*"([^"]+)"/g,
  )) {
    commands.set(channel, command);
  }
  return commands;
}

// tauriArgs / tauriRawBody: `"channel-name": <array|object>` → channel keys
function extractBridgeChannelKeys(source, name) {
  return [...extractObjectBlock(source, name).matchAll(/"([^"]+)":\s*[\[{]/g)].map(
    ([, channel]) => channel,
  );
}

// All `#[tauri::command]` fn names in a Rust source (attributes/pub/async may
// sit between the attribute and the fn keyword).
function extractRustCommands(source) {
  return [...source.matchAll(/#\[tauri::command\][\s\S]*?\bfn\s+([A-Za-z0-9_]+)/g)].map(
    ([, name]) => name,
  );
}

// The generate_handler![...] list in lib.rs, module paths stripped.
function extractRegisteredHandlers(source) {
  const match = source.match(/generate_handler!\[([\s\S]*?)\]/);
  if (!match) {
    throw new Error("generate_handler! list not found in lib.rs — extractor needs updating");
  }
  return match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split("::").pop());
}

function missingFrom(needles, haystack) {
  const set = new Set(haystack);
  return [...needles].filter((needle) => !set.has(needle));
}

// --- extractor fixtures -----------------------------------------------------

const FIXTURE_BRIDGE = `
  const tauriCommands = {
    "do-thing": "do_thing",
    "other-thing": "other_thing",
  };

  const tauriArgs = {
    "do-thing": [["x"]],
  };

  const tauriRawBody = {
    "other-thing": {
      body: 0,
    },
  };
`;

const FIXTURE_RUST = `
#[tauri::command]
pub async fn do_thing(x: String) -> Result<(), String> { Ok(()) }

#[tauri::command]
#[allow(unused_variables)]
fn other_thing() {}

fn not_a_command() {}
`;

const FIXTURE_LIB = `
    .invoke_handler(tauri::generate_handler![
      commands::do_thing,
      other_thing,
    ])
`;

test("extractBridgeCommands parses channel → command pairs", () => {
  assert.deepEqual(
    [...extractBridgeCommands(FIXTURE_BRIDGE)],
    [
      ["do-thing", "do_thing"],
      ["other-thing", "other_thing"],
    ],
  );
});

test("extractBridgeChannelKeys parses tauriArgs and tauriRawBody keys", () => {
  assert.deepEqual(extractBridgeChannelKeys(FIXTURE_BRIDGE, "tauriArgs"), ["do-thing"]);
  assert.deepEqual(extractBridgeChannelKeys(FIXTURE_BRIDGE, "tauriRawBody"), ["other-thing"]);
});

test("extractRustCommands finds only #[tauri::command] fns", () => {
  assert.deepEqual(extractRustCommands(FIXTURE_RUST), ["do_thing", "other_thing"]);
});

test("extractRegisteredHandlers strips module paths", () => {
  assert.deepEqual(extractRegisteredHandlers(FIXTURE_LIB), ["do_thing", "other_thing"]);
});

test("missingFrom reports entries absent from the haystack", () => {
  assert.deepEqual(missingFrom(["a", "b"], ["b", "c"]), ["a"]);
  assert.deepEqual(missingFrom(["a"], ["a"]), []);
});

// --- the real contract ------------------------------------------------------

const bridgeSource = readFileSync(path.join(repoRoot, "src/views/ipc-bridge.js"), "utf8");
const libSource = readFileSync(path.join(repoRoot, "src-tauri/src/lib.rs"), "utf8");
const rustDir = path.join(repoRoot, "src-tauri", "src");
const rustSource = readdirSync(rustDir, { recursive: true })
  .filter((file) => String(file).endsWith(".rs"))
  .map((file) => readFileSync(path.join(rustDir, String(file)), "utf8"))
  .join("\n");

const bridgeCommands = extractBridgeCommands(bridgeSource);
const rustCommands = extractRustCommands(rustSource);
const registeredHandlers = extractRegisteredHandlers(libSource);

test("extractors found a plausible number of entries (guards regex rot)", () => {
  assert.ok(bridgeCommands.size >= 10, `only ${bridgeCommands.size} bridge commands parsed`);
  assert.ok(rustCommands.length >= 10, `only ${rustCommands.length} #[tauri::command] fns parsed`);
  assert.ok(registeredHandlers.length >= 10, `only ${registeredHandlers.length} handlers parsed`);
});

test("every bridge command exists as a #[tauri::command] fn", () => {
  assert.deepEqual(missingFrom(bridgeCommands.values(), rustCommands), []);
});

test("every bridge command is registered in generate_handler!", () => {
  assert.deepEqual(missingFrom(bridgeCommands.values(), registeredHandlers), []);
});

test("every #[tauri::command] fn is registered in generate_handler!", () => {
  assert.deepEqual(missingFrom(rustCommands, registeredHandlers), []);
});

test("every registered handler is mapped in ipc-bridge", () => {
  assert.deepEqual(missingFrom(registeredHandlers, bridgeCommands.values()), []);
});

test("tauriArgs and tauriRawBody only reference known channels", () => {
  const channels = [...bridgeCommands.keys()];
  assert.deepEqual(missingFrom(extractBridgeChannelKeys(bridgeSource, "tauriArgs"), channels), []);
  assert.deepEqual(
    missingFrom(extractBridgeChannelKeys(bridgeSource, "tauriRawBody"), channels),
    [],
  );
});
