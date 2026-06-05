# Plan 4b — Reusable workflow + composite 子 action + e2e Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Plan 1-4a 的確定性層接成真正可跑的 GitHub Action：一個 reusable workflow（`on: workflow_call`）以 jobs+matrix 編排 discovery → review(matrix) → synthesis → report，每個 LLM 步驟用官方 `claude-code-action`，最後 upsert 一個 tracking issue 並上傳 HTML artifact；對 `wei18/Sudoku` 跑直播 e2e。

**Architecture:** reusable workflow 編排 jobs；upkeep 自身程式碼透過 composite 子 action（`uses: wei18/upkeep/.github/actions/<x>`）帶入（`github.action_path` 定位、`npm ci` + `node --import tsx`）。新增一層**確定性 finalize**（驗證 LLM 輸出、缺/壞時退回 `status:"failed"`）保證下游永遠讀到合規 JSON——這層 CI-safe、TDD。YAML 由 structure-parse 測試守結構，正確性由手動 e2e 確認。

**Tech Stack:** TypeScript/Node 20（沿用，含 `yaml` 依賴用於 structure 測試）；GitHub Actions（reusable workflow + composite actions）；`claude-code-action`；`gh` CLI。

對應 spec：`docs/design.md` §1（matrix + sub-action 編排）、§8（失敗隔離/降級）、§4/§4.1（findings/synthesis 契約）、§10（e2e 樣本 wei18/Sudoku）。

### 前置（已驗證 ✓）
- `claude-code-action` 支援 `prompt` 自主執行、`claude_args` 直傳 `--allowedTools/--max-turns/--model`、可讀寫 workspace 檔（Plan 4 前已查官方文件）。
- composite action 可在 step `uses:` 其他 action（含第三方）；step 可用 `if: always()`。
- reusable workflow 的 job 可用 `strategy.matrix`、`continue-on-error`、`needs`、`permissions`、artifacts、`gh`。
- **未 live 驗證項（由本 plan Task 6 e2e 首次確認）**：upload/download-artifact v4 的單檔路徑結構、claude-code-action 在 matrix job 內依 prompt 寫出合規 `findings/<r>.json`、`github.action_path/../../..` 定位 upkeep root 正確。

### 版本 ref 注意
`uses:` 的 ref 不能用 `${{ }}` 插值，故 workflow 內各子 action 的 ref 必須是字面量。本 plan 一律寫 `@v1`；**dev/e2e 期間**改用分支名（見 Task 6）。release 時確保 workflow 與子 action 同 tag。

---

## File Structure

```
src/
  finalize.ts     # [新] finalizeReviewerOutput / finalizeSynthesis（驗證+退回 failed）+ CLI
  find-issue.ts   # [新] CLI：讀 gh issue list JSON → 印出帶 ISSUE_MARKER 的 issue number（或空）
.github/
  actions/
    discovery/action.yml   # [新] scan → inventory.json artifact + reviewers matrix 輸出
    reviewer/action.yml    # [新] 一位 reviewer：prompt-bundle → claude-code-action → finalize → 上傳 findings-<r>
    synthesis/action.yml   # [新] 讀全部 findings → claude-code-action → finalize → 上傳 synthesis
    report/action.yml      # [新] consolidate+render → 上傳 report.html + gh issue upsert
  workflows/
    audit.yml              # [新] on: workflow_call；jobs: discovery→review(matrix)→synthesis→report
test/
  finalize.test.ts         # [新]
  workflow-structure.test.ts # [新] 解析 YAML 斷言結構（CI-safe）
README.md                  # [改] job-level uses 用法
docs/e2e.md                # [新] 對 wei18/Sudoku 的手動 e2e 程序
```

---

### Task 0: 確定性 finalize 層 `src/finalize.ts` + `src/find-issue.ts`

**Files:**
- Create: `src/finalize.ts`, `src/find-issue.ts`, `test/finalize.test.ts`

`finalizeReviewerOutput(raw, reviewer)`：raw 合規且 reviewer 相符 → 原樣；否則退回 `{reviewer, status:"failed", findings:[]}`。`finalizeSynthesis(raw)`：合規 → 原樣；否則 `{themes:[],semantic_duplicates:[],executive_summary:"",status:"failed"}`。CLI 就地讀檔→finalize→寫回（檔不存在當 null）。`find-issue.ts` 是 upsert 用的薄 CLI。

- [ ] **Step 1: 寫失敗測試**

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

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/finalize.test.ts`
Expected: FAIL。

- [ ] **Step 3: 寫實作**

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

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/finalize.test.ts`
Expected: PASS（6 tests）。

- [ ] **Step 5: 寫 `src/find-issue.ts`**

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

> `IssueRef` 需從 `src/issue.ts` export（Plan 4a 已 export interface IssueRef）。

- [ ] **Step 6: 全套件 + 型別**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全 PASS、無型別錯誤。

- [ ] **Step 7: Commit**

```bash
git add src/finalize.ts src/find-issue.ts test/finalize.test.ts
git commit -m "feat: finalize layer (validate+fallback) and find-issue CLI for upsert"
```

---

### Task 1: discovery + reviewer 子 action

**Files:**
- Create: `.github/actions/discovery/action.yml`, `.github/actions/reviewer/action.yml`

- [ ] **Step 1: 建 `.github/actions/discovery/action.yml`**

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

- [ ] **Step 2: 建 `.github/actions/reviewer/action.yml`**

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

> 失敗隔離：`claude-code-action` 設 `continue-on-error: true`；`finalize`＋`upload` 設 `if: always()`，故即使 LLM step 失敗，仍會寫出 `status:"failed"` 的合規 findings 並上傳。workflow 的 review job 另設 `fail-fast: false`（見 Task 3）。

