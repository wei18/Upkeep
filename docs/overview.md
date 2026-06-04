# How upkeep works

## The problem

Repos accumulate drift. A function gets refactored but its doc block stays stale. A spec describes behavior that was revised three sprints ago. A translated README falls a version behind the English original. An icon file gets replaced but the old one stays committed. None of this breaks CI — it just silently erodes the reliability of everything written down.

Periodic human review catches some of it, but it requires keeping the full context of every artifact in your head simultaneously. That's exactly what a team of focused AI reviewers is well suited for.

## The pipeline: fan-out → synthesis → report

upkeep runs as a reusable `workflow_call` workflow composed of four deterministic stages.

**1. Discovery**

A discovery step walks the repository and produces a structured file inventory: source files, docs, specs, diagrams, images, icons, locale files, and convention files (CLAUDE.md, `.claude/skills`, workflow definitions). This inventory is the shared input for all reviewers.

**2. Parallel reviewers (fan-out)**

Each enabled reviewer runs as its own isolated matrix job. Jobs run in parallel and are fault-tolerant — a failure in one reviewer does not block the others. Each reviewer receives the file inventory and its focused mandate, and writes its findings to a structured output.

**3. Synthesis**

A single synthesis step reads all reviewer findings and identifies cross-cutting themes — for example, a pattern of convention drift concentrated in a particular directory, or multiple reviewers independently flagging the same file for different reasons. It produces an executive summary alongside the per-reviewer detail.

**4. Report**

A deterministic report step renders everything into a self-contained HTML file (no external dependencies) and upserts a GitHub tracking issue. The same issue is reused across runs so your issue tracker stays clean.

## Reviewers

| Reviewer | What it checks |
|---|---|
| `docs_staleness` | Documentation that has drifted from the code it describes; multilingual READMEs and translated docs that are out of sync with the base language version |
| `code_hygiene` | Dead code paths, unused exports, permanently commented-out blocks |
| `spec_flow` | Specs, architecture diagrams, and flow charts whose content no longer matches the actual implementation |
| `visual_icon` | Images and icons that are outdated, mismatched, or inconsistent with current UI or branding |
| `duplicate_orphan` | Duplicate files (same or near-identical content under different names/paths) and orphaned assets that are committed but never referenced |
| `convention` | Deviations from the repo's own declared conventions — CLAUDE.md rules, `.claude/skills` patterns, and workflow standards |
| `i18n` | Consistency across locale/translation files (disabled by default; opt in via `.claude/audit.yml`) |

## No assumed source of truth

When two artifacts disagree — say, a spec describes behavior X but the code implements behavior Y — upkeep does not automatically declare one of them stale. Either artifact could be the outdated one. Instead, it reports the divergence with supporting evidence: git recency of each file, cross-references found in other files, and any explicit versioning present. The human decides what to fix.

## Report only, never edits

upkeep has no write access to your repository content. It reads files and opens/updates a single GitHub issue. It will never modify, rename, or delete any file in your repo.

## Outputs

**HTML report** — Uploaded as the `report-html` workflow artifact on every run. Self-contained; open it locally without a server. Contains the executive summary, per-reviewer findings, and the evidence cited for each finding.

**GitHub tracking issue** — Created on first run, then updated (upserted) on every subsequent run. Labeled `audit` by default. Provides a persistent, linkable record of the current repo health without polluting your issue tracker with duplicate entries.
