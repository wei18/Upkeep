# Plan 4b — Reusable workflow + composite sub-action + e2e Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the deterministic layers from Plans 1-4a into a fully runnable GitHub Action: a reusable workflow (`on: workflow_call`) that uses jobs + matrix to orchestrate discovery → review(matrix) → synthesis → report, with each LLM step driven by the official `claude-code-action`, and finally upserts a tracking issue and uploads an HTML artifact; run a live e2e against `wei18/Sudoku`.

**Architecture:** The reusable workflow orchestrates jobs; upkeep's own code is brought in through composite sub-actions (`uses: wei18/upkeep/.github/actions/<x>`) using `github.action_path` for location and `npm ci` + `node --import tsx`. A **deterministic finalize** layer (validates LLM output; falls back to `status:"failed"` on missing or invalid output) is added to guarantee downstream always reads compliant JSON — this layer is CI-safe and TDD. YAML structure is guarded by structure-parse tests; correctness is confirmed by manual e2e.

**Tech Stack:** TypeScript/Node 20 (carried over, including the `yaml` dependency for structure tests); GitHub Actions (reusable workflow + composite actions); `claude-code-action`; `gh` CLI.

Corresponding spec: `../design.md` §1 (matrix + sub-action orchestration), §8 (failure isolation/degradation), §4/§4.1 (findings/synthesis contract), §10 (e2e sample wei18/Sudoku).

### Prerequisites (verified ✓)
- `claude-code-action` supports autonomous `prompt` execution, passing `--allowedTools/--max-turns/--model` directly via `claude_args`, and can read/write workspace files (verified against official docs before Plan 4).
- Composite actions can `uses:` other actions (including third-party) in a step; steps can use `if: always()`.
- Reusable workflow jobs support `strategy.matrix`, `continue-on-error`, `needs`, `permissions`, artifacts, and `gh`.
- **Items not yet live-verified (to be confirmed for the first time in Task 6 e2e):** single-file path structure of upload/download-artifact v4; whether claude-code-action writes a compliant `findings/<r>.json` per prompt inside a matrix job; whether `github.action_path/../../..` correctly locates the upkeep root.

### Version ref note
`uses:` refs cannot be interpolated with `${{ }}`; therefore the ref for each sub-action inside the workflow must be a literal string. This plan uses `@v1` throughout; **during dev/e2e** switch to the branch name (see Task 6). On release, ensure the workflow and sub-actions share the same tag.

---

## File Structure

```
src/
  finalize.ts     # [new] finalizeReviewerOutput / finalizeSynthesis (validate + fallback to failed) + CLI
  find-issue.ts   # [new] CLI: reads gh issue list JSON → prints issue number with ISSUE_MARKER (or empty)
.github/
  actions/
    discovery/action.yml   # [new] scan → inventory.json artifact + reviewers matrix output
    reviewer/action.yml    # [new] one reviewer: prompt-bundle → claude-code-action → finalize → upload findings-<r>
    synthesis/action.yml   # [new] reads all findings → claude-code-action → finalize → upload synthesis
    report/action.yml      # [new] consolidate+render → upload report.html + gh issue upsert
  workflows/
    audit.yml              # [new] on: workflow_call; jobs: discovery→review(matrix)→synthesis→report
test/
  finalize.test.ts         # [new]
  workflow-structure.test.ts # [new] parses YAML and asserts structure (CI-safe)
README.md                  # [modified] job-level uses usage
docs/e2e.md                # [new] manual e2e procedure against wei18/Sudoku
```

---

### Task 0: Deterministic finalize layer `src/finalize.ts` + `src/find-issue.ts`

**Files:**
- Create: `src/finalize.ts`, `src/find-issue.ts`, `test/finalize.test.ts`

`finalizeReviewerOutput(raw, reviewer)`: if raw is compliant and reviewer matches → pass through as-is; otherwise fall back to `{reviewer, status:"failed", findings:[]}`. `finalizeSynthesis(raw)`: if compliant → pass through as-is; otherwise `{themes:[],semantic_duplicates:[],executive_summary:"",status:"failed"}`. The CLI reads a file in place → finalizes → writes back (treats a missing file as null). `find-issue.ts` is a thin CLI for upsert.

