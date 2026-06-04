# upkeep

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

jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@v1
    with:
      model: claude-opus-4-8     # optional
      issue_label: audit         # optional; default: audit
    secrets:
      anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

**Requirements**

- A repo secret named `ANTHROPIC_API_KEY`.
- The `permissions` block shown above (`contents: read` + `issues: write`).

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

All configuration is optional — zero setup required beyond the caller workflow above. To enable or tune reviewers, create `.claude/audit.yml`; see [`docs/design.md`](docs/design.md) for the full schema and options.

## Docs

- [`docs/overview.md`](docs/overview.md) — how the pipeline works
- [`docs/design.md`](docs/design.md) — full design reference

## Translated READMEs

- [繁體中文](README.zh-TW.md)
- [简体中文](README.zh-CN.md)
- [日本語](README.ja.md)
- [한국어](README.ko.md)
