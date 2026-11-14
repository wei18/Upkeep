# Upkeep — Design Document

- Status: shipped. This spec describes current behavior.
- Location: repo `wei18/upkeep`. English base: `docs/en/design.md`; translations: `docs/<locale>/design.md` (see §6)
- Self-constraint: **This spec is the SSOT and must stay up-to-date as implementation evolves** (this tool exists to catch drift — the spec itself must not drift)

---

## 0. Goals

A **reusable GitHub Workflow (`on: workflow_call`)** that any repo can invoke at the job level via `uses: wei18/upkeep/.github/workflows/audit.yml@v2`. It scans the repo's contents, dispatches a team of specialized subagent reviewers, and checks whether the artifacts (code / docs / spec / diagrams / icons / flows / etc.) are:

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

Triggers: the reusable workflow declares only `on: workflow_call`, so the caller's workflow owns the trigger — typically `schedule` (periodic full scan via cron) plus `workflow_dispatch` (manual run). The workflow takes no scope inputs: every run is a full scan.
> Detecting duplicate files, orphaned files, and global staleness requires a full-repo view that incremental PR scans cannot provide, so full scans are the primary mode.

Single-run data flow:

```
Caller's trigger (schedule / workflow_dispatch)
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

The same pipeline runs locally via `scripts/local-audit.sh <target>`: discovery → parallel `claude -p` reviewer subprocesses → synthesis → report. All intermediates (inventory, prompts, findings, synthesis) live in a `mktemp` work dir granted to Claude via `--add-dir` — nothing is written into the target repo. Local runs produce the same self-contained HTML report; instead of upserting a GitHub issue, the issue markdown is printed as the terminal summary. `skills/upkeep-audit/SKILL.md` is a thin Claude Code wrapper around the script: it maintains a clone in `~/.cache/upkeep`, runs the audit, and summarizes findings in chat. The skill is distributed three ways, all pointing at the same directory: as a Claude Code plugin (`.claude-plugin/marketplace.json` at the repo root lists `skills/upkeep-audit/` as a single-skill plugin named `upkeep`, installed via `/plugin install upkeep@upkeep`), via `npx skills add wei18/upkeep --skill upkeep-audit` (vercel-labs/skills flat layout), or by manual copy into `~/.claude/skills/`. Distribution is packaging only — the CI workflow remains a direct pipeline entry and does not route through the skill.

### Marketplace Composite Action

A third integration path packages the same engine as a composite action at the repo root (`action.yml`), giving callers the conventional `- uses: wei18/upkeep@v2` step syntax and a listing on the [GitHub Marketplace](https://github.com/marketplace). Because a composite action is a single job with no `strategy.matrix`, its `discovery` → `reviewer` (×7) → `synthesis` → `report` steps run sequentially instead of in parallel — same engine, same inputs, just slower on repos with many enabled reviewers. See `docs/en/why-reusable-workflow.md` for why the reusable workflow above remains the primary path. Distribution here is packaging only, same as the skill: `action.yml` calls the same `.github/actions/<x>@v2` sub-actions the reusable workflow uses.

---

## 2. Reviewer Team

Seven built-in reviewers (6 enabled, 1 disabled by default):

| Reviewer | Scope | Primary concerns | Default |
|---|---|---|---|
| `docs_staleness` | READMEs, documentation, comments, **multilingual README/doc variants** | Stale content, drift from code, broken links, **multilingual versions out of sync with base** | on |
| `code_hygiene` | Source code | Dead code, unused files/functions, divergence from spec, obvious code smells | on |
| `spec_flow` | Specs, flowcharts, state machines | Flow inconsistent with implementation, outdated spec | on |
| `visual_icon` | Images, icons, design assets | Unused assets, duplicate images, size/naming convention violations | on |
| `duplicate_orphan` | Entire repo | Duplicate files, orphaned files, unreferenced assets | on |
| `convention` | Entire repo | Violations of the repo's own skills/workflows/CLAUDE.md conventions | on |
| `i18n` | Localization strings, `.lproj`, etc. | Missing translations, unused keys, out of sync with base | **off** |

Dynamic custom reviewers are not supported (§11). The built-in `i18n` reviewer, off by default, covers the common need.

### Rubric Three-Layer Composition (priority order, lowest to highest)

```
Built-in default rubric (shipped with the action; defines what this specialty looks for)
   ⊕ repo-convention auto-discovery (the domain-relevant parts of
                         CLAUDE.md / .claude/skills / .claude/workflows)
   ⊕ audit.yml explicit override (the repo file pointed to by reviewers.<name>.rubric) ← highest priority
