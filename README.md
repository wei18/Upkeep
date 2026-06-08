# Upkeep

**English** · [繁體中文](docs/zh-TW/README.md) · [简体中文](docs/zh-CN/README.md) · [日本語](docs/ja/README.md) · [한국어](docs/ko/README.md)

A reusable GitHub Actions workflow that keeps your repo's docs, specs, and assets honest — catching drift before it compounds.

## What it does

- Scans a repository and dispatches a team of **focused AI reviewers** (powered by Anthropic's `claude-code-action`) in parallel.
- Catches stale docs that drifted from code, specs that no longer match implementation, duplicate or orphaned files, convention violations, and out-of-sync translated docs.
- **Reports divergence with evidence** — it does not assume one artifact is always the source of truth.
- **Never edits or deletes anything** — output only.
- Produces a self-contained **HTML report** (workflow artifact) and a **persistent GitHub tracking issue** (upserted, never duplicated).

## Usage

Create `.github/workflows/audit.yml` in your repo:

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
    uses: wei18/upkeep/.github/workflows/audit.yml@v1
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
- A self-contained HTML report uploaded as the `report-html` workflow artifact.

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

- **Workflow inputs** (the caller's `with:` block above) control *how the engine runs*: `model`, `max_turns`, `issue_label`, `rubric_lang`.
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
- [`docs/why-reusable-workflow.md`](docs/en/why-reusable-workflow.md) — why it's a reusable workflow, not a `- uses:` step action
