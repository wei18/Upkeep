# Upkeep — Design Document

- Status: Implemented and shipped as v1 — this spec tracks the shipped behavior
- Date: 2026-06-04 (design); shipped 2026-06-05
- Location: Standalone repo `upkeep/`, spec at `docs/design.md` (see §6)
- Self-constraint: **This spec is the SSOT and must stay up-to-date as implementation evolves** (this tool exists to catch drift — the spec itself must not drift)

---

## 0. Goals

A **reusable GitHub Workflow (`on: workflow_call`)** that any repo can invoke at the job level via `uses: wei18/upkeep/.github/workflows/audit.yml@v1`. It scans the repo's contents, dispatches a team of specialized subagent reviewers, and checks whether the artifacts (code / docs / spec / diagrams / icons / flows / etc.) are:

- up-to-date (no drift from the actual codebase or recent commits)
- conformant with the repo's **own** conventions
- free of duplicate files
- free of unused (orphaned) assets

Output: an HTML deep-dive report (artifact) + a GitHub tracking issue (summary entry point).

Core principle: **convention over configuration** — anything that can be inferred from the repo's current state must never require manual input; stale config is itself a source of drift and must be avoided.

---

## 1. Architecture and Execution Flow

Form: a **reusable workflow** (`.github/workflows/audit.yml`, `on: workflow_call`), using the official `claude-code-action` as the LLM engine internally. Callers must supply a `CLAUDE_CODE_OAUTH_TOKEN` secret (via `secrets: inherit` or explicit passthrough).
> Why not a composite action: a composite action is a step sequence within a single job and **cannot use `strategy.matrix`**; matrix (one parallel job per reviewer) can only be expressed at the workflow job level, hence the choice of a reusable workflow (confirmed against official GitHub documentation).

**Orchestration model: fan-out → reduce (matrix + synthesis), no LLM lead.** Each enabled reviewer runs as an independent matrix **job** (containing one `claude-code-action` step; `fail-fast: false` + `continue-on-error` for fault isolation), producing structured findings independently; a subsequent synthesis job (single LLM) reads all findings and performs semantic cross-reviewer correlation. This does not rely on "spawning subagents within a single run" (that capability has been proven viable, but per-job execution is preferable for determinism, isolation, and zero residual-state risk).

Triggers: `schedule` (periodic full scan via cron) + `workflow_dispatch` (manual, with optional scope parameters).
> Detecting duplicate files, orphaned files, and global staleness requires a full-repo view that incremental PR scans cannot provide, so full scans are the primary mode.

Single-run data flow:

```
Trigger (schedule / workflow_dispatch)
  │
  ▼
[1] Discovery (deterministic, non-LLM heavy lifting)
    Scan repo → file inventory + modality classification (code/doc/spec/visual/flow/icon...)
    Read convention sources: CLAUDE.md, .claude/skills, .claude/workflows,
                .github/workflows, .claude/audit.yml (if present)
  │
  ▼
[2] Review (matrix: one claude-code-action step per enabled reviewer)
    GHA matrix gives native parallelism + fault isolation; the only concentrated LLM cost
    Each step carries: inventory + its file subset + composed rubric (built-in default ⊕ repo conventions)
    Each emits findings/<reviewer>.json (schema in §4)
  │
  ▼
[3] Synthesis (single claude-code-action, the only "connect-the-dots" brain)
    Reads all findings/*.json + inventory (compact structured material, no re-reading the whole repo)
    → semantic cross-reviewer correlation, dedup, systemic themes, prioritized narrative
    → synthesis.json
  │
  ▼
[4] Consolidate (deterministic)
    Mechanically merge findings + synthesis, dedup by key, sort (severity × confidence)
  │
  ▼
[5] Report (deterministic, zero LLM cost)
    ├─ Produce a self-contained single-file HTML report → upload artifact
    └─ Create/update tracking issue (markdown summary + link to HTML artifact)
```

Key points:
- Discovery / Consolidate / Report form the **deterministic orchestration skeleton**; Review and Synthesis are the LLM stages.
- **No LLM lead**: orchestration = GHA workflow (matrix) + Node. Reviewers in the Review stage are fully independent (no inter-reviewer communication required); cross-domain synthesis is handled by the Synthesis reduce step.
- Findings use a unified schema, enabling both Synthesis and Consolidate to process them mechanically.

### Local Execution (skill / script)

The same pipeline runs locally via `scripts/local-audit.sh <target>`: discovery → parallel `claude -p` reviewer subprocesses → synthesis → report. All intermediates (inventory, prompts, findings, synthesis) live in a `mktemp` work dir granted to Claude via `--add-dir` — nothing is written into the target repo. Local runs produce the same self-contained HTML report; instead of upserting a GitHub issue, the issue markdown is printed as the terminal summary. `skills/upkeep-audit/SKILL.md` is a thin Claude Code wrapper around the script: it maintains a clone in `~/.cache/upkeep`, runs the audit, and summarizes findings in chat.

