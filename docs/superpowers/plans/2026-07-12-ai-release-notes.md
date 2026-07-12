# AI Release Notes in CI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every `v*` tag push, the release workflow generates bilingual (EN + 中文) user-facing release notes from the commits since the previous tag and writes them into the draft GitHub release.

**Architecture:** A zero-dependency Node script split into a pure-function library (`scripts/release-notes-lib.mjs`, unit-tested with `node:test`) and a thin CLI (`scripts/generate-release-notes.mjs`) that shells out to `git`, calls the Anthropic Messages API via global `fetch`, and prints notes to stdout. The workflow runs it after the tauri-action step and applies the result with `gh release edit`; every failure degrades to a warning so the release itself can never break.

**Tech Stack:** Node ≥20 (global fetch, `node:test`), bash workflow step, Anthropic Messages API (`claude-sonnet-5`, non-streaming, single attempt).

**Spec:** `docs/superpowers/specs/2026-07-12-ai-release-notes-design.md`

## Global Constraints

- Zero npm dependencies — only `node:` builtins and global `fetch`.
- Notes format skeleton is fixed: English sections → `## 中文` translation → final line exactly `Download the .dmg below to install. / 下载下方的 .dmg 安装。`
- Model: `claude-sonnet-5`. Do NOT send `temperature`/`top_p`/`top_k` (400 on this model). Do NOT set `thinking` (adaptive is the default). `max_tokens: 8000` (adaptive thinking spends from the same budget).
- API: `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`. 120s timeout via `AbortSignal.timeout`. One attempt, no retries.
- All logging to **stderr**; the notes text is the only thing on **stdout**.
- The workflow step must exit 0 in every failure mode (warning only).
- Caps: per-commit patch ≤ 400 lines; total material ≤ 60,000 chars; drop patches first, then stats; never drop commit messages. Exclude `Cargo.lock`, `package-lock.json`, `dist/` from patches.
- Pre-strip `chore(release):` bumps and merge commits.

---

### Task 1: Pure-function library + tests

**Files:**
- Create: `scripts/release-notes-lib.mjs`
- Create: `scripts/release-notes-lib.test.mjs`
- Modify: `.github/workflows/ci.yml` (the step that runs `node src/views/vad-decision.test.mjs`, around line 83)

**Interfaces:**
- Produces (consumed by Task 2's CLI):
  - `parseGitLog(raw: string) → [{sha, subject, body}]` — parses `git log --format=%x1e%H%x1f%s%x1f%b` output
  - `isNoiseCommit(subject: string) → boolean`
  - `capPatch(patch: string, maxLines = 400) → string`
  - `assembleMaterial(commits, maxTotalChars = 60000) → string` — commits are `{sha, subject, body, stat?, patch?}`
  - `buildPrompt({tag, prevTag, material}) → {system, user}`
  - `extractText(apiResponse) → string` — throws on refusal / truncation / empty

- [ ] **Step 1: Write the failing tests**

`scripts/release-notes-lib.test.mjs`:

```js
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
  assert.match(system, /Download the \.dmg below to install\. \/ 下载下方的 \.dmg 安装。/);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/release-notes-lib.test.mjs`
Expected: FAIL — `Cannot find module .../release-notes-lib.mjs`

- [ ] **Step 3: Write the library**

`scripts/release-notes-lib.mjs`:

```js
// Pure functions for CI release-notes generation. No I/O here — the CLI
// (generate-release-notes.mjs) does git + network; this file stays unit-testable.

// Parses `git log --format=%x1e%H%x1f%s%x1f%b` output.
export function parseGitLog(raw) {
  return raw
    .split("\u001e")
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, subject = "", body = ""] = rec.split("\u001f");
      return { sha: sha.trim(), subject: subject.trim(), body: body.trim() };
    });
}

export function isNoiseCommit(subject) {
  return /^chore\(release\):/.test(subject) || /^Merge (branch|pull request)/.test(subject);
}

export function capPatch(patch, maxLines = 400) {
  const lines = patch.split("\n");
  if (lines.length <= maxLines) return patch;
  return (
    lines.slice(0, maxLines).join("\n") +
    `\n[patch truncated: ${lines.length - maxLines} more lines]`
  );
}

// Tiered budget: try messages+stats+patches, then messages+stats, then
// messages only. Commit messages always survive (hard-truncated only as a
// last resort, which real history never hits).
export function assembleMaterial(commits, maxTotalChars = 60000) {
  const render = ({ stats, patches }) =>
    commits
      .map((c) => {
        let block = `### ${c.sha.slice(0, 7)} ${c.subject}\n${c.body}`.trimEnd();
        if (stats && c.stat?.trim()) block += `\n\n[stat]\n${c.stat.trim()}`;
        if (patches && c.patch?.trim()) block += `\n\n[patch]\n${c.patch.trim()}`;
        return block;
      })
      .join("\n\n");

  for (const tier of [
    { stats: true, patches: true },
    { stats: true, patches: false },
    { stats: false, patches: false },
  ]) {
    const out = render(tier);
    if (out.length <= maxTotalChars) return out;
  }
  return render({ stats: false, patches: false }).slice(0, maxTotalChars) + "\n[truncated]";
}