- [ ] **Step 1: Write failing tests**

```ts
// test/finalize.test.ts
import { describe, it, expect } from 'vitest';
import { finalizeReviewerOutput, finalizeSynthesis } from '../src/finalize.js';

const goodReviewer = {
  reviewer: 'docs_staleness', status: 'ok',
  findings: [{ file: 'README.md', related: [], reviewer: 'docs_staleness', category: 'staleness',
    problem: 'p', evidence: 'e', suggestion: 's', severity: 'low', confidence: 'low', ssot_direction: 'n/a' }],
};

describe('finalizeReviewerOutput', () => {
  it('passes a valid matching output through', () => {
    expect(finalizeReviewerOutput(goodReviewer, 'docs_staleness')).toEqual(goodReviewer);
  });
  it('falls back to failed when raw is null', () => {
    expect(finalizeReviewerOutput(null, 'i18n')).toEqual({ reviewer: 'i18n', status: 'failed', findings: [] });
  });
  it('falls back when raw is invalid', () => {
    expect(finalizeReviewerOutput({ reviewer: 'docs_staleness', status: 'nope', findings: [] }, 'docs_staleness').status).toBe('failed');
  });
  it('falls back when reviewer name mismatches', () => {
    expect(finalizeReviewerOutput(goodReviewer, 'convention')).toEqual({ reviewer: 'convention', status: 'failed', findings: [] });
  });
});

describe('finalizeSynthesis', () => {
  const goodSyn = { themes: [], semantic_duplicates: [], executive_summary: 'ok', status: 'ok' };
  it('passes a valid synthesis through', () => {
    expect(finalizeSynthesis(goodSyn)).toEqual(goodSyn);
  });
  it('falls back to failed when invalid/null', () => {
    expect(finalizeSynthesis(null)).toEqual({ themes: [], semantic_duplicates: [], executive_summary: '', status: 'failed' });
    expect(finalizeSynthesis({ themes: 'x' }).status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `npx vitest run test/finalize.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

```ts
// src/finalize.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { validateReviewerOutput } from './findings.js';
import { validateSynthesisOutput } from './synthesis.js';
import type { ReviewerOutput, SynthesisOutput, ReviewerName } from './types.js';

export function finalizeReviewerOutput(raw: unknown, reviewer: ReviewerName): ReviewerOutput {
  if (validateReviewerOutput(raw).valid && (raw as ReviewerOutput).reviewer === reviewer) {
    return raw as ReviewerOutput;
  }
  return { reviewer, status: 'failed', findings: [] };
}

export function finalizeSynthesis(raw: unknown): SynthesisOutput {
  if (validateSynthesisOutput(raw).valid) return raw as SynthesisOutput;
  return { themes: [], semantic_duplicates: [], executive_summary: '', status: 'failed' };
}

function readJsonOrNull(path: string): unknown {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// CLI: finalize.ts reviewer <reviewer> <file>   |   finalize.ts synthesis <file>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [kind, a, b] = process.argv.slice(2);
  if (kind === 'reviewer') {
    writeFileSync(b, JSON.stringify(finalizeReviewerOutput(readJsonOrNull(b), a as ReviewerName), null, 2));
  } else if (kind === 'synthesis') {
    writeFileSync(a, JSON.stringify(finalizeSynthesis(readJsonOrNull(a)), null, 2));
  } else {
    process.stderr.write('Usage: finalize.ts reviewer <reviewer> <file> | synthesis <file>\n');
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npx vitest run test/finalize.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write `src/find-issue.ts`**

```ts
// src/find-issue.ts
import { readFileSync } from 'node:fs';
import { findMarkedIssue } from './issue.js';
import { ISSUE_MARKER } from './report-issue.js';
import type { IssueRef } from './issue.js';

