<p align="center">
  <img src="docs/assets/banner.svg" alt="Upkeep — your AI writes fast, Upkeep keeps it honest" width="100%">
</p>

# Upkeep

**English** · [繁體中文](docs/zh-TW/README.md) · [简体中文](docs/zh-CN/README.md) · [日本語](docs/ja/README.md) · [한국어](docs/ko/README.md)

**An AI audit crew for your repo, installed as a skill.** Upkeep dispatches focused AI reviewers in parallel to catch drift — stale docs, specs that no longer match the code, orphaned assets, broken conventions — and reports it with evidence before it compounds.

> 💳 **No separate API bill.** Upkeep runs on your existing **Claude Pro/Max subscription** — your logged-in `claude` CLI locally, or OAuth via `claude setup-token` in CI. No Anthropic API key, no per-token billing. And it's **output-only**: it reports drift with evidence and severity, but never edits or deletes your files.

## Install

**Claude Code** — install as a plugin:

```
/plugin marketplace add wei18/upkeep
/plugin install upkeep@upkeep
```

**Other agents** (Cursor, Copilot, and any of the 70+ agents supported by [skills](https://github.com/vercel-labs/skills)):

```bash
npx skills add wei18/upkeep --skill upkeep-audit
```

**Requirements:** a logged-in `claude` CLI (Pro/Max), Node 20+, git — the engine runs on your machine in every install mode.

Then ask in any session:

> Run an upkeep audit on /path/to/repo

On first use the skill clones the Upkeep engine into `~/.cache/upkeep` and installs dependencies automatically. You get findings grouped by severity in chat, plus a self-contained HTML report.

## What it does

- Scans a repository and dispatches a team of **focused AI reviewers** in parallel.
- Catches stale docs that drifted from code, specs that no longer match implementation, duplicate or orphaned files, convention violations, and out-of-sync translated docs.
- **Reports divergence with evidence** — it does not assume one artifact is always the source of truth.
- **Never edits or deletes anything** — output only.
- Produces a self-contained **HTML report** — and, when run in CI, a **persistent GitHub tracking issue** (upserted, never duplicated).

## How it compares

Upkeep isn't a linter or a PR bot — it's a **whole-repo, semantic drift auditor**. Different tool, different job:

| | **Upkeep** | Danger | Copilot / Cursor PR review |
|---|---|---|---|
| Looks at | The **whole repo** — docs, specs, assets, conventions | A PR's diff | A PR's diff |
| Finds | **Semantic drift** (README promises X, code does Y) | Rule violations **you hand-write** | Code issues in the diff |
| Rubric | Your repo's **own** conventions | Your custom rules | General code knowledge |
| Cadence | Scheduled or on-demand, repo-wide | Per PR | Per PR |
| Edits your code? | **Never** — output only | No | Suggests changes |
| Cost | Your **Claude Pro/Max** plan | Free (you write the logic) | Copilot/Cursor subscription |

## Run as a plain script

No agent at all? The same pipeline runs as a standalone script:

```bash
git clone --depth 1 https://github.com/wei18/upkeep ~/.cache/upkeep
cd ~/.cache/upkeep && npm ci
./scripts/local-audit.sh /path/to/repo --out ~/upkeep-report.html
```

| Flag | Default | CI equivalent |
|---|---|---|
| `--model` | `claude-opus-4-8` | `model` |
| `--rubric-lang` | `en` | `rubric_lang` |
| `--max-turns` | `30` | `max_turns` |
| `--out` | `./upkeep-report.html` | report artifact |

**Requirements:** a logged-in `claude` CLI (Pro/Max; no `setup-token` and no GitHub access needed), Node 20+, git.

**Output:** the same self-contained HTML report (`upkeep-report.html` by default) plus a terminal summary. Local runs never create GitHub issues.

Prefer a manual skill install? Copy [`skills/upkeep-audit/`](skills/upkeep-audit/) into `~/.claude/skills/`.

## Automate it in CI

The same audit crew, on a schedule. Create `.github/workflows/audit.yml` in your repo:

```yaml
name: repo audit
on:
  schedule:
    - cron: '0 3 * * 1'   # weekly, Monday 03:00 UTC
  workflow_dispatch:        # also run manually

permissions:
  contents: read
  issues: write
  id-token: write

jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@v2
    with:
      model: claude-opus-4-8     # optional
      issue_label: audit         # optional; default: audit
      rubric_lang: en            # optional; reviewer language: en | zh-TW
    secrets:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

**Requirements**

- A repo secret named `CLAUDE_CODE_OAUTH_TOKEN` — generate it locally with `claude setup-token` (available to Claude Pro/Max subscribers; usage counts against your subscription).
- The `permissions` block shown above (`contents: read` + `issues: write` + `id-token: write`).

**Outputs**

- A GitHub issue labeled `audit` — the same issue is updated on every run (upserted), not duplicated.
- A self-contained HTML report uploaded as the `report-html` workflow artifact. The tracking issue links straight to it; otherwise find it under the run's **Artifacts** (Actions → the run) or grab it with `gh run download <run-id> -n report-html`. GitHub serves artifacts as a downloadable zip, and they expire per your repo's retention setting.

> Already on `@v1`? It keeps working but is frozen — switch the tag to `@v2`. The interface is identical.

### Or as a Marketplace action

Prefer the familiar `- uses:` step syntax, or want Upkeep to show up in the
[GitHub Marketplace](https://github.com/marketplace)? Use the **Upkeep Audit**
action instead — same engine, same inputs, but the reviewers run one after
another instead of in parallel (see
[`docs/why-reusable-workflow.md`](docs/en/why-reusable-workflow.md) for why
the reusable workflow above is the primary path):

```yaml
name: repo audit
on:
  schedule:
    - cron: '0 3 * * 1'   # weekly, Monday 03:00 UTC
  workflow_dispatch:

permissions:
  contents: read
  issues: write
  id-token: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: wei18/upkeep@v2
        with:
          model: claude-opus-4-8               # optional
          issue_label: audit                    # optional; default: audit
          rubric_lang: en                       # optional; reviewer language: en | zh-TW
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Same requirements as above: a repo secret named `CLAUDE_CODE_OAUTH_TOKEN`
(from `claude setup-token`) and the `permissions` block, now on the job
itself since a step action can't declare its own permissions.

## Reviewers

| Name | Default | Checks |
|---|---|---|
| `docs_staleness` | on | Docs that drifted from code; out-of-sync multilingual READMEs and translated docs |
| `code_hygiene` | on | Dead code, unused exports, commented-out blocks left in permanently |
| `spec_flow` | on | Specs, diagrams, and flow charts that no longer match the implementation |
| `visual_icon` | on | Outdated or mismatched images and icons |
| `duplicate_orphan` | on | Duplicate files and orphaned/unreferenced assets |
| `convention` | on | Violations of the repo's own conventions (CLAUDE.md, `.claude/skills`, workflows) |
| `i18n` | **off** | Internationalization consistency across locale files |

## Configuration

There are two separate configuration surfaces, by design:

- **Workflow inputs** (the caller's `with:` block above; locally, the equivalent script flags) control *how the engine runs*: `model`, `max_turns`, `issue_label`, `rubric_lang`.
- **`.claude/audit.yml`** (committed in the audited repo) controls *what gets audited*: which reviewers are enabled, per-reviewer rubric overrides, and `report.minSeverity`. Reviewer enablement lives here — not as a workflow input — because it is a per-repo policy that should evolve with the repo.

Everything is optional. To turn on the off-by-default `i18n` reviewer, for example:

```yaml
# .claude/audit.yml
reviewers:
  i18n:
    enabled: true
```

See [`docs/design.md`](docs/en/design.md) for the full schema and options.

## Docs

- [`docs/overview.md`](docs/en/overview.md) — how the pipeline works
- [`docs/design.md`](docs/en/design.md) — full design reference
- [`docs/why-reusable-workflow.md`](docs/en/why-reusable-workflow.md) — why the CI layer is a reusable workflow, not a `- uses:` step action
