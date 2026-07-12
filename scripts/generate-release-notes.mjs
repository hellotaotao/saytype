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
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"], // capture git's stderr (e.g. describe's "fatal:") instead of leaking it
  });

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