// CLI: find-issue.ts <issuesJsonFile>
// 檔內容為 `gh issue list --json number,body` 的 JSON 陣列；印出帶 marker 的 number（無則印空字串）
if (import.meta.url === `file://${process.argv[1]}`) {
  const issues = JSON.parse(readFileSync(process.argv[2], 'utf8')) as IssueRef[];
  const n = findMarkedIssue(issues, ISSUE_MARKER);
  process.stdout.write(n === null ? '' : String(n));
}
```

> `IssueRef` must be exported from `src/issue.ts` (Plan 4a already exports `interface IssueRef`).

- [ ] **Step 6: Full suite + types**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/finalize.ts src/find-issue.ts test/finalize.test.ts
git commit -m "feat: finalize layer (validate+fallback) and find-issue CLI for upsert"
```

---

### Task 1: discovery + reviewer sub-actions

**Files:**
- Create: `.github/actions/discovery/action.yml`, `.github/actions/reviewer/action.yml`

- [ ] **Step 1: Create `.github/actions/discovery/action.yml`**

```yaml
name: upkeep discovery
description: Scan the target repo into inventory.json and emit the enabled-reviewer matrix list.
inputs:
  target:
    description: Path to the repo to audit
    default: '.'
outputs:
  reviewers:
    description: JSON array of enabled reviewer names
    value: ${{ steps.scan.outputs.reviewers }}
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
    - name: install upkeep deps
      shell: bash
      working-directory: ${{ github.action_path }}/../../..
      run: npm ci
    - id: scan
      shell: bash
      run: |
        set -euo pipefail
        ROOT="${{ github.action_path }}/../../.."
        node --import tsx "$ROOT/src/discovery.ts" "${{ inputs.target }}" "${{ runner.temp }}/inventory.json"
        node --import tsx "$ROOT/src/matrix.ts" "${{ inputs.target }}" "$GITHUB_OUTPUT"
    - uses: actions/upload-artifact@v4
      with:
        name: inventory
        path: ${{ runner.temp }}/inventory.json
```

- [ ] **Step 2: Create `.github/actions/reviewer/action.yml`**

```yaml
name: upkeep reviewer
description: Run one reviewer via claude-code-action, producing findings/<reviewer>.json (with failed fallback).
inputs:
  reviewer:
    description: Reviewer name
    required: true
  target:
    description: Path to the repo being audited
    default: '.'
  model:
    default: claude-opus-4-8
  max_turns:
    default: '15'
  claude_code_oauth_token:
    required: true
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
    - name: install upkeep deps
      shell: bash
      working-directory: ${{ github.action_path }}/../../..
      run: npm ci
    - uses: actions/download-artifact@v4
      with:
        name: inventory
        path: ${{ runner.temp }}
    - name: build reviewer prompt
      shell: bash
      run: |
        set -euo pipefail
        ROOT="${{ github.action_path }}/../../.."
        mkdir -p "${{ inputs.target }}/findings"
        node --import tsx "$ROOT/src/prompt-bundle.ts" \
          "${{ inputs.reviewer }}" "${{ runner.temp }}/inventory.json" "${{ runner.temp }}/reviewer-prompt.txt"
    - uses: anthropics/claude-code-action@v1
      continue-on-error: true
      with:
        prompt: |
          Read the file ${{ runner.temp }}/reviewer-prompt.txt and follow its instructions exactly.
          Produce findings/${{ inputs.reviewer }}.json in the repository root, conforming to the JSON contract in that prompt.
        claude_args: --allowedTools Read,Write,Glob,Grep --max-turns ${{ inputs.max_turns }} --model ${{ inputs.model }}
        claude_code_oauth_token: ${{ inputs.claude_code_oauth_token }}
    - name: finalize findings (fallback to failed if missing/invalid)
      if: always()
      shell: bash
      run: |
        set -euo pipefail
        ROOT="${{ github.action_path }}/../../.."
        node --import tsx "$ROOT/src/finalize.ts" reviewer "${{ inputs.reviewer }}" "${{ inputs.target }}/findings/${{ inputs.reviewer }}.json"
    - name: upload findings
      if: always()
      uses: actions/upload-artifact@v4
      with:
        name: findings-${{ inputs.reviewer }}
        path: ${{ inputs.target }}/findings/${{ inputs.reviewer }}.json
```