---

## 2. Reviewer Team

Seven built-in reviewers (6 enabled, 1 disabled by default):

| Reviewer | Scope | Primary concerns | Default |
|---|---|---|---|
| `docs_staleness` | READMEs, documentation, comments, **multilingual README/doc variants** | Stale content, drift from code, broken links, **multilingual versions out of sync with base** | on |
| `code_hygiene` | Source code | Dead code, unused files/functions, divergence from spec | on |
| `spec_flow` | Specs, flowcharts, state machines | Flow inconsistent with implementation, outdated spec | on |
| `visual_icon` | Images, icons, design assets | Unused assets, duplicate images, size/naming convention violations | on |
| `duplicate_orphan` | Entire repo | Duplicate files, orphaned files, unreferenced assets | on |
| `convention` | Entire repo | Violations of the repo's own skills/workflows/CLAUDE.md conventions | on |
| `i18n` | Localization strings, `.lproj`, etc. | Missing translations, unused keys, out of sync with base | **off** |

The first version **does not support dynamic custom reviewers**; building `i18n` as a built-in (off by default) covers the common need without over-engineering (YAGNI).

### Rubric Three-Layer Composition (priority order, lowest to highest)

```
Built-in default rubric (shipped with the action; defines what this specialty looks for)
   ⊕ repo-convention auto-discovery (the domain-relevant parts of
                         CLAUDE.md / .claude/skills / .claude/workflows)
   ⊕ audit.yml explicit override (the repo file pointed to by reviewers.<name>.rubric) ← highest priority
```

When a repo has its own standards, those take priority. `convention` relies almost entirely on the repo's own conventions; `visual_icon` relies mainly on built-in defaults plus the repo's design guidelines (if any exist).

**Reviewer rubric language (`rubric_lang`)**: the built-in rubrics ship per-locale under `reviewers/<locale>/` (e.g. `reviewers/en/`, `reviewers/zh-TW/`). The `rubric_lang` workflow input (default `en`) selects which set the reviewers and synthesis use.

### 2.1 Multilingual Doc-Set Sync Detection

Handled by `docs_staleness` (not `i18n` — `i18n` manages code-layer localization strings such as `.lproj`/`Localizable.strings`; documentation translation drift is a doc concern).

- **Directory convention**: Multilingual docs live at `docs/<locale>/<name>.md` (e.g., `docs/zh-TW/overview.md`). The sole exception is the repo root `README.md` = **English base** (GitHub convention), with per-language translations at `docs/<locale>/README.md`.
- **Base language**: `en` (root `README.md` and `docs/en/*` are authoritative).
- **Supported languages (up to 6)**: `en` (base), `zh-TW`, `zh-CN`, `ja`, `ko` (sixth slot reserved).
- **Detection**: Using the base (`docs/en/<name>.md`, or root `README.md` for the README) as the reference, report "behind / missing / stale" for each `docs/<locale>/<name>.md`. Follows the §3 principle — evidence-backed (git recency: base was modified but a translation was not), does not assume "the translation is always the one that needs updating," though when the base is newer it typically indicates a lagging translation.
- **Grouping**: The reviewer groups files by same filename across `docs/<locale>/` subdirectories (for README, the root `README.md` and all `docs/<locale>/README.md` files are treated as one group).
- **Dogfooding**: This repo's own user-facing documentation suite (README, overview, design, why-reusable-workflow, plans) is fully multilingualized under `docs/<locale>/`, serving as a real-world test sample for this capability (see §10).

---

## 3. SSOT Handling Principle (No Presumed Ground Truth)

The problem: spec and code are not always the SSOT — sometimes **the spec itself is the outdated party**. Hardcoding a fixed direction produces false positives.

Principle: **reviewers do not presume a SSOT; they detect "divergence" and defer direction to evidence and tiered judgment.**

1. **Detect divergence, don't conclude**: report "A says X, B says Y, they are inconsistent" — not "B is stale."
2. **Attach evidence signals**: last-modified timestamp / commit recency, reference count, direction of references.
3. **Tiered judgment**:
   - Strong evidence (e.g., a file untouched for six months while related code was heavily changed last week) → state the direction explicitly in the suggestion ("README appears older; updating it is recommended"), but still mark `needs-confirmation`.
   - Weak evidence → flag "drift, direction requires human judgment."
   - **Never auto-apply fixes under any circumstances** (auto-fix is a second-phase feature).
4. **SSOT is not declared via a config file**: direction is always inferred, avoiding the risk of the declaration file itself becoming stale. Repos with a firm policy may use the escape hatch to override, but this is non-mandatory and discouraged.

