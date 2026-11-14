---
name: upkeep-audit
description: Run the Upkeep repo audit locally against any repository path. Use when asked to audit a repo, check docs/spec/asset drift, or run upkeep without GitHub Actions.
---

# Upkeep Local Audit

Run the full Upkeep audit pipeline (discovery → parallel reviewers → synthesis → HTML report) against a local repository. Output-only: the target repo is never modified.

Do not use this skill to set up the CI workflow (see "Automate it in CI" in the Upkeep README) or to review a PR diff: it always audits the whole repository.

## Steps

1. **Ensure the Upkeep checkout** at `~/.cache/upkeep`:
   - Missing: `git clone --depth 1 https://github.com/wei18/upkeep ~/.cache/upkeep`
   - Present: `git -C ~/.cache/upkeep pull --ff-only` (if the pull fails — diverged or dirty checkout — delete `~/.cache/upkeep` and re-clone; it is disposable)
   - Then `(cd ~/.cache/upkeep && npm ci)` after a fresh clone or whenever the pull changed `package-lock.json` (when unsure, run it — it is idempotent).
2. **Choose the report path.** The report defaults to `./upkeep-report.html` in the current working directory. If the current working directory is inside the target repo, pass `--out` with a path outside it (e.g. `~/upkeep-report.html`): the audit must never write into the target repo.
3. **Run the audit** in the background. It takes several minutes; the reviewers run as parallel `claude -p` subprocesses.
   ```bash
   ~/.cache/upkeep/scripts/local-audit.sh <target-path> [--model M] [--rubric-lang L] [--max-turns N] [--out FILE] [--keep-work]
   ```
   - Pass `--model`, `--rubric-lang`, `--max-turns` and `--keep-work` only when the user asked for them. The defaults match the CI inputs: `claude-opus-4-8`, rubric `en`, `30` turns.
   - `--rubric-lang` accepts `en` or `zh-TW`.
   - `--keep-work` keeps the temporary work directory (inventory, prompts, findings, synthesis) and prints its path. Use it to debug a failed reviewer.
   - Progress: the script prints `upkeep: reviewers: <names>` when the reviewers start and `upkeep: report written to <path>` when it finishes. Tell the user when each of the two lines appears.
4. **Summarize**: the script prints the report markdown at the end. Present the findings grouped by severity (high → medium → low), each with its file path and a one-line problem statement, then give the absolute path of the generated report file (`upkeep-report.html` by default, or the `--out` path). If any reviewers failed, name them.

## Requirements (tell the user what is missing instead of failing silently)

- `claude` CLI installed and logged in (Claude Pro/Max subscription).
- Node 20+, git.