> Failure isolation: `claude-code-action` is set to `continue-on-error: true`; `finalize` and `upload` are set to `if: always()`, so even if the LLM step fails, a compliant findings file with `status:"failed"` is still written and uploaded. The review job in the workflow also sets `fail-fast: false` (see Task 3).

- [ ] **Step 3: Commit**

```bash
git add .github/actions/discovery/action.yml .github/actions/reviewer/action.yml
git commit -m "feat: discovery and reviewer composite sub-actions"
```

---

### Task 2: synthesis + report sub-actions

**Files:**
- Create: `.github/actions/synthesis/action.yml`, `.github/actions/report/action.yml`

- [ ] **Step 1: Create `.github/actions/synthesis/action.yml`**

```yaml
name: upkeep synthesis
description: Read all findings + inventory, produce synthesis.json (with failed fallback).
inputs:
  target:
    default: '.'
  model:
    default: claude-opus-4-8
  max_turns:
    default: '15'
  claude_code_oauth_token:
    required: true
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
    - name: install upkeep deps
      shell: bash
      working-directory: ${{ github.action_path }}/../../..
      run: npm ci
    - uses: actions/download-artifact@v4
      with:
        name: inventory
        path: ${{ inputs.target }}
    - uses: actions/download-artifact@v4
      with:
        pattern: findings-*
        path: ${{ inputs.target }}/findings
        merge-multiple: true
    - name: build synthesis prompt
      shell: bash
      run: |
        set -euo pipefail
        ROOT="${{ github.action_path }}/../../.."
        node --import tsx "$ROOT/src/synthesis-prompt-cli.ts" "${{ runner.temp }}/synthesis-prompt.txt"
    - uses: anthropics/claude-code-action@v1
      continue-on-error: true
      with:
        prompt: |
          Read ${{ runner.temp }}/synthesis-prompt.txt, then read inventory.json and all files under findings/.
          Produce synthesis.json in the repository root per the contract in that prompt.
        claude_args: --allowedTools Read,Write,Glob,Grep --max-turns ${{ inputs.max_turns }} --model ${{ inputs.model }}
        claude_code_oauth_token: ${{ inputs.claude_code_oauth_token }}
    - name: finalize synthesis
      if: always()
      shell: bash
      run: |
        set -euo pipefail
        ROOT="${{ github.action_path }}/../../.."
        node --import tsx "$ROOT/src/finalize.ts" synthesis "${{ inputs.target }}/synthesis.json"
    - name: upload synthesis
      if: always()
      uses: actions/upload-artifact@v4
      with:
        name: synthesis
        path: ${{ inputs.target }}/synthesis.json
```

> The `build synthesis prompt` step in the synthesis action above calls `src/synthesis-prompt-cli.ts` (created in the next step). Both are committed together.

- [ ] **Step 2: Add thin CLI `src/synthesis-prompt-cli.ts`** (makes synthesis prompt generation reliable and callable from the YAML above)