```

When a repo has its own standards, those take priority. `convention` relies almost entirely on the repo's own conventions; `visual_icon` relies mainly on built-in defaults plus the repo's design guidelines (if any exist).

**Reviewer rubric language (`rubric_lang`)**: the built-in rubrics ship per locale under `reviewers/<locale>/`. Two sets exist: `en` and `zh-TW`. The `rubric_lang` workflow input (default `en`) selects the set that the reviewers and synthesis use. Any other value makes every reviewer and the synthesis step fail, because no prompt file exists for it.

### 2.1 Multilingual Doc-Set Sync Detection

Handled by `docs_staleness` (not `i18n` — `i18n` manages code-layer localization strings such as `.lproj`/`Localizable.strings`; documentation translation drift is a doc concern).

- **Directory convention**: Multilingual docs live at `docs/<locale>/<name>.md` (e.g., `docs/zh-TW/overview.md`). The sole exception is the repo root `README.md` = **English base** (GitHub convention), with per-language translations at `docs/<locale>/README.md`.
- **Base language**: `en` (root `README.md` and `docs/en/*` are authoritative).
- **Supported languages (up to 6)**: `en` (base), `zh-TW`, `zh-CN`, `ja`, `ko` (sixth slot reserved).
- **Detection**: Using the base (`docs/en/<name>.md`, or root `README.md` for the README) as the reference, report "behind / missing / stale" for each `docs/<locale>/<name>.md`. Follows the §3 principle — evidence-backed (git recency: base was modified but a translation was not), does not assume "the translation is always the one that needs updating," though when the base is newer it typically indicates a lagging translation.
- **Grouping**: The reviewer groups files by same filename across `docs/<locale>/` subdirectories (for README, the root `README.md` and all `docs/<locale>/README.md` files are treated as one group).
- **Dogfooding**: This repo's own user-facing documentation suite (README, overview, design, why-reusable-workflow) is fully multilingualized under `docs/<locale>/`, serving as a real-world test sample for this capability (see §10).

---

## 3. SSOT Handling Principle (No Presumed Ground Truth)

The problem: spec and code are not always the SSOT — sometimes **the spec itself is the outdated party**. Hardcoding a fixed direction produces false positives.

Principle: **reviewers do not presume a SSOT; they detect "divergence" and defer direction to evidence and tiered judgment.**

1. **Detect divergence, don't conclude**: report "A says X, B says Y, they are inconsistent" — not "B is stale."
2. **Attach evidence signals**: last-modified timestamp / commit recency, reference count, direction of references.
3. **Tiered judgment**:
   - Strong evidence (e.g., a file untouched for six months while related code was heavily changed last week) → set `ssot_direction` to `stale_a` or `stale_b` (§4) and state the direction in the suggestion ("README appears older; updating it is recommended"). A human still confirms.
   - Weak evidence → set `ssot_direction` to `uncertain`; the suggestion says the direction needs human judgment.
   - **Never auto-apply fixes under any circumstances** (auto-fix is out of scope, §11).
4. **SSOT is not declared via a config file**: direction is always inferred, avoiding the risk of the declaration file itself becoming stale. A repo with a firm policy can state it in an override rubric (`reviewers.<name>.rubric`, §5); this is optional and discouraged.

---

## 4. findings Schema

Each reviewer writes one file, `findings/<reviewer>.json`, with one record per problem:

```json
{
  "reviewer": "docs_staleness",
  "status": "ok",
  "findings": [
    {
      "file": "path/to/file",
      "related": ["path/to/other-file"],
      "reviewer": "docs_staleness",
      "category": "staleness",
      "problem": "...",
      "evidence": "...",
      "suggestion": "...",
      "severity": "medium",
      "confidence": "high",
      "ssot_direction": "stale_a"
    }
  ]
}
```

- `status`: `ok` or `failed`. A failed reviewer writes `status: "failed"` with `findings: []`; the other reviewers are unaffected.
- `file`: the primary file. A cross-file problem goes on the primary file, and `related` lists the others.
- `related`: the other files involved; may be empty. The file on the other side of a comparison comes first. This order is meaningful only in `findings/<reviewer>.json`: Consolidate merges and sorts `related`, so the consolidated report does not preserve it.
- `category`: one of `staleness`, `duplicate`, `orphan`, `convention`, `inconsistency`, `i18n_sync`, `other`.
- `problem`: human-readable description of the problem.
- `evidence`: supporting evidence (git timestamps, reference relationships, the specific mismatch).
- `suggestion`: suggested fix; may name a direction under tiered judgment (§3).
- `severity`, `confidence`: each one of `low`, `medium`, `high`.
- `ssot_direction`: one of four values.
  - `stale_a`: `file` is the outdated side.
  - `stale_b`: the first entry of `related` is the outdated side.
  - `uncertain`: the two sides disagree and the evidence does not show which is outdated.
  - `n/a`: the problem has no two sides to compare.

The criteria for choosing a `category`, `severity` and `confidence` value are defined in one place, the reviewer prompt (`reviewers/<locale>/_reviewer-prompt.md`). `src/findings.ts` validates every file against the allowed values; a file that fails validation is replaced by a `failed` result.

**Consolidate deduplication/sorting (deterministic)**: merges cross-reviewer duplicates using `file` + `category` as the key — for the same key, the "representative finding" is the one with the highest severity × confidence (ties broken by reviewer enumeration order as a stable tiebreak); `reviewers[]` is the union of all reporters for that key, and `related[]` is the union of all related files. Sort key = severity desc → confidence desc → file asc.

### 4.1 Synthesis Output

The Synthesis step reads all `findings/*.json` + inventory and outputs `synthesis.json`. **References findings by file path (not integer index — more stable for LLMs and human-readable)**:

```json
{
  "themes": [
    {
      "title": "...",
      "narrative": "...",
      "related_files": ["path/a", "path/b"],
      "priority": "high"
    }
  ],
  "semantic_duplicates": [["reviewer|file|category", "reviewer|file|category"]],
  "executive_summary": "...",
  "status": "ok"
}
```

- `themes`: systemic themes that span reviewers. `title` states the systemic issue in brief; `narrative` says why the findings share one root cause; `related_files` lists the file paths the theme covers; `priority` is `low`, `medium` or `high`.
- `semantic_duplicates`: groups of finding keys, each key in the form `reviewer|file|category`, that describe the same problem. Consolidate merges each group into one finding.
- `executive_summary`: one paragraph on overall health.
- `status`: `ok` or `failed`. A failed synthesis writes `themes: []`.

The Report uses both raw findings and synthesis output; if synthesis fails or is absent, it degrades gracefully to presenting only raw findings (no themes or executive summary).

---

## 5. Configuration File `.claude/audit.yml` (fully optional — the action runs correctly without it)

`scan` and `ssot` **are not config options** (they would become stale); both are auto-inferred instead.

```yaml
# .claude/audit.yml
version: 1
ignore:
  - "docs/*/plans/**"
reviewers:
  visual_icon: { enabled: false }
  i18n:        { enabled: true }
  docs_staleness:
    paths: ["README.md", "docs/**"]
    rubric: "docs/audit-rubric.md"
report:
  min_severity: "low"
```

Every key is optional:

- `version`: config schema version; currently `1`.
- `ignore`: glob paths. Matching files are dropped from the inventory, so no reviewer sees them. Default: none.
- `reviewers.<name>.enabled`: turns a reviewer on or off. Default: on for every reviewer except `i18n`. Reviewers that are not listed keep their defaults; unknown names are ignored.
- `reviewers.<name>.paths`: glob paths. When set, the reviewer's target files are the inventory files that match, instead of its default selection by file type (the Scope column in §2).
- `reviewers.<name>.rubric`: repo-relative path of a rubric file. The reviewer reads it as the highest-priority rubric layer (§2).
- `report.min_severity`: `low`, `medium` or `high`. Findings below it stay out of the tracking issue; the HTML report keeps every finding. Default: `low`. The camelCase spelling `minSeverity` is also accepted.

Glob syntax: `*` matches within one path segment, `**` matches across segments, `?` matches one character.

The issue label is not a config key. Set it with the `issue_label` workflow input (default `audit`).

### Auto-Inference (no configuration required)

- **Scan scope**: every file that `git ls-files --cached --others --exclude-standard` lists (tracked and untracked files, `.gitignore` respected), minus the `ignore` globs. Lockfiles get the file category `other`, so only the whole-repo reviewers (`duplicate_orphan`, `convention`) receive them. Text files over 100 KB are flagged, not skipped (§7).
- **SSOT direction**: fully evidence-driven (§3), no declaration file.

---

## 6. Repo Location (finalized)

Upkeep is referenced via `uses:`, so it lives in its own repo, `wei18/upkeep` (`uses: wei18/upkeep@v2`).

Structure:

```
upkeep/
├── action.yml                        # composite action (Marketplace listing): `uses: wei18/upkeep@v2`, sequential reviewer steps
├── .github/
│   ├── workflows/audit.yml          # reusable workflow (on: workflow_call): jobs/matrix orchestration
│   └── actions/                     # composite sub-actions (used by the workflow's jobs; carry Upkeep's own code)
│       ├── discovery/  reviewer/  synthesis/  report/
├── .claude-plugin/marketplace.json  # plugin marketplace catalog (plugin name: upkeep, source: ./skills/upkeep-audit)
├── README.md                        # English base usage (job-level uses: example, secret/permissions) + language switcher
├── docs/
│   ├── en/      overview.md  design.md  why-reusable-workflow.md   (no README: the root README.md is the en base)
│   ├── zh-TW/   README.md  overview.md  design.md  why-reusable-workflow.md
│   ├── zh-CN/ … ja/ … ko/   (same set as zh-TW)
│   ├── archive/plans/               # original implementation plans: historical record, not localized
│   └── superpowers/                 # design-process specs and plans: historical record, not localized
├── reviewers/<locale>/              # 7 built-in rubrics + _reviewer-prompt + _synthesis-prompt, per locale (en, zh-TW); picked by rubric_lang
├── skills/upkeep-audit/             # Claude Code skill: thin local-run wrapper (clones to ~/.cache/upkeep)
│   └── .claude-plugin/plugin.json   # plugin manifest (single-skill layout; SKILL.md at plugin root)
├── scripts/local-audit.sh           # local pipeline orchestrator (same flow as CI; temp-dir intermediates)
├── src/                             # deterministic TS: discovery/consolidate/report/matrix/prompt-bundle, etc.
└── test/                            # unit + contract tests (§10)
```

> Archive note: `docs/archive/plans/` and `docs/superpowers/` are historical records of how Upkeep was built. They are not localized, are not linked from any navigation index, and are not current rules — this spec is. `.claude/audit.yml` excludes both `plans/` directories from the self-audit.

> Sub-action mechanism: jobs in a reusable workflow run on the **caller's** checkout; Upkeep's own code (`src/`, `reviewers/`) is brought in via `uses: wei18/upkeep/.github/actions/<x>@v2` (GitHub fetches the Upkeep repo automatically). Each reviewer is an independent matrix job running a plain `claude-code-action` prompt (writing `findings/<reviewer>.json`), so **no in-run subagent spawning is required**, eliminating any `--agents`/`Agent` passthrough risk.

---

## 7. Modality Routing

Discovery assigns every file one `modality`. The 100 KB limit applies only to files that a reviewer reads as text; it never applies to images.

| `modality` | Assigned to | How reviewers handle it |
|---|---|---|
| `raster_image` | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.tiff`, `.heic`, `.ico`, `.icns` | No byte limit. Judged from metadata; opened as an image only for the one case below |
| `vector_diagram` | `.svg`, `.mmd`, `.dot`, `.puml`, `.plantuml` | Read as **raw source text** (semantically diffable). Over 100 KB, the inventory sets `oversizedText: true` |
| `binary` | Any other file with a NUL byte in its first 8000 bytes | Judged from metadata only (`hash`, `sizeBytes`, `referencedBy`) |
| `text` | Every remaining file | Read as text. Over 100 KB, the inventory sets `oversizedText: true` |

`oversizedText` is a flag in the inventory and nothing more: no file is truncated, chunked, summarized or dropped because of its size. The reviewer prompt tells reviewers to read a flagged file in parts.

Most visual reviewer work does not require "seeing" the image:
- Duplicate images → file hash (exact match)
- Orphaned images → reference graph
- Naming/size conventions → metadata
- **Only "does the image content match the design/spec?" requires opening the image**; the rubric limits this to a few suspicious assets

---

## 8. Resilience / Degradation

| Failure scenario | Handling |
|---|---|
| A reviewer crashes, times out, or writes invalid output | That reviewer's result becomes `status:"failed"`, `findings:[]` (matrix `fail-fast: false`); the other reviewers continue normally; the report and the issue name the failed reviewers in an incomplete-run warning |
| Synthesis step fails | Degrades: Report presents only raw findings (no cross-domain themes/narrative); the overall run does not fail |
| All reviewers fail | The run still completes: the report and the issue are produced with no findings, and the incomplete-run warning names every reviewer |
| Discovery scans 0 files | Completes normally, not treated as an error |

Principle: failures within the Review/Synthesis stage are always isolated and degraded gracefully; only failures in the deterministic skeleton (Discovery/Consolidate/Report) cause the entire run to fail.

---

## 9. Cost Controls

- Reviewers receive the inventory (metadata) and a list of target files, not file contents. The prompt tells them to shortlist by metadata and deep-read only the suspicious files
- `max_turns` (default 30) caps every reviewer call and the synthesis call
- Files excluded by `.gitignore` or by `ignore` never enter the inventory (§5)
- HTML / issue assembly is pure string processing — **zero LLM cost**

---

## 10. Test Strategy

Test sample: the real remote repo **https://github.com/wei18/Sudoku** (used instead of an in-repo fixture).

- **Deterministic layer → unit tests (TDD)**: Discovery classification, Consolidate deduplication and sorting, HTML/issue assembly — no LLM involved.
- **LLM layer → contract tests**: verify that subagent output **conforms to the findings schema** (all fields present, `severity`/`confidence`/`ssot_direction` within valid value sets); do not assert on content verbatim.
  - CI: uses **recorded fake responses** for schema contract tests (cost-free and stable).
  - Live API calls: manual only / pre-release smoke tests.
- **End-to-end smoke (manual, not part of CI)**: run the full workflow against the Sudoku repo and check that the HTML artifact and the issue exist, the findings conform to the schema, and a reasonable number of problems is detected (no verbatim assertions).
- **Dogfood**: `.github/workflows/self-audit.yml` runs the audit on this repo every week.

---

## 11. Scope Boundaries (out of scope)

- Auto-fix PRs (automatically updating READMEs or deleting orphaned files) — not planned; Upkeep is output-only
- Dynamic custom reviewers — the reviewer set is fixed; `reviewers.<name>.paths` and `reviewers.<name>.rubric` (§5) adjust the built-in ones
- PR incremental mode — every run is a full scan
- SSOT declaration file — direction is inferred from evidence