export function buildPrompt({ tag, prevTag, material }) {
  const system = `You write GitHub release notes for SayType, a hold-a-hotkey voice-dictation desktop app (macOS today; it records speech, transcribes it via a cloud Whisper API, and types the text into the focused app).

You are given every commit between the previous release tag and the current one: full commit messages (the primary source — their bodies explain intent), plus file-change stats and truncated diffs where they fit.

Write the release notes as an honest, user-facing record of what changed:

- Cover only changes a user of the app can perceive: new features, fixes, behavior or UX changes, performance. Describe what changed and why it matters to the user, not the implementation.
- Omit internal-only commits entirely: CI, docs, tests, refactors, code style, version bumps. If a commit mixes both, keep only the user-visible part.
- Never invent or embellish — every claim must be supported by the commits. If genuinely nothing user-visible changed, say so in one line.
- Structure: Markdown sections in English first — use "## What's new", "## Improvements", "## Fixes" as content dictates, omitting empty sections; bullet points, concise. Then a "## 中文" section containing a faithful Chinese translation of the same content.
- End with exactly this line:
Download the .dmg below to install. / 下载下方的 .dmg 安装。

Output the raw Markdown only — no code fences around the whole document, no preamble, no commentary.`;

  const user = `Current release tag: ${tag}
Previous release tag: ${prevTag}

Commits in this release (newest first):

${material}`;

  return { system, user };
}