- [ ] **Step 3: Commit**

```bash
git add .github/actions/discovery/action.yml .github/actions/reviewer/action.yml
git commit -m "feat: discovery and reviewer composite sub-actions"
```

---

### Task 2: synthesis + report 子 action

**Files:**
- Create: `.github/actions/synthesis/action.yml`, `.github/actions/report/action.yml`

- [ ] **Step 1: 建 `.github/actions/synthesis/action.yml`**

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

> 上面 synthesis action 的 `build synthesis prompt` 步驟呼叫 `src/synthesis-prompt-cli.ts`（下一步建立）。兩者同次 commit。

- [ ] **Step 2: 新增薄 CLI `src/synthesis-prompt-cli.ts`**（讓 synthesis prompt 產出可靠、可被上面 YAML 呼叫）

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

- [ ] **Step 3: 建 `.github/actions/report/action.yml`**

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

### Task 3: reusable workflow `.github/workflows/audit.yml` + structure 測試

**Files:**
- Create: `.github/workflows/audit.yml`, `test/workflow-structure.test.ts`

- [ ] **Step 1: 寫 structure 測試（先失敗）**

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

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/workflow-structure.test.ts`
Expected: FAIL（檔不存在）。

- [ ] **Step 3: 建 `.github/workflows/audit.yml`**

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

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/workflow-structure.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/audit.yml test/workflow-structure.test.ts
git commit -m "feat: reusable audit workflow orchestrating discovery/review/synthesis/report"
```

---

### Task 4: README 用法 + 範例 caller

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 改 `README.md`**——把「狀態：設計階段」段落換成可用的 job-level 用法

把 README 中目前的「預期用法（實作後）」整段，替換為：

````markdown
## 用法

在你的 repo 建立 `.github/workflows/audit.yml`：

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

需求：
- repo secret `CLAUDE_CODE_OAUTH_TOKEN`。
- 預設權限已含 `contents: read` + `issues: write`（workflow 自帶）。

產出：
- 一個帶標籤 `audit` 的 tracking issue（每次 run upsert 同一個）。
- 一份 self-contained HTML 報告，存在該次 workflow run 的 artifacts（`report-html`）。

可選設定檔 `.claude/audit.yml`（全可選）見 `docs/design.md` §5。
````

- [ ] **Step 2: 確認 README 不再宣稱「尚未實作」**

Run: `grep -n "尚未實作\|設計階段" README.md || echo "OK: no stale status"`
Expected: `OK: no stale status`。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document job-level reusable-workflow usage"
```

---

### Task 5: 全套件回歸 + 型別

**Files:** （無新增；確認整體綠）

- [ ] **Step 1: 全套件 + 型別 + workflow 結構**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全 PASS（含 finalize/workflow-structure）、無型別錯誤。

- [ ] **Step 2: 本機冒煙——report CLI 仍可從假 findings 產出**

Run（用一個臨時目錄塞一份合規 findings + synthesis，跑 `node --import tsx src/report.ts`，確認 `report.html`/`issue.md` 產生且含預期字串）：
```bash
d=$(mktemp -d); mkdir -p "$d/findings"
printf '%s' '{"reviewer":"docs_staleness","status":"ok","findings":[{"file":"README.md","related":[],"reviewer":"docs_staleness","category":"staleness","problem":"p","evidence":"e","suggestion":"s","severity":"high","confidence":"high","ssot_direction":"stale_a"}]}' > "$d/findings/docs_staleness.json"
printf '%s' '{"themes":[],"semantic_duplicates":[],"executive_summary":"sum","status":"ok"}' > "$d/synthesis.json"
node --import tsx src/report.ts "$d/findings" "$d/synthesis.json" "$d/report.html" "$d/issue.md"
grep -q "upkeep:report" "$d/issue.md" && head -c 20 "$d/report.html"
```
Expected: 印出 `report: 1 findings ...` 且 `issue.md` 含 marker、`report.html` 以 `<!doctype html>` 開頭。

- [ ] **Step 3: Commit（若有任何修補）**；無修補則略過。

---

### Task 6: 直播 e2e（對 `wei18/Sudoku`，手動）

**Files:**
- Create: `docs/e2e.md`

> 這一步**需要真實 GitHub + CLAUDE_CODE_OAUTH_TOKEN**，無法在 CI 單元測完成；以文件記錄程序並由人執行一次。dev 期間 `uses:` 的 ref 用分支（非 `@v1`）。

- [ ] **Step 1: 建 `docs/e2e.md`**

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

- [ ] **Step 3: （人工）依 `docs/e2e.md` 跑一次直播 e2e**，把驗收檢查點逐項打勾、記錄 run URL 與調整項。此步由人執行，非 CI。

---

## 完成定義（Plan 4b）

- `npx vitest run` 全綠（含 finalize、workflow-structure）；`npx tsc --noEmit` 乾淨。
- 4 個 composite 子 action + 1 個 reusable workflow 就位，結構測試通過。
- README 提供可直接複製的 job-level 用法；不再宣稱「尚未實作」。
- `docs/e2e.md` 程序就緒；**首次直播 e2e 由人跑過、檢查點打勾**後，upkeep v1 可發佈（打 tag、把 ref 從 dev 分支改回 `@v1`）。

## 銜接

至此 Plan 1-4 全部完成 → 進入 release（打 v1 tag）。依 [[project-obsidian-filing]]，全部 IMPL_APPROVED 後把 spec/plans 歸檔 Obsidian vault。多語文檔（en/zh-TW/zh-CN/ja/ko）此時才由 Content Creator/公關團隊起案（README 內容已定）。
```
