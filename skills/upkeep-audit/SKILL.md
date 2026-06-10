---
name: upkeep-audit
description: Run the Upkeep repo audit locally against any repository path. Use when asked to audit a repo, check docs/spec/asset drift, or run upkeep without GitHub Actions.
---

# Upkeep Local Audit

Run the full Upkeep audit pipeline (discovery → parallel reviewers → synthesis → HTML report) against a local repository. Output-only: the target repo is never modified.

## Steps

1. **Ensure the Upkeep checkout** at `~/.cache/upkeep`:
   - Missing: `git clone --depth 1 https://github.com/wei18/upkeep ~/.cache/upkeep`
   - Present: `git -C ~/.cache/upkeep pull --ff-only`
   - Then `(cd ~/.cache/upkeep && npm ci)` after a fresh clone or whenever the pull changed `package-lock.json` (when unsure, run it — it is idempotent).
2. **Run the audit** (takes several minutes; reviewers run as parallel `claude -p` subprocesses — run it in the background and report progress):
   ```bash
   ~/.cache/upkeep/scripts/local-audit.sh <target-path> [--model M] [--rubric-lang L] [--max-turns N] [--out FILE]
   ```
   Pass flags only when the user asked for them. Defaults match the CI inputs (`claude-opus-4-8`, `en`, `30`); the report defaults to `./upkeep-report.html` in the current working directory.
3. **Summarize**: the script prints the report markdown at the end. Present the findings grouped by severity (high → medium → low), each with its file path and a one-line problem statement, then give the absolute path of the generated `report.html`. If any reviewers failed, name them.

## Requirements (tell the user what is missing instead of failing silently)

- `claude` CLI installed and logged in (Claude Pro/Max subscription).
- Node 20+, git.
