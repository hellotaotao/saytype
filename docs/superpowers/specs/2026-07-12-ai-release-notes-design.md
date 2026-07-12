# AI-Generated Release Notes in CI — Design

**Date:** 2026-07-12
**Status:** Approved (brainstormed with Tao; see decisions below)

## Problem

Releases published by the tag-push workflow carry a fixed placeholder body
("下载下方的 .dmg 安装。"). Users see no changelog — nothing explains what a
version adds or fixes, or why they should upgrade. The repo's commit messages
(conventional commits with detailed bodies) already contain all the raw
material.

## Decision: generate in CI, anchored on tags

Notes are generated **inside the release workflow**, covering
`<previous v* tag>..<current tag>`. Anchoring on tags (not on version bumps)
is load-bearing: versions can be bumped locally without ever being released,
so any locally-generated note risks covering a span that never shipped and
silently dropping the gap (the "1.3.4 → 1.3.6 with 1.3.5 never released"
paradox). In CI the trigger *is* the release, and the previous tag *is* the
previous real release — the invariant holds by construction.

Rejected alternatives:
- **Local generation via Claude Code skill** — zero new secrets/cost, but the
  tag-anchoring discipline lives in a human; CI enforces it structurally.
- **git-cliff / conventional-changelog** — free and deterministic, but only
  groups English commit subjects; cannot synthesize a user-facing narrative
  or consult diffs.

## Output format (user decision)

English body first, then a Chinese translation below it, then the bilingual
install hint. Tone: an honest record for users — what was added, fixed, or
improved, and why it matters. Internal-only commits (`chore(release)`, `ci`,
`docs`, `style`, pure refactors, merge commits) are omitted from the
narrative.

```
## What's new
- …

## Fixes
- …

---

## 中文

(faithful translation of the above)

---
Download the .dmg below to install. / 下载下方的 .dmg 安装。
```

Sections are flexible (the model may use "Improvements" etc. as content
dictates); the English→中文→install-hint skeleton is fixed.

## Components

### 1. `scripts/generate-release-notes.mjs` (new)

Node ≥20, zero dependencies (global `fetch`), matching the existing
`scripts/*.js` style.

- **Interface:** `node scripts/generate-release-notes.mjs <tag> [--dry-run]`
  - `ANTHROPIC_API_KEY` from env. Notes printed to **stdout**; all logging to
    stderr. Non-zero exit on any failure (caller decides how soft to fail).
  - `--dry-run`: print the assembled prompt/material instead of calling the
    API (free prompt debugging).
- **Range resolution:** previous tag = `git describe --tags --abbrev=0 <tag>^`
  (any tag format, so `v1.3.0`'s predecessor resolves to `1.0.67`). If no
  predecessor exists, fall back to the last 30 commits and say so in stderr.
- **Material collection**, capped to keep the request bounded:
  - full commit messages (subject + body) for the range — the primary source;
  - per-commit `--stat` summaries;
  - per-commit patches capped at ~400 lines each, excluding lockfiles
    (`Cargo.lock`, `package-lock.json`) and `dist/`;
  - total material capped at ~60k chars (drop patches first, then stats —
    never drop commit messages).
  - `chore(release)` bump commits and pure merge commits are pre-stripped.
- **API call:** `claude-sonnet-5`, `max_tokens` ~2500, single non-streaming
  `/v1/messages` request, 120s timeout. Prompt instructs: user-facing record,
  filter internal noise, English then Chinese translation, fixed skeleton
  above, no invented features — only what the commits support.

### 2. `release.yml` changes

- `actions/checkout@v4` gains `fetch-depth: 0` — the current shallow clone
  has **no historical tags**, so range resolution is impossible without this.
- New step **after** the tauri-action step (draft already exists):

  ```yaml
  - name: Generate release notes
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
      else
        echo "::warning::Release-notes generation failed — release keeps the default body."
      fi
  ```

  Same graceful-degradation philosophy as the Apple-signing step: the notes
  step can **never** break or block a release. `gh release edit <tag>`
  resolves draft releases by their intended tag name (verified 2026-07-11).
  Existing `permissions: contents: write` suffices.

### 3. Secret (user-provisioned)

`ANTHROPIC_API_KEY` — a dedicated key created in the Anthropic Console with
a monthly spend cap (a few dollars is ample; each release costs cents). Set
by the user via `gh secret set ANTHROPIC_API_KEY` — credentials never pass
through the assistant, same discipline as `APPLE_PASSWORD`.

## Error handling summary

| Failure | Behavior |
|---|---|
| Secret absent | Step warns and exits 0; default body kept |
| API error / timeout / bad response | Script exits non-zero; step warns; default body kept |
| No predecessor tag | Last-30-commits fallback, noted on stderr |
| Oversized range | Caps drop patches → stats; commit messages always survive |

## Acceptance

1. `--dry-run` locally on `v1.3.4`: material assembly is correct and capped.
2. Real local run on `v1.3.4` (`v1.3.3..v1.3.4`): output quality reviewed by
   Tao; optionally backfill the published v1.3.4 body via
   `gh release edit v1.3.4 --notes-file` (published content — ask first).
3. Next real release (`v1.3.5`+) verifies the CI path end-to-end: draft
   carries generated bilingual notes; a run without the secret still passes.

## Non-goals

- No translation of the app UI or transcription behavior (unrelated).
- No retroactive notes for 2025-era releases unless asked.
- No streaming, retries beyond one attempt, or prompt-tuning UI — YAGNI.