---

## 4. findings Schema

Each reviewer emits one record per issue:

```jsonc
{
  "file": "path/to/file",          // primary file (cross-file issues go on the primary; related[] supplements)
  "related": ["path/..."],          // related files (may be empty)
  "reviewer": "docs_staleness",
  "category": "staleness | duplicate | orphan | convention | inconsistency | ...",
  "problem": "human-readable problem description",
  "evidence": "supporting evidence (git timestamps, reference relationships, the specific mismatch)",
  "suggestion": "suggested fix (may include a direction under tiered judgment)",
  "severity": "high | medium | low",
  "confidence": "high | medium | low",
  "ssot_direction": "stale_a | stale_b | uncertain | n/a",
  "status": "ok"                    // reviewer level: ok | failed
}
```

Each reviewer step outputs one `findings/<reviewer>.json`: `{ reviewer, status: "ok"|"failed", findings: Finding[] }`. When a single reviewer fails, `status:"failed"` and `findings:[]` are emitted without affecting others.

**Consolidate deduplication/sorting (deterministic)**: merges cross-reviewer duplicates using `file` + `category` as the key — for the same key, the "representative finding" is the one with the highest severity × confidence (ties broken by reviewer enumeration order as a stable tiebreak); `reviewers[]` is the union of all reporters for that key, and `related[]` is the union of all related files. Sort key = severity desc → confidence desc → file asc.

### 4.1 Synthesis Output

The Synthesis step reads all `findings/*.json` + inventory and outputs `synthesis.json`. **References findings by file path (not integer index — more stable for LLMs and human-readable)**:

```jsonc
{
  "themes": [                         // systemic themes spanning reviewers
    {
      "title": "brief statement of the systemic issue",
      "narrative": "why these findings point to one root cause",
      "related_files": ["path/a", "path/b"],  // file paths this theme covers
      "priority": "high | medium | low"
    }
  ],
  "semantic_duplicates": [[ "reviewer|file|category", "reviewer|file|category" ]], // groups of semantically duplicate finding keys
  "executive_summary": "one-paragraph summary of overall health",
  "status": "ok"                      // synthesis failure → report still emits raw findings
}
```

The Report uses both raw findings and synthesis output; if synthesis fails or is absent, it degrades gracefully to presenting only raw findings (no themes or executive summary).

---

## 5. Configuration File `.claude/audit.yml` (fully optional — the action runs correctly without it)

`scan` and `ssot` **are not config options** (they would become stale); both are auto-inferred instead.

```yaml
# .claude/audit.yml — fully optional; usually you don't need this file
version: 1
ignore:                  # optional: glob paths dropped from the whole audit (all reviewers)
  - "docs/*/plans/**"    # e.g. archived design records you don't want audited
reviewers:               # list only what to disable / re-scope / enable (i18n); the rest stay default
  visual_icon: { enabled: false }
  i18n:        { enabled: true }
report:
  issue_label: "audit"   # defaults to "audit"; set only to change
  min_severity: "low"    # below this does not enter the issue (still in the full HTML report)
```

> Config keys are shown in `snake_case` (`issue_label`, `min_severity`); both `snake_case` and the internal `camelCase` (`issueLabel`, `minSeverity`) are accepted.

### Auto-Inference (no configuration required)

- **Scan scope**: respects the repo's `.gitignore`; automatically skips binaries, lockfiles, and build artifacts; text files have a built-in 100 KB limit (see §7 modality routing).
- **SSOT direction**: fully evidence-driven (§3), no declaration file.

---

## 6. Repo Location (finalized)

This action is published to be referenced via `uses:`, so it lives in its own repo. Local directory: `/Users/zw/GitHub/Wei18/repo-audit-action/` (already `git init`-ed); **published/package name is `Upkeep`** (`uses: wei18/upkeep@v1`) — the difference between the local folder name and the published name is intentional.

Expected structure:

```
repo-audit-action/                   # local directory (published name: Upkeep)
├── .github/
│   ├── workflows/audit.yml          # reusable workflow (on: workflow_call): jobs/matrix orchestration
│   └── actions/                     # composite sub-actions (used by the workflow's jobs; carry Upkeep's own code)
│       ├── discovery/  reviewer/  synthesis/  report/
├── README.md                        # English base usage (job-level uses: example, secret/permissions) + language switcher
├── docs/
│   ├── en/      no README (root is en); overview.md  design.md  why-reusable-workflow.md  plans/
│   ├── zh-TW/   README.md  overview.md  design.md  why-reusable-workflow.md  plans/
│   ├── zh-CN/ … ja/ … ko/   (one set per language, same as above)
│   └── (all multilingual user docs under docs/<locale>/; root README.md is the en base)
├── skills/upkeep-audit/             # Claude Code skill: thin local-run wrapper (clones to ~/.cache/upkeep)
├── scripts/local-audit.sh           # local pipeline orchestrator (same flow as CI; temp-dir intermediates)
├── reviewers/<locale>/              # 7 built-in rubrics + _reviewer-prompt + _synthesis-prompt, per locale (en, zh-TW); picked by rubric_lang
├── src/                             # deterministic TS: discovery/consolidate/report/matrix/prompt-bundle, etc.
└── test/                            # unit + contract + e2e (samples in §10)
```