// Validates a Messages API response and returns the notes text.
export function extractText(res) {
  if (res.stop_reason === "refusal") {
    throw new Error(`model refused the request (stop_details: ${JSON.stringify(res.stop_details ?? null)})`);
  }
  if (res.stop_reason === "max_tokens") {
    throw new Error("output truncated at max_tokens — raise the limit");
  }
  const text = (res.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text.trim()) throw new Error("no text content in API response");
  return text.trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/release-notes-lib.test.mjs`
Expected: all tests pass, exit 0

- [ ] **Step 5: Register the test in CI**

Read `.github/workflows/ci.yml` around line 83 (`run: node src/views/vad-decision.test.mjs`). Add the new test to the same step so every platform leg runs it, e.g.:

```yaml
        run: |
          node src/views/vad-decision.test.mjs
          node scripts/release-notes-lib.test.mjs
```

(Keep the step's existing name/indentation; if the run is a single-line string, convert to the block form above.)

Validate YAML: `ruby -ryaml -e 'YAML.load_file(".github/workflows/ci.yml")' && echo OK`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add scripts/release-notes-lib.mjs scripts/release-notes-lib.test.mjs .github/workflows/ci.yml
git commit -m "feat(release-notes): pure-function lib for commit material + prompt + response handling

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: CLI script

**Files:**
- Create: `scripts/generate-release-notes.mjs`

**Interfaces:**
- Consumes: all six functions from `scripts/release-notes-lib.mjs` (signatures in Task 1).
- Produces: `node scripts/generate-release-notes.mjs <tag> [--dry-run]` — notes on stdout, logs on stderr, exit 0 on success / non-zero on any failure. Env: `ANTHROPIC_API_KEY` (required unless `--dry-run`). This exact contract is what Task 3's workflow step calls.

- [ ] **Step 1: Write the CLI**

`scripts/generate-release-notes.mjs`:

```js
#!/usr/bin/env node
// Generates bilingual release notes for <tag> from the commits since the
// previous tag, via the Anthropic API. Notes go to stdout; logs to stderr.
//
//   node scripts/generate-release-notes.mjs v1.3.4            # calls the API
//   node scripts/generate-release-notes.mjs v1.3.4 --dry-run  # prints the prompt, free
//
// Env: ANTHROPIC_API_KEY (required unless --dry-run).
import { execFileSync } from "node:child_process";
import {
  parseGitLog,
  isNoiseCommit,
  capPatch,
  assembleMaterial,
  buildPrompt,
  extractText,
} from "./release-notes-lib.mjs";

const log = (msg) => process.stderr.write(msg + "\n");
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tag = args.find((a) => !a.startsWith("--"));
if (!tag) {
  log("usage: generate-release-notes.mjs <tag> [--dry-run]");
  process.exit(2);
}

try {
  let prevTag = null;
  try {
    prevTag = git("describe", "--tags", "--abbrev=0", `${tag}^`).trim();
  } catch {
    log(`no predecessor tag for ${tag} — falling back to the last 30 commits`);
  }
  log(`range: ${prevTag ?? "(last 30 commits)"} .. ${tag}`);

  const format = "--format=%x1e%H%x1f%s%x1f%b";
  const raw = prevTag
    ? git("log", format, `${prevTag}..${tag}`)
    : git("log", "-n", "30", format, tag);
  const commits = parseGitLog(raw).filter((c) => !isNoiseCommit(c.subject));
  if (commits.length === 0) throw new Error("no commits in range after filtering");
  log(`${commits.length} commits after noise filtering`);

  for (const c of commits) {
    c.stat = git("show", "--stat", "--format=", c.sha);
    c.patch = capPatch(
      git("show", "--format=", "--patch", "--no-color", c.sha, "--", ".",
        ":(exclude)Cargo.lock", ":(exclude)package-lock.json", ":(exclude)dist"),
    );
  }

  const material = assembleMaterial(commits);
  const prompt = buildPrompt({
    tag,
    prevTag: prevTag ?? "(none — covering the last 30 commits)",
    material,
  });

  if (dryRun) {
    process.stdout.write(`--- SYSTEM ---\n${prompt.system}\n\n--- USER ---\n${prompt.user}\n`);
    process.exit(0);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  log("calling Anthropic API (claude-sonnet-5)…");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 8000, // adaptive thinking (on by default) spends from this too
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API HTTP ${res.status}: ${(await res.text()).slice(0, 2000)}`);
  }
  const body = await res.json();
  log(`usage: ${JSON.stringify(body.usage ?? {})}`);
  process.stdout.write(extractText(body) + "\n");
} catch (err) {
  log(`release-notes generation failed: ${err.message}`);
  process.exit(1);
}
```

- [ ] **Step 2: Dry-run against real history**

Run: `node scripts/generate-release-notes.mjs v1.3.4 --dry-run | head -60` and `node scripts/generate-release-notes.mjs v1.3.4 --dry-run | wc -c`
Expected: stderr shows `range: v1.3.3 .. v1.3.4` and `3 commits after noise filtering` (bump commit stripped from the 4); stdout contains the system prompt and the three commit messages with `[stat]`/`[patch]` blocks; total size well under ~70KB.

- [ ] **Step 3: Edge-case dry-run (fallback path)**

Run: `node scripts/generate-release-notes.mjs 1.0.61 --dry-run 2>&1 >/dev/null`
Expected: stderr shows the "no predecessor tag" fallback message (1.0.61 is the oldest tag) and a commit count — no crash.

- [ ] **Step 4: Commit**

```bash
git add scripts/generate-release-notes.mjs
git commit -m "feat(release-notes): CLI — git material collection + Anthropic API call

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire into the release workflow

**Files:**
- Modify: `.github/workflows/release.yml` (checkout step ~line 17; append a step after the tauri-action step ending ~line 88)
- Modify: `CLAUDE.md` (release section — document the notes step + secret)

**Interfaces:**
- Consumes: the Task 2 CLI contract (`node scripts/generate-release-notes.mjs "$TAG"` → notes on stdout, non-zero exit on failure).

- [ ] **Step 1: Add full history to checkout**

In `.github/workflows/release.yml`, change:

```yaml
      - name: Checkout
        uses: actions/checkout@v4
```

to:

```yaml
      - name: Checkout
        uses: actions/checkout@v4
        with:
          # Full history + tags: release-notes generation diffs against the previous tag
          fetch-depth: 0
```

- [ ] **Step 2: Append the notes step after the tauri-action step**

Add at the end of the job (after the `Build, sign, notarize & publish release` step):

```yaml
      - name: Generate release notes
        # Fills the draft release body with AI-generated bilingual notes covering
        # <previous v* tag>..<this tag>. Same philosophy as Apple signing above:
        # missing secret or any failure -> warning, the release itself never breaks.
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          if [ -z "$ANTHROPIC_API_KEY" ]; then
            echo "::warning::No ANTHROPIC_API_KEY secret — release keeps the default body."
            exit 0
          fi
          if node scripts/generate-release-notes.mjs "${GITHUB_REF_NAME}" > notes.md; then
            gh release edit "${GITHUB_REF_NAME}" --notes-file notes.md
            echo "Release notes updated for ${GITHUB_REF_NAME}."
          else
            echo "::warning::Release-notes generation failed — release keeps the default body."
          fi
```

- [ ] **Step 3: Validate the YAML**

Run: `ruby -ryaml -e 'YAML.load_file(".github/workflows/release.yml")' && echo OK`
Expected: `OK`

- [ ] **Step 4: Document in CLAUDE.md**

In the "Release signing & notarization (macOS)" section of `CLAUDE.md`, after the paragraph about signing being optional, add:

```markdown
> **Release notes are AI-generated in CI** (also optional). After the build, the
> workflow runs `scripts/generate-release-notes.mjs` — commits from the previous
> `v*` tag to the current one → Claude API (`claude-sonnet-5`) → bilingual
> (EN + 中文) user-facing notes written into the draft release via `gh release
> edit`. Requires the `ANTHROPIC_API_KEY` secret; if it's absent or the call
> fails, the step warns and the release keeps the default body — never blocks.
> Debug locally with `node scripts/generate-release-notes.mjs <tag> --dry-run`
> (prints the prompt, no API call). Design:
> `docs/superpowers/specs/2026-07-12-ai-release-notes-design.md`.
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml CLAUDE.md
git commit -m "feat(release-notes): generate bilingual notes in the release workflow

fetch-depth: 0 on checkout (shallow clone had no historical tags), plus a
post-build step that fills the draft release body via gh release edit.
Degrades to a warning when ANTHROPIC_API_KEY is absent or the call fails.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Acceptance

**Files:** none (verification only)

- [ ] **Step 1: Full local test suite**

Run: `node scripts/release-notes-lib.test.mjs && node src/views/vad-decision.test.mjs`
Expected: both pass.

- [ ] **Step 2: Real API run on v1.3.4 (user-executed — needs their key)**

Ask the user to run, in their own terminal, after creating the spend-capped key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # the key they created
node scripts/generate-release-notes.mjs v1.3.4 | tee /tmp/notes-v1.3.4.md
```

Expected: bilingual notes covering the 3 real commits (recommended-model tags in settings, docs/ci omitted or folded), ending with the fixed install line. User reviews quality; iterate on the system prompt in `release-notes-lib.mjs` if needed (re-run tests after any prompt edit — the skeleton assertions pin the fixed parts).

- [ ] **Step 3: Secret + push**

User runs `gh secret set ANTHROPIC_API_KEY` (paste the same key). Then push main: `git push origin main`.

- [ ] **Step 4: End-to-end on the next release**

The next real release (v1.3.5+, cut per CLAUDE.md: bump → commit → tag → push) verifies the CI path: draft release carries generated bilingual notes. If the user wants, optionally backfill the published v1.3.4 body with the Step 2 output via `gh release edit v1.3.4 --notes-file /tmp/notes-v1.3.4.md` — published content, ask first.
