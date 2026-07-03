# Local Audit Skill — Design

Date: 2026-06-10
Status: Implemented (2026-06-10); updated 2026-07-04 (documented `--keep-work` and the output-only safety mechanisms added since first implementation)

## Goal

Let anyone run the full Upkeep audit pipeline locally — from a Claude Code skill or a plain shell script — by passing the path of the repo to audit. No GitHub Actions, no repo secrets, no GitHub permissions.

## Non-goals

- No GitHub issue upsert in local mode (CI-only).
- No npm package / CLI publishing.
- No new reviewer logic; local mode reuses the existing pipeline unchanged.

## Architecture

Two new files:

```
skills/upkeep-audit/SKILL.md   # thin wrapper: cache mgmt + run script + summarize
scripts/local-audit.sh         # deterministic orchestrator: full pipeline
```

Rationale: pipeline logic lives in a testable bash script consistent with the project style (deterministic TS CLIs + thin glue). The skill is a thin wrapper so non–Claude Code users can run the script directly.

## Data flow (`scripts/local-audit.sh <target> [flags]`)

```
WORK=$(mktemp -d)                                  # never write into the target repo
trap 'rm -rf "$WORK"' EXIT                         # skipped when --keep-work is passed
if target is a git repo: PRE_STATUS=$(git status --porcelain)   # output-only guard, snapshot before
else: print warning (output-only guarantee cannot be verified)
tsx src/discovery.ts <target> $WORK/inventory.json
tsx src/matrix.ts <target>                         # → enabled reviewer list
for each reviewer (parallel, mirrors CI matrix):
  tsx src/prompt-bundle.ts <r> $WORK/inventory.json $WORK/prompts/<r>.txt <rubric_lang>
  (cd <target> && claude -p "Read $WORK/prompts/<r>.txt …; write $WORK/findings/<r>.json" \
     --allowedTools Read,Glob,Grep,Write --add-dir $WORK \
     --max-turns <n> --model <m>) || true          # continue-on-error, same as CI
  pollution guard: if the model wrote findings/<r>.json into <target> anyway, move it into $WORK and delete it from <target>
  tsx src/finalize.ts reviewer <r> $WORK/findings/<r>.json   # failed-fallback, same as CI
fallback loop: for each reviewer still missing $WORK/findings/<r>.json (e.g. a background job died early), run the finalize failed-fallback for it
synthesis: tsx src/synthesis-prompt-cli.ts → claude -p (same pattern, same pollution guard for synthesis.json) → tsx src/finalize.ts synthesis
if target is a git repo: POST_STATUS=$(git status --porcelain); diff vs PRE_STATUS; on mismatch print the diff and exit 1
tsx src/report.ts $WORK/findings $WORK/synthesis.json <out.html> $WORK/issue.md $WORK/inventory.json
print: report path + issue.md content (the chat-summary source); if --keep-work, also print the $WORK path
```

Key differences vs CI:

- All intermediates go to a temp dir, authorized via `--add-dir` (CI uses a disposable checkout; local must not pollute the target repo).
- The reviewer/synthesis wrapper prompts point Claude at absolute temp paths instead of "repository root".
- `issue.md` is printed instead of upserted to GitHub.

Flags (defaults match CI inputs): `--model claude-opus-4-8`, `--rubric-lang en`, `--max-turns 30`, `--out <path>` (default `./upkeep-report.html` in cwd), `--keep-work` (skip the `$WORK` cleanup trap and print its path at the end, for debugging).

## SKILL.md behavior

1. Ensure cache: `~/.cache/upkeep` absent → `git clone --depth 1`; present → `git pull`; then `npm ci` (skip if lockfile unchanged).
2. Run `scripts/local-audit.sh <user-supplied target path>` with any user-requested flags.
3. Read the printed `issue.md` summary; present findings grouped by severity in chat, plus the `report.html` path.

## Error handling

- `set -euo pipefail` in the script; each `claude -p` call wrapped with `|| true` (CI's `continue-on-error` analog).
- `finalize.ts` already writes a `failed` fallback findings file when output is missing/invalid — reused as-is; a second fallback loop after the parallel reviewer run guarantees every enabled reviewer has a findings file even if its background job died before writing one.
- Missing `claude` CLI / not logged in: script checks `command -v claude` upfront and exits with a clear message.
- Output-only guard, technically enforced (not just prompted): when the target is a git repo, the script snapshots `git status --porcelain` before the reviewers/synthesis run and again after; a mismatch prints the diff and exits 1 so the operator knows the audited repo was touched. Against a non-git target the guarantee can't be verified this way, so the script prints a warning instead of silently assuming safety.
- Stray-file pollution guard: reviewer/synthesis prompts instruct Claude to write into `$WORK`, but if a model writes `findings/<r>.json` or `synthesis.json` into the target repo anyway, the script moves the file into `$WORK` and removes it (and any now-empty `findings/` dir) from the target before the output-only diff runs.
- `$WORK` cleanup: `trap 'rm -rf "$WORK"' EXIT` removes the temp work dir on exit; `--keep-work` skips the trap and prints the `$WORK` path at the end so intermediates can be inspected.

## Prerequisites checklist

| Dependency | Status |
|---|---|
| `claude` CLI installed and logged in (Pro/Max) | Verified ✓ (documented in README requirements) |
| `claude -p` supports `--allowedTools` / `--max-turns` / `--model` / `--add-dir` | Verified ✓ (CI passes the same flags via `claude_args`) |
| Node 20+, git, npm | Verified ✓ (same as CI requirements) |

## Documentation updates (doc-lockstep)

> **Superseded (2026-06-12):** the README layout below (`## Usage`, `## Run locally`) was reorganized by the v2 plugin-repositioning (see `2026-06-11-v2-plugin-repositioning-design.md`). The local-execution docs now live under `## Run as a plain script`, and the skill/plugin install paths under `## Install`. The intent — local execution must be documented and propagated across all five locales — still holds; only the section names changed.

- `README.md` (en): new `## Run locally` section between `## Usage` and `## Reviewers`:
  - Claude Code skill install (copy `skills/upkeep-audit/` to `~/.claude/skills/`) and invocation ("audit /path/to/repo").
  - Direct script usage without Claude Code.
  - Requirements: logged-in `claude` CLI (no `setup-token`, no GitHub permissions), Node 20+, git.
  - Output difference: `report.html` + terminal/chat summary; no GitHub issue.
  - Flags table mirroring CI inputs.
- Propagate the section to `docs/{zh-TW,zh-CN,ja,ko}/README.md`.
- `docs/en/design.md` (SSOT): add a local-execution architecture subsection; update the directory-structure diagram with `skills/` and `scripts/`; propagate to all five locales.
- `.github/CONTRIBUTING.md`: enumeration unchanged (no new doc file types).

## Testing

- Run `scripts/local-audit.sh` against a small fixture repo (or this repo itself); verify `report.html` and per-reviewer findings JSON are produced, and that a forced reviewer failure yields the `failed` fallback entry in the report.
- Unit tests: none needed beyond existing coverage — the script reuses already-tested CLIs. Shell logic kept minimal.

## Risks

- The dogfood self-audit may flag this spec file or the new `skills/` dir as unreferenced; the README/design.md updates above are the mitigation (they reference both).
- Parallel `claude -p` processes share the user's subscription rate limits; if throttling proves problematic, drop to bounded concurrency later (not speculatively now).
