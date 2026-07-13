import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGitLog,
  isNoiseCommit,
  capPatch,
  assembleMaterial,
  buildPrompt,
  extractText,
} from "./release-notes-lib.mjs";

// ---- parseGitLog ----
test("parseGitLog splits records and fields", () => {
  const raw = "\u001eabc123\u001ffeat: one\u001fbody line 1\nbody line 2\n\u001edef456\u001ffix: two\u001f";
  assert.deepEqual(parseGitLog(raw), [
    { sha: "abc123", subject: "feat: one", body: "body line 1\nbody line 2" },
    { sha: "def456", subject: "fix: two", body: "" },
  ]);
});

test("parseGitLog returns [] on empty input", () => {
  assert.deepEqual(parseGitLog(""), []);
});

// ---- isNoiseCommit ----
test("isNoiseCommit strips release bumps and merges", () => {
  assert.equal(isNoiseCommit("chore(release): bump version to 1.3.4"), true);
  assert.equal(isNoiseCommit("Merge pull request #17 from x/y"), true);
  assert.equal(isNoiseCommit("Merge branch 'main' into feature"), true);
  assert.equal(isNoiseCommit("feat(settings): mark recommended models"), false);
  assert.equal(isNoiseCommit("chore: tidy scripts"), false);
});

// ---- capPatch ----
test("capPatch leaves short patches alone", () => {
  assert.equal(capPatch("a\nb\nc", 400), "a\nb\nc");
});

test("capPatch truncates long patches with a marker", () => {
  const patch = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n");
  const capped = capPatch(patch, 400);
  const lines = capped.split("\n");
  assert.equal(lines.length, 401); // 400 kept + marker
  assert.match(lines[400], /patch truncated: 100 more lines/);
});

// ---- assembleMaterial ----
const mkCommit = (i, patchChars = 0, statChars = 0) => ({
  sha: `sha${i}00000000`,
  subject: `feat: change ${i}`,
  body: `why ${i}`,
  stat: statChars ? "s".repeat(statChars) : "",
  patch: patchChars ? "p".repeat(patchChars) : "",
});

test("assembleMaterial includes patches when everything fits", () => {
  const out = assembleMaterial([mkCommit(1, 100, 50)], 60000);
  assert.match(out, /feat: change 1/);
  assert.match(out, /\[stat\]/);
  assert.match(out, /\[patch\]/);
});

test("assembleMaterial drops patches first when over budget", () => {
  const commits = [mkCommit(1, 5000, 50), mkCommit(2, 5000, 50)];
  const out = assembleMaterial(commits, 2000);
  assert.doesNotMatch(out, /\[patch\]/);
  assert.match(out, /\[stat\]/);
  assert.match(out, /feat: change 2/);
});

test("assembleMaterial drops stats too when still over budget", () => {
  const commits = [mkCommit(1, 5000, 3000), mkCommit(2, 5000, 3000)];
  const out = assembleMaterial(commits, 500);
  assert.doesNotMatch(out, /\[patch\]/);
  assert.doesNotMatch(out, /\[stat\]/);
  assert.match(out, /feat: change 1/);
});

// ---- buildPrompt ----
test("buildPrompt embeds tags and material, fixes the skeleton", () => {
  const { system, user } = buildPrompt({ tag: "v1.3.4", prevTag: "v1.3.3", material: "MATERIAL" });
  assert.match(user, /v1\.3\.4/);
  assert.match(user, /v1\.3\.3/);
  assert.match(user, /MATERIAL/);
  assert.match(system, /## 中文/);
  assert.match(system, /## Download \/ 下载/);
  assert.match(system, /auto-updater/);
});

// ---- extractText ----
test("extractText joins text blocks and trims", () => {
  const res = {
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text: "## What's new\n- thing\n" },
    ],
  };
  assert.equal(extractText(res), "## What's new\n- thing");
});

test("extractText throws on refusal", () => {
  assert.throws(() => extractText({ stop_reason: "refusal", content: [] }), /refus/i);
});

test("extractText throws on max_tokens truncation", () => {
  assert.throws(
    () => extractText({ stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }] }),
    /max_tokens/,
  );
});

test("extractText throws when no text content", () => {
  assert.throws(() => extractText({ stop_reason: "end_turn", content: [] }), /no text/i);
});
