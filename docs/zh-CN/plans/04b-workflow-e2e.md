# Plan 4b — Reusable workflow + composite 子 action + e2e Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Plan 1-4a 的确定性层接成真正可运行的 GitHub Action：一个 reusable workflow（`on: workflow_call`）以 jobs+matrix 编排 discovery → review(matrix) → synthesis → report，每个 LLM 步骤用官方 `claude-code-action`，最后 upsert 一个 tracking issue 并上传 HTML artifact；对 `wei18/Sudoku` 跑直播 e2e。

**Architecture:** reusable workflow 编排 jobs；upkeep 自身代码通过 composite 子 action（`uses: wei18/upkeep/.github/actions/<x>`）带入（`github.action_path` 定位、`npm ci` + `node --import tsx`）。新增一层**确定性 finalize**（验证 LLM 输出、缺/坏时退回 `status:"failed"`）保证下游永远读到合规 JSON——这层 CI-safe、TDD。YAML 由 structure-parse 测试守结构，正确性由手动 e2e 确认。

**Tech Stack:** TypeScript/Node 20（沿用，含 `yaml` 依赖用于 structure 测试）；GitHub Actions（reusable workflow + composite actions）；`claude-code-action`；`gh` CLI。

对应 spec：`../design.md` §1（matrix + sub-action 编排）、§8（失败隔离/降级）、§4/§4.1（findings/synthesis 契约）、§10（e2e 样本 wei18/Sudoku）。

### 前置（已验证 ✓）
- `claude-code-action` 支持 `prompt` 自主执行、`claude_args` 直传 `--allowedTools/--max-turns/--model`、可读写 workspace 文件（Plan 4 前已查官方文档）。
- composite action 可在 step `uses:` 其他 action（含第三方）；step 可用 `if: always()`。
- reusable workflow 的 job 可用 `strategy.matrix`、`continue-on-error`、`needs`、`permissions`、artifacts、`gh`。
- **未 live 验证项（由本 plan Task 6 e2e 首次确认）**：upload/download-artifact v4 的单文件路径结构、claude-code-action 在 matrix job 内依 prompt 写出合规 `findings/<r>.json`、`github.action_path/../../..` 定位 upkeep root 正确。

### 版本 ref 注意
`uses:` 的 ref 不能用 `${{ }}` 插值，故 workflow 内各子 action 的 ref 必须是字面量。本 plan 一律写 `@v1`；**dev/e2e 期间**改用分支名（见 Task 6）。release 时确保 workflow 与子 action 同 tag。

---

## File Structure

```
src/
  finalize.ts     # [新] finalizeReviewerOutput / finalizeSynthesis（验证+退回 failed）+ CLI
  find-issue.ts   # [新] CLI：读 gh issue list JSON → 印出带 ISSUE_MARKER 的 issue number（或空）
.github/
  actions/
    discovery/action.yml   # [新] scan → inventory.json artifact + reviewers matrix 输出
    reviewer/action.yml    # [新] 一位 reviewer：prompt-bundle → claude-code-action → finalize → 上传 findings-<r>
    synthesis/action.yml   # [新] 读全部 findings → claude-code-action → finalize → 上传 synthesis
    report/action.yml      # [新] consolidate+render → 上传 report.html + gh issue upsert
  workflows/
    audit.yml              # [新] on: workflow_call；jobs: discovery→review(matrix)→synthesis→report
test/
  finalize.test.ts         # [新]
  workflow-structure.test.ts # [新] 解析 YAML 断言结构（CI-safe）
README.md                  # [改] job-level uses 用法
docs/e2e.md                # [新] 对 wei18/Sudoku 的手动 e2e 程序
```

---

### Task 0: 确定性 finalize 层 `src/finalize.ts` + `src/find-issue.ts`

**Files:**
- Create: `src/finalize.ts`, `src/find-issue.ts`, `test/finalize.test.ts`

`finalizeReviewerOutput(raw, reviewer)`：raw 合规且 reviewer 相符 → 原样；否则退回 `{reviewer, status:"failed", findings:[]}`。`finalizeSynthesis(raw)`：合规 → 原样；否则 `{themes:[],semantic_duplicates:[],executive_summary:"",status:"failed"}`。CLI 就地读文件→finalize→写回（文件不存在当 null）。`find-issue.ts` 是 upsert 用的薄 CLI。