> Archive note: the `docs/<locale>/plans/` tree is a deliberate **archive** of the original step-by-step implementation plans (one set per locale). It is intentionally unlinked from any navigation index, and its fenced blocks (code and embedded doc templates) are kept **verbatim** from the zh-TW source — so empty `referencedBy` and in-fence non-English text on these files are expected, not drift.

> Sub-action mechanism: jobs in a reusable workflow run on the **caller's** checkout; Upkeep's own code (`src/`, `reviewers/`) is brought in via `uses: wei18/upkeep/.github/actions/<x>@v1` (GitHub fetches the Upkeep repo automatically). Each reviewer is an independent matrix job running a plain `claude-code-action` prompt (writing `findings/<reviewer>.json`), so **no in-run subagent spawning is required**, eliminating any `--agents`/`Agent` passthrough risk.

---

## 7. Modality Routing (replacing "one byte limit for everything")

The 100 KB limit should govern only files being fed as text to an LLM — it should not apply to images.

| File type | Handling | 100 KB byte limit |
|---|---|---|
| Text (code/doc/spec/`.md`) | Read as text; if over limit → **chunk or summarize then deep-read on demand**, never silently discard | Applied (over limit → chunk) |
| Vector/text-format diagrams (`.svg`/`.mmd`/`.dot`/`.puml`) | Read as **raw source text** (semantically diffable) | Applied (typically very small) |
| Raster images (png/jpg/webp…) | Byte size is irrelevant; governed by **dimension/megapixel budget**; downscale before sending to vision | **Not applied** |

Key insight: most visual reviewer work does not require "seeing" the image —
- Duplicate images → file hash (exact or perceptual)
- Orphaned images → reference graph
- Naming/size conventions → metadata
- **Only "does the image content match the design/spec?" warrants vision (with downscaling first)**

The only files that get skipped are oversized, unprocessable unknown binaries — and the report explicitly lists them as `not inspected: oversized binary`, never silently dropped.

---

## 8. Resilience / Degradation

| Failure scenario | Handling |
|---|---|
| A reviewer matrix step crashes or times out | That step emits `status:"failed"`, `findings:[]` (matrix `fail-fast: false`); remaining steps continue normally; the report and issue explicitly note "X was missing from this run" |
| Anthropic API transient error | That step retries (exponential backoff, max 2 retries); degrades only if retries are exhausted |
| Synthesis step fails | Degrades: Report presents only raw findings (no cross-domain themes/narrative); the overall run does not fail |
| All reviewers fail | Workflow fails; no empty issue is created |
| Discovery scans 0 files | Completes normally, leaves a log entry, not treated as an error |

Principle: failures within the Review/Synthesis stage are always isolated and degraded gracefully; only failures in the deterministic skeleton (Discovery/Consolidate/Report) cause the entire run to fail.

---

## 9. Cost Controls

- 100 KB/file limit + skip binaries/lockfiles/build artifacts (§5, §7)
- **Tiered reading**: send file list + summaries first; reviewers request deep reads on specific files — never blindly stuff full file contents
- HTML / issue assembly is pure string processing — **zero LLM cost**

---

## 10. Test Strategy

Test sample: the real remote repo **https://github.com/wei18/Sudoku** (used instead of an in-repo fixture).

- **Deterministic layer → unit tests (TDD)**: Discovery classification, Consolidate deduplication and sorting, HTML/issue assembly — no LLM involved.
- **LLM layer → contract tests**: verify that subagent output **conforms to the findings schema** (all fields present, `severity`/`confidence`/`ssot_direction` within valid value sets); do not assert on content verbatim.
  - CI: uses **recorded fake responses** for schema contract tests (cost-free and stable).
  - Live API calls: manual only / pre-release smoke tests.
- **End-to-end smoke**: runs the full action against the Sudoku repo, asserts that the HTML artifact and issue exist, findings conform to schema, and a reasonable number of issues were detected (no verbatim assertions).

---

## 11. Scope Boundaries (out of scope for v1)

- Auto-fix PRs (automatically updating READMEs or deleting orphaned files) — deferred to v2
- Dynamic custom reviewers — the built-in `i18n` reviewer already covers this
- PR incremental mode — full scans are the primary mode
- SSOT declaration file — replaced by pure inference