```ts
// src/synthesis-prompt-cli.ts
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSynthesisPrompt } from './prompt-bundle.js';

// CLI: synthesis-prompt-cli.ts <outFile>
if (import.meta.url === `file://${process.argv[1]}`) {
  const actionRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
  writeFileSync(process.argv[2], buildSynthesisPrompt(actionRoot));
}
```

- [ ] **Step 3: Create `.github/actions/report/action.yml`**

```yaml
name: upkeep report
description: Consolidate findings + synthesis into HTML (artifact) and upsert a tracking issue.
inputs:
  target:
    default: '.'
  issue_label:
    default: audit
  github_token:
    required: true
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
    - name: install upkeep deps
      shell: bash
      working-directory: ${{ github.action_path }}/../../..
      run: npm ci
    - uses: actions/download-artifact@v4
      with:
        pattern: findings-*
        path: ${{ inputs.target }}/findings
        merge-multiple: true
    - uses: actions/download-artifact@v4
      with:
        name: synthesis
        path: ${{ inputs.target }}
      continue-on-error: true
    - name: render report
      shell: bash
      run: |
        set -euo pipefail
        ROOT="${{ github.action_path }}/../../.."
        SYN="${{ inputs.target }}/synthesis.json"
        [ -f "$SYN" ] || SYN="-"
        node --import tsx "$ROOT/src/report.ts" \
          "${{ inputs.target }}/findings" "$SYN" \
          "${{ runner.temp }}/report.html" "${{ runner.temp }}/issue.md"
    - uses: actions/upload-artifact@v4
      with:
        name: report-html
        path: ${{ runner.temp }}/report.html
    - name: upsert tracking issue
      shell: bash
      env:
        GH_TOKEN: ${{ inputs.github_token }}
      run: |
        set -euo pipefail
        ROOT="${{ github.action_path }}/../../.."
        gh issue list --state open --label "${{ inputs.issue_label }}" --json number,body > "${{ runner.temp }}/issues.json" || echo '[]' > "${{ runner.temp }}/issues.json"
        NUM="$(node --import tsx "$ROOT/src/find-issue.ts" "${{ runner.temp }}/issues.json")"
        if [ -n "$NUM" ]; then
          gh issue edit "$NUM" --body-file "${{ runner.temp }}/issue.md"
        else
          gh issue create --title "🔍 Upkeep Report" --label "${{ inputs.issue_label }}" --body-file "${{ runner.temp }}/issue.md"
        fi
```

- [ ] **Step 4: Commit**

```bash
git add .github/actions/synthesis/action.yml .github/actions/report/action.yml src/synthesis-prompt-cli.ts
git commit -m "feat: synthesis and report composite sub-actions"
```

---

### Task 3: Reusable workflow `.github/workflows/audit.yml` + structure tests

**Files:**
- Create: `.github/workflows/audit.yml`, `test/workflow-structure.test.ts`

- [ ] **Step 1: Write structure tests (fail first)**

```ts
// test/workflow-structure.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const wf = parse(readFileSync(join(ROOT, '.github/workflows/audit.yml'), 'utf8'));