- [ ] **Step 1: 写失败测试**

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

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/finalize.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写实现**

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

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/finalize.test.ts`
Expected: PASS（6 tests）。

- [ ] **Step 5: 写 `src/find-issue.ts`**

```ts
// src/find-issue.ts
import { readFileSync } from 'node:fs';
import { findMarkedIssue } from './issue.js';
import { ISSUE_MARKER } from './report-issue.js';
import type { IssueRef } from './issue.js';

// CLI: find-issue.ts <issuesJsonFile>
// 文件内容为 `gh issue list --json number,body` 的 JSON 数组；印出带 marker 的 number（无则印空字符串）
if (import.meta.url === `file://${process.argv[1]}`) {
  const issues = JSON.parse(readFileSync(process.argv[2], 'utf8')) as IssueRef[];
  const n = findMarkedIssue(issues, ISSUE_MARKER);
  process.stdout.write(n === null ? '' : String(n));
}
```

> `IssueRef` 需从 `src/issue.ts` export（Plan 4a 已 export interface IssueRef）。

- [ ] **Step 6: 全套件 + 类型**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全 PASS、无类型错误。

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

> 失败隔离：`claude-code-action` 设 `continue-on-error: true`；`finalize`+`upload` 设 `if: always()`，故即使 LLM step 失败，仍会写出 `status:"failed"` 的合规 findings 并上传。workflow 的 review job 另设 `fail-fast: false`（见 Task 3）。

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

> 上面 synthesis action 的 `build synthesis prompt` 步骤调用 `src/synthesis-prompt-cli.ts`（下一步建立）。两者同次 commit。

- [ ] **Step 2: 新增薄 CLI `src/synthesis-prompt-cli.ts`**（让 synthesis prompt 产出可靠、可被上面 YAML 调用）

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

### Task 3: reusable workflow `.github/workflows/audit.yml` + structure 测试

**Files:**
- Create: `.github/workflows/audit.yml`, `test/workflow-structure.test.ts`

- [ ] **Step 1: 写 structure 测试（先失败）**

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

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/workflow-structure.test.ts`
Expected: FAIL（文件不存在）。

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

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/workflow-structure.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/audit.yml test/workflow-structure.test.ts
git commit -m "feat: reusable audit workflow orchestrating discovery/review/synthesis/report"
```

---

### Task 4: README 用法 + 示例 caller

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 改 `README.md`**——把「状态：设计阶段」段落换成可用的 job-level 用法

把 README 中目前的「预期用法（实现后）」整段，替换为：

````markdown
## 用法

在你的 repo 建立 `.github/workflows/audit.yml`：

```yaml
name: repo audit
on:
  schedule:
    - cron: '0 3 * * 1'   # 每周一 03:00 UTC 全扫
  workflow_dispatch:       # 也可手动触发

jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@v1
    with:
      model: claude-opus-4-8     # 可选
      issue_label: audit         # 可选；默认 audit
    secrets:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

需求：
- repo secret `CLAUDE_CODE_OAUTH_TOKEN`。
- 默认权限已含 `contents: read` + `issues: write`（workflow 自带）。

产出：
- 一个带标签 `audit` 的 tracking issue（每次 run upsert 同一个）。
- 一份 self-contained HTML 报告，存在该次 workflow run 的 artifacts（`report-html`）。

可选配置文件 `.claude/audit.yml`（全可选）见 `../design.md` §5。
````

- [ ] **Step 2: 确认 README 不再声称「尚未实现」**