describe('audit reusable workflow structure', () => {
  it('is a reusable workflow requiring the anthropic secret', () => {
    expect(wf.on.workflow_call).toBeDefined();
    expect(wf.on.workflow_call.secrets.claude_code_oauth_token.required).toBe(true);
  });
  it('declares issues:write + contents:read permissions', () => {
    expect(wf.permissions.contents).toBe('read');
    expect(wf.permissions.issues).toBe('write');
  });
  it('wires discovery -> review(matrix) -> synthesis -> report', () => {
    expect(Object.keys(wf.jobs).sort()).toEqual(['discovery', 'report', 'review', 'synthesis']);
    expect(wf.jobs.review.needs).toContain('discovery');
    expect(wf.jobs.review.strategy['fail-fast']).toBe(false);
    expect(wf.jobs.review.strategy.matrix.reviewer).toContain('fromJSON');
    expect(wf.jobs.synthesis.needs).toContain('review');
    expect(wf.jobs.report.needs).toContain('synthesis');
    expect(String(wf.jobs.report.if)).toContain('always');
    expect(String(wf.jobs.synthesis.if)).toContain('always');
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `npx vitest run test/workflow-structure.test.ts`
Expected: FAIL (file does not exist).

- [ ] **Step 3: Create `.github/workflows/audit.yml`**

```yaml
name: upkeep audit
on:
  workflow_call:
    inputs:
      model:
        type: string
        default: claude-opus-4-8
      max_turns:
        type: string
        default: '15'
      issue_label:
        type: string
        default: audit
    secrets:
      claude_code_oauth_token:
        required: true

permissions:
  contents: read
  issues: write

jobs:
  discovery:
    runs-on: ubuntu-latest
    outputs:
      reviewers: ${{ steps.d.outputs.reviewers }}
    steps:
      - uses: actions/checkout@v4
      - id: d
        uses: wei18/upkeep/.github/actions/discovery@v1

  review:
    needs: discovery
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        reviewer: ${{ fromJSON(needs.discovery.outputs.reviewers) }}
    steps:
      - uses: actions/checkout@v4
      - uses: wei18/upkeep/.github/actions/reviewer@v1
        with:
          reviewer: ${{ matrix.reviewer }}
          model: ${{ inputs.model }}
          max_turns: ${{ inputs.max_turns }}
          claude_code_oauth_token: ${{ secrets.claude_code_oauth_token }}

  synthesis:
    needs: review
    if: ${{ always() }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: wei18/upkeep/.github/actions/synthesis@v1
        with:
          model: ${{ inputs.model }}
          max_turns: ${{ inputs.max_turns }}
          claude_code_oauth_token: ${{ secrets.claude_code_oauth_token }}

  report:
    needs: synthesis
    if: ${{ always() }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: wei18/upkeep/.github/actions/report@v1
        with:
          issue_label: ${{ inputs.issue_label }}
          github_token: ${{ github.token }}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npx vitest run test/workflow-structure.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/audit.yml test/workflow-structure.test.ts
git commit -m "feat: reusable audit workflow orchestrating discovery/review/synthesis/report"
```

---

### Task 4: README usage + example caller

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update `README.md`** — replace the "Status: design phase" section with working job-level usage

Replace the current "Expected usage (post-implementation)" section in the README with:

````markdown
## Usage

Create `.github/workflows/audit.yml` in your repo:

```yaml
name: repo audit
on:
  schedule:
    - cron: '0 3 * * 1'   # 每週一 03:00 UTC 全掃
  workflow_dispatch:       # 也可手動觸發

jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@v1
    with:
      model: claude-opus-4-8     # 可選
      issue_label: audit         # 可選；預設 audit
    secrets:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Requirements:
- Repo secret `CLAUDE_CODE_OAUTH_TOKEN`.
- Default permissions already include `contents: read` + `issues: write` (provided by the workflow itself).

Outputs:
- A tracking issue labelled `audit` (upserted to the same issue on every run).
- A self-contained HTML report stored as a workflow run artifact (`report-html`).

Optional config file `.claude/audit.yml` (all fields optional) — see `../design.md` §5.
````

- [ ] **Step 2: Confirm README no longer claims "not yet implemented"**

Run: `grep -n "尚未實作\|設計階段" README.md || echo "OK: no stale status"`
Expected: `OK: no stale status`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document job-level reusable-workflow usage"
```

---

### Task 5: Full suite regression + types

**Files:** (no new files; confirm everything is green)

- [ ] **Step 1: Full suite + types + workflow structure**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS (including finalize/workflow-structure), no type errors.

- [ ] **Step 2: Local smoke test — report CLI still produces output from fake findings**

Run (create a temp directory with one compliant findings file + synthesis, run `node --import tsx src/report.ts`, confirm `report.html`/`issue.md` are generated and contain expected strings):
```bash
d=$(mktemp -d); mkdir -p "$d/findings"
printf '%s' '{"reviewer":"docs_staleness","status":"ok","findings":[{"file":"README.md","related":[],"reviewer":"docs_staleness","category":"staleness","problem":"p","evidence":"e","suggestion":"s","severity":"high","confidence":"high","ssot_direction":"stale_a"}]}' > "$d/findings/docs_staleness.json"
printf '%s' '{"themes":[],"semantic_duplicates":[],"executive_summary":"sum","status":"ok"}' > "$d/synthesis.json"
node --import tsx src/report.ts "$d/findings" "$d/synthesis.json" "$d/report.html" "$d/issue.md"
grep -q "upkeep:report" "$d/issue.md" && head -c 20 "$d/report.html"
```
Expected: prints `report: 1 findings ...`, `issue.md` contains the marker, and `report.html` starts with `<!doctype html>`.

- [ ] **Step 3: Commit (if any fixes were made)**; skip if nothing changed.

---

### Task 6: Live e2e (against `wei18/Sudoku`, manual)

**Files:**
- Create: `docs/e2e.md`

> This step **requires real GitHub + CLAUDE_CODE_OAUTH_TOKEN** and cannot be completed in CI unit tests; the procedure is documented here for a human to execute once. During dev the `uses:` ref uses a branch name (not `@v1`).

- [ ] **Step 1: Create `docs/e2e.md`**

````markdown
# e2e 程序（對 wei18/Sudoku）

前置：upkeep 已 push 到 `wei18/upkeep`（分支或 tag）；`wei18/Sudoku` 有 repo secret `CLAUDE_CODE_OAUTH_TOKEN`。

## 1. 暫時把子 action / workflow 的 ref 指向 dev 分支
本機在 upkeep：把 `.github/workflows/audit.yml` 內四個 `@v1` 暫改為 `@<dev-branch>`，push 該分支。
（release 時改回 `@v1` 並打 tag。）

## 2. 在 Sudoku 加一個觸發 workflow
於 `wei18/Sudoku` 建 `.github/workflows/audit.yml`：
```yaml
on: { workflow_dispatch: {} }
jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@<dev-branch>
    secrets:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```
push 後在 Actions 頁 `Run workflow`。

## 3. 驗收檢查點
- [ ] `discovery` job 綠：artifacts 有 `inventory`；其 `reviewers` 輸出為 6 個（i18n 預設關）。
- [ ] `review` matrix 跑出 6 個 job（`fail-fast:false`）；各自上傳 `findings-<reviewer>`。
- [ ] **artifact 路徑**：每個 `findings-<reviewer>` 內含 `<reviewer>.json`（驗證單檔 upload 的結構假設；若實際多了 `findings/` 前綴，調整 report 的 download path 或 upload 的 working-directory）。
- [ ] 每份 findings 通過 `validateReviewerOutput`（finalize 已保證；抽查一份 LLM 真實輸出格式正確）。
- [ ] `synthesis` job 即使某 reviewer 失敗仍跑（`if: always()`）；產出 `synthesis`。
- [ ] `report` job 產出 `report-html` artifact，且在 Sudoku 開出一個帶 `audit` 標籤的 issue；**再跑一次**確認是 **edit 同一個 issue**（upsert，靠 `ISSUE_MARKER`）而非開新 issue。
- [ ] HTML 下載可離線開、severity 篩選可用、無外部資源。

## 4. 觀察與調參
- token 成本：看各 reviewer job 用量；必要時調 `max_turns` 或 reviewer 範圍。
- 若 claude-code-action 沒寫出 findings：檢查 prompt 是否成功讀到 `reviewer-prompt.txt`、`--allowedTools` 是否含 `Write`。

## 5. 記錄結果
把首次 e2e 的 run URL、發現的調整項記在本檔末，作為 release 前依據。
````

- [ ] **Step 2: Commit**

```bash
git add docs/e2e.md
git commit -m "docs: live e2e procedure against wei18/Sudoku"
```

- [ ] **Step 3: (Manual) Run the live e2e once following `docs/e2e.md`**, check off each acceptance checkpoint, and record the run URL and any adjustments. This step is performed by a human, not CI.

---

## Definition of Done (Plan 4b)

- `npx vitest run` is fully green (including finalize and workflow-structure); `npx tsc --noEmit` is clean.
- 4 composite sub-actions + 1 reusable workflow are in place and pass structure tests.
- README provides copy-pasteable job-level usage and no longer claims "not yet implemented".
- `docs/e2e.md` procedure is ready; **once the first live e2e has been run by a human and all checkpoints are checked off**, upkeep v1 is ready to release (tag, switch refs from dev branch back to `@v1`).

## Handoff

Plans 1-4 are now complete → proceed to release (tag v1). Per [[project-obsidian-filing]], archive all specs/plans to the Obsidian vault after IMPL_APPROVED. Multi-language docs (en/zh-TW/zh-CN/ja/ko) are to be initiated by the Content Creator / PR team at this point (README content is finalized).