Run: `grep -n "尚未实作\|設計階段" README.md || echo "OK: no stale status"`
Expected: `OK: no stale status`。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document job-level reusable-workflow usage"
```

---

### Task 5: 全套件回归 + 类型

**Files:** （无新增；确认整体绿）

- [ ] **Step 1: 全套件 + 类型 + workflow 结构**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全 PASS（含 finalize/workflow-structure）、无类型错误。

- [ ] **Step 2: 本机冒烟——report CLI 仍可从假 findings 产出**

Run（用一个临时目录塞一份合规 findings + synthesis，跑 `node --import tsx src/report.ts`，确认 `report.html`/`issue.md` 产生且含预期字符串）：
```bash
d=$(mktemp -d); mkdir -p "$d/findings"
printf '%s' '{"reviewer":"docs_staleness","status":"ok","findings":[{"file":"README.md","related":[],"reviewer":"docs_staleness","category":"staleness","problem":"p","evidence":"e","suggestion":"s","severity":"high","confidence":"high","ssot_direction":"stale_a"}]}' > "$d/findings/docs_staleness.json"
printf '%s' '{"themes":[],"semantic_duplicates":[],"executive_summary":"sum","status":"ok"}' > "$d/synthesis.json"
node --import tsx src/report.ts "$d/findings" "$d/synthesis.json" "$d/report.html" "$d/issue.md"
grep -q "upkeep:report" "$d/issue.md" && head -c 20 "$d/report.html"
```
Expected: 印出 `report: 1 findings ...` 且 `issue.md` 含 marker、`report.html` 以 `<!doctype html>` 开头。

- [ ] **Step 3: Commit（若有任何修补）**；无修补则略过。

---

### Task 6: 直播 e2e（对 `wei18/Sudoku`，手动）

**Files:**
- Create: `docs/e2e.md`

> 这一步**需要真实 GitHub + CLAUDE_CODE_OAUTH_TOKEN**，无法在 CI 单元测试完成；以文档记录程序并由人执行一次。dev 期间 `uses:` 的 ref 用分支（非 `@v1`）。

- [ ] **Step 1: 建 `docs/e2e.md`**

````markdown
# e2e 程序（对 wei18/Sudoku）

前置：upkeep 已 push 到 `wei18/upkeep`（分支或 tag）；`wei18/Sudoku` 有 repo secret `CLAUDE_CODE_OAUTH_TOKEN`。

## 1. 暂时把子 action / workflow 的 ref 指向 dev 分支
本机在 upkeep：把 `.github/workflows/audit.yml` 内四个 `@v1` 暂改为 `@<dev-branch>`，push 该分支。
（release 时改回 `@v1` 并打 tag。）

## 2. 在 Sudoku 加一个触发 workflow
于 `wei18/Sudoku` 建 `.github/workflows/audit.yml`：
```yaml
on: { workflow_dispatch: {} }
jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@<dev-branch>
    secrets:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```
push 后在 Actions 页 `Run workflow`。

## 3. 验收检查点
- [ ] `discovery` job 绿：artifacts 有 `inventory`；其 `reviewers` 输出为 6 个（i18n 默认关）。
- [ ] `review` matrix 跑出 6 个 job（`fail-fast:false`）；各自上传 `findings-<reviewer>`。
- [ ] **artifact 路径**：每个 `findings-<reviewer>` 内含 `<reviewer>.json`（验证单文件 upload 的结构假设；若实际多了 `findings/` 前缀，调整 report 的 download path 或 upload 的 working-directory）。
- [ ] 每份 findings 通过 `validateReviewerOutput`（finalize 已保证；抽查一份 LLM 真实输出格式正确）。
- [ ] `synthesis` job 即使某 reviewer 失败仍跑（`if: always()`）；产出 `synthesis`。
- [ ] `report` job 产出 `report-html` artifact，且在 Sudoku 开出一个带 `audit` 标签的 issue；**再跑一次**确认是 **edit 同一个 issue**（upsert，靠 `ISSUE_MARKER`）而非开新 issue。
- [ ] HTML 下载可离线开、severity 筛选可用、无外部资源。

## 4. 观察与调参
- token 成本：看各 reviewer job 用量；必要时调 `max_turns` 或 reviewer 范围。
- 若 claude-code-action 没写出 findings：检查 prompt 是否成功读到 `reviewer-prompt.txt`、`--allowedTools` 是否含 `Write`。

## 5. 记录结果
把首次 e2e 的 run URL、发现的调整项记在本文档末，作为 release 前依据。
````

- [ ] **Step 2: Commit**

```bash
git add docs/e2e.md
git commit -m "docs: live e2e procedure against wei18/Sudoku"
```

- [ ] **Step 3: （人工）依 `docs/e2e.md` 跑一次直播 e2e**，把验收检查点逐项打勾、记录 run URL 与调整项。此步由人执行，非 CI。

---

## 完成定义（Plan 4b）

- `npx vitest run` 全绿（含 finalize、workflow-structure）；`npx tsc --noEmit` 干净。
- 4 个 composite 子 action + 1 个 reusable workflow 就位，结构测试通过。
- README 提供可直接复制的 job-level 用法；不再声称「尚未实现」。
- `docs/e2e.md` 程序就绪；**首次直播 e2e 由人跑过、检查点打勾**后，upkeep v1 可发布（打 tag、把 ref 从 dev 分支改回 `@v1`）。

## 衔接

至此 Plan 1-4 全部完成 → 进入 release（打 v1 tag）。依 [[project-obsidian-filing]]，全部 IMPL_APPROVED 后把 spec/plans 归档 Obsidian vault。多语文档（en/zh-TW/zh-CN/ja/ko）此时才由 Content Creator/公关团队起案（README 内容已定）。
