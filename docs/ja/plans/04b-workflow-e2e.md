# Plan 4b — Reusable workflow + composite 子 action + e2e Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan 1〜4a の確定性レイヤーを、実際に動作する GitHub Action として接続します。`on: workflow_call` による reusable workflow が jobs + matrix で discovery → review(matrix) → synthesis → report を編成し、各 LLM ステップには公式の `claude-code-action` を使用します。最終的に tracking issue を upsert して HTML artifact をアップロードし、`wei18/Sudoku` に対してライブ e2e を実行します。

**Architecture:** reusable workflow が jobs を編成します。upkeep 自身のコードは composite 子 action（`uses: wei18/upkeep/.github/actions/<x>`）経由で取り込みます（`github.action_path` による定位、`npm ci` + `node --import tsx`）。**確定性 finalize** レイヤー（LLM 出力の検証、欠損・不正時は `status:"failed"` にフォールバック）を追加し、下流が常に仕様準拠の JSON を読み取れることを保証します。このレイヤーは CI-safe かつ TDD で実装します。YAML は structure-parse テストで構造を守り、正確性は手動 e2e で確認します。

**Tech Stack:** TypeScript/Node 20（既存踏襲、`yaml` 依存を structure テストに使用）；GitHub Actions（reusable workflow + composite actions）；`claude-code-action`；`gh` CLI。

対応 spec：`../design.md` §1（matrix + sub-action 編成）、§8（失敗隔離/降格）、§4/§4.1（findings/synthesis コントラクト）、§10（e2e サンプル wei18/Sudoku）。

### 前提条件（検証済み ✓）
- `claude-code-action` は `prompt` による自律実行、`claude_args` への `--allowedTools/--max-turns/--model` 直接渡し、workspace ファイルの読み書きをサポートしています（Plan 4 前に公式ドキュメントを確認済み）。
- composite action の step では他の action（サードパーティ含む）を `uses:` で使用できます。step に `if: always()` を指定できます。
- reusable workflow の job では `strategy.matrix`、`continue-on-error`、`needs`、`permissions`、artifacts、`gh` を使用できます。
- **未ライブ検証項目（本 plan Task 6 e2e で初回確認）**：upload/download-artifact v4 の単一ファイルパス構造、matrix job 内で claude-code-action が prompt に従って仕様準拠の `findings/<r>.json` を出力するか、`github.action_path/../../..` による upkeep root の定位が正しいか。

### バージョン ref に関する注意
`uses:` の ref では `${{ }}` による変数展開は使えないため、workflow 内の各子 action の ref はリテラルで記述する必要があります。本 plan では一律 `@v1` と記載します。**dev/e2e 期間中**はブランチ名に変更してください（Task 6 参照）。release 時は workflow と子 action を同一タグに合わせてください。

---

## File Structure

```
src/
  finalize.ts     # [新] finalizeReviewerOutput / finalizeSynthesis（検証+フォールバック failed）+ CLI
  find-issue.ts   # [新] CLI：gh issue list JSON を読んで ISSUE_MARKER 付き issue number を出力（なければ空）
.github/
  actions/
    discovery/action.yml   # [新] scan → inventory.json artifact + reviewers matrix 出力
    reviewer/action.yml    # [新] 1 人の reviewer：prompt-bundle → claude-code-action → finalize → findings-<r> アップロード
    synthesis/action.yml   # [新] 全 findings を読み込み → claude-code-action → finalize → synthesis アップロード
    report/action.yml      # [新] consolidate+render → report.html アップロード + gh issue upsert
  workflows/
    audit.yml              # [新] on: workflow_call；jobs: discovery→review(matrix)→synthesis→report
test/
  finalize.test.ts         # [新]
  workflow-structure.test.ts # [新] YAML をパースして構造をアサート（CI-safe）
README.md                  # [改] job-level uses の使い方
docs/e2e.md                # [新] wei18/Sudoku に対する手動 e2e 手順
```

---

### Task 0: 確定性 finalize レイヤー `src/finalize.ts` + `src/find-issue.ts`

**Files:**
- Create: `src/finalize.ts`, `src/find-issue.ts`, `test/finalize.test.ts`

`finalizeReviewerOutput(raw, reviewer)`：raw が仕様準拠かつ reviewer が一致する場合はそのまま返します。それ以外は `{reviewer, status:"failed", findings:[]}` にフォールバックします。`finalizeSynthesis(raw)`：仕様準拠の場合はそのまま返します。それ以外は `{themes:[],semantic_duplicates:[],executive_summary:"",status:"failed"}` にフォールバックします。CLI はファイルを in-place で読み込み → finalize → 書き戻します（ファイルが存在しない場合は null として扱います）。`find-issue.ts` は upsert 用の薄い CLI です。

- [ ] **Step 1: 失敗テストを書く**

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

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run test/finalize.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装を書く**

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

- [ ] **Step 4: テストを実行して通過を確認する**

Run: `npx vitest run test/finalize.test.ts`
Expected: PASS（6 tests）。

- [ ] **Step 5: `src/find-issue.ts` を書く**

```ts
// src/find-issue.ts
import { readFileSync } from 'node:fs';
import { findMarkedIssue } from './issue.js';
import { ISSUE_MARKER } from './report-issue.js';
import type { IssueRef } from './issue.js';

// CLI: find-issue.ts <issuesJsonFile>
// ファイル内容は `gh issue list --json number,body` の JSON 配列；marker 付きの number を出力（なければ空文字列を出力）
if (import.meta.url === `file://${process.argv[1]}`) {
  const issues = JSON.parse(readFileSync(process.argv[2], 'utf8')) as IssueRef[];
  const n = findMarkedIssue(issues, ISSUE_MARKER);
  process.stdout.write(n === null ? '' : String(n));
}
```

> `IssueRef` は `src/issue.ts` から export する必要があります（Plan 4a で `interface IssueRef` を export 済み）。

- [ ] **Step 6: 全スイート + 型チェック**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全 PASS、型エラーなし。

- [ ] **Step 7: Commit**

```bash
git add src/finalize.ts src/find-issue.ts test/finalize.test.ts
git commit -m "feat: finalize layer (validate+fallback) and find-issue CLI for upsert"
```

---

### Task 1: discovery + reviewer 子 action

**Files:**
- Create: `.github/actions/discovery/action.yml`, `.github/actions/reviewer/action.yml`

- [ ] **Step 1: `.github/actions/discovery/action.yml` を作成する**

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

- [ ] **Step 2: `.github/actions/reviewer/action.yml` を作成する**

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

> 失敗隔離：`claude-code-action` に `continue-on-error: true` を設定します。`finalize` と `upload` には `if: always()` を設定するため、LLM ステップが失敗しても `status:"failed"` の仕様準拠 findings を書き出してアップロードします。workflow の review job には別途 `fail-fast: false` を設定します（Task 3 参照）。

- [ ] **Step 3: Commit**

```bash
git add .github/actions/discovery/action.yml .github/actions/reviewer/action.yml
git commit -m "feat: discovery and reviewer composite sub-actions"
```

---

### Task 2: synthesis + report 子 action

**Files:**
- Create: `.github/actions/synthesis/action.yml`, `.github/actions/report/action.yml`

- [ ] **Step 1: `.github/actions/synthesis/action.yml` を作成する**

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

> 上記 synthesis action の `build synthesis prompt` ステップは `src/synthesis-prompt-cli.ts` を呼び出します（次のステップで作成します）。両者を同一 commit でコミットします。

- [ ] **Step 2: 薄い CLI `src/synthesis-prompt-cli.ts` を追加する**（synthesis prompt の生成を安定させ、上記 YAML から呼び出せるようにするため）

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

- [ ] **Step 3: `.github/actions/report/action.yml` を作成する**

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

### Task 3: reusable workflow `.github/workflows/audit.yml` + structure テスト

**Files:**
- Create: `.github/workflows/audit.yml`, `test/workflow-structure.test.ts`

- [ ] **Step 1: structure テストを書く（先に失敗させる）**

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

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run test/workflow-structure.test.ts`
Expected: FAIL（ファイルが存在しないため）。

- [ ] **Step 3: `.github/workflows/audit.yml` を作成する**

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

- [ ] **Step 4: テストを実行して通過を確認する**

Run: `npx vitest run test/workflow-structure.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/audit.yml test/workflow-structure.test.ts
git commit -m "feat: reusable audit workflow orchestrating discovery/review/synthesis/report"
```

---

### Task 4: README 用法 + caller サンプル

**Files:**
- Modify: `README.md`

- [ ] **Step 1: `README.md` を修正する**——「状態：設計段階」のセクションを、実際に使用できる job-level の用法に差し替えます

README 内の現在の「予定される使用法（実装後）」のセクション全体を以下の内容に置き換えてください：

````markdown
## 用法

あなたの repo に `.github/workflows/audit.yml` を作成してください：

```yaml
name: repo audit
on:
  schedule:
    - cron: '0 3 * * 1'   # 毎週月曜 03:00 UTC に全スキャン
  workflow_dispatch:       # 手動トリガーも可能

jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@v1
    with:
      model: claude-opus-4-8     # 省略可能
      issue_label: audit         # 省略可能；デフォルト audit
    secrets:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

要件：
- repo secret `CLAUDE_CODE_OAUTH_TOKEN`。
- デフォルトの権限には `contents: read` + `issues: write` が含まれています（workflow に組み込み済み）。

出力：
- `audit` ラベル付きの tracking issue（実行のたびに同一 issue を upsert します）。
- self-contained な HTML レポート。該当 workflow run の artifacts（`report-html`）に保存されます。

任意の設定ファイル `.claude/audit.yml`（全項目省略可）については `../design.md` §5 を参照してください。
````

- [ ] **Step 2: README に「未実装」の記述が残っていないことを確認する**

Run: `grep -n "尚未實作\|設計階段" README.md || echo "OK: no stale status"`
Expected: `OK: no stale status`。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document job-level reusable-workflow usage"
```

---

### Task 5: 全スイート回帰 + 型チェック

**Files:** （新規なし；全体の green を確認）

- [ ] **Step 1: 全スイート + 型チェック + workflow 構造**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全 PASS（finalize/workflow-structure 含む）、型エラーなし。

- [ ] **Step 2: ローカルのスモークテスト——report CLI が仮の findings から出力を生成できることを確認する**

Run（一時ディレクトリに仕様準拠の findings + synthesis を配置して `node --import tsx src/report.ts` を実行し、`report.html`/`issue.md` が生成されて期待する文字列を含むことを確認）：
```bash
d=$(mktemp -d); mkdir -p "$d/findings"
printf '%s' '{"reviewer":"docs_staleness","status":"ok","findings":[{"file":"README.md","related":[],"reviewer":"docs_staleness","category":"staleness","problem":"p","evidence":"e","suggestion":"s","severity":"high","confidence":"high","ssot_direction":"stale_a"}]}' > "$d/findings/docs_staleness.json"
printf '%s' '{"themes":[],"semantic_duplicates":[],"executive_summary":"sum","status":"ok"}' > "$d/synthesis.json"
node --import tsx src/report.ts "$d/findings" "$d/synthesis.json" "$d/report.html" "$d/issue.md"
grep -q "upkeep:report" "$d/issue.md" && head -c 20 "$d/report.html"
```
Expected: `report: 1 findings ...` と出力され、`issue.md` に marker が含まれ、`report.html` が `<!doctype html>` で始まること。

- [ ] **Step 3: Commit（修正が発生した場合）**；修正がなければスキップ。

---

### Task 6: ライブ e2e（`wei18/Sudoku` 対象、手動）

**Files:**
- Create: `docs/e2e.md`

> このステップは**実際の GitHub + CLAUDE_CODE_OAUTH_TOKEN** が必要であり、CI 単体テストでは完結しません。手順を文書化し、人間が一度実行します。dev 期間中は `uses:` の ref にブランチ名を使用します（`@v1` ではなく）。

- [ ] **Step 1: `docs/e2e.md` を作成する**

````markdown
# e2e 手順（wei18/Sudoku 対象）

前提条件：upkeep が `wei18/upkeep`（ブランチまたはタグ）に push 済みであること；`wei18/Sudoku` に repo secret `CLAUDE_CODE_OAUTH_TOKEN` が設定済みであること。

## 1. 子 action / workflow の ref を一時的に dev ブランチに向ける
upkeep のローカルで：`.github/workflows/audit.yml` 内の 4 つの `@v1` を `@<dev-branch>` に変更して、そのブランチを push します。
（release 時には `@v1` に戻して tag を打ちます。）

## 2. Sudoku にトリガー用 workflow を追加する
`wei18/Sudoku` に `.github/workflows/audit.yml` を作成します：
```yaml
on: { workflow_dispatch: {} }
jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@<dev-branch>
    secrets:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```
push 後、Actions ページで `Run workflow` を実行します。

## 3. 受け入れチェックポイント
- [ ] `discovery` job が green：artifacts に `inventory` が存在し、`reviewers` 出力が 6 件（i18n はデフォルト無効）。
- [ ] `review` matrix が 6 job を実行（`fail-fast:false`）し、各自が `findings-<reviewer>` をアップロードする。
- [ ] **artifact パス**：各 `findings-<reviewer>` 内に `<reviewer>.json` が存在する（単一ファイル upload の構造前提を検証；実際に `findings/` プレフィックスが付く場合は report の download path または upload の working-directory を調整）。
- [ ] 各 findings が `validateReviewerOutput` を通過する（finalize が保証済み；LLM の実際の出力フォーマットを 1 件抜き取り確認）。
- [ ] `synthesis` job は一部の reviewer が失敗しても実行される（`if: always()`）；`synthesis` を出力する。
- [ ] `report` job が `report-html` artifact を生成し、Sudoku に `audit` ラベル付きの issue が開かれる；**もう一度実行**して、新しい issue が開かれるのではなく**同一 issue が edit**（upsert、`ISSUE_MARKER` による）されることを確認する。
- [ ] HTML をダウンロードしてオフラインで開けること、severity フィルターが動作すること、外部リソースがないこと。

## 4. 観察と調整
- トークンコスト：各 reviewer job の使用量を確認します。必要に応じて `max_turns` や reviewer の範囲を調整します。
- claude-code-action が findings を書き出さない場合：prompt が `reviewer-prompt.txt` を正常に読み込めているか、`--allowedTools` に `Write` が含まれているかを確認します。

## 5. 結果の記録
初回 e2e の run URL と発見した調整事項をこのファイルの末尾に記録し、release 前の根拠とします。
````

- [ ] **Step 2: Commit**

```bash
git add docs/e2e.md
git commit -m "docs: live e2e procedure against wei18/Sudoku"
```

- [ ] **Step 3: （人手）`docs/e2e.md` に従ってライブ e2e を一度実行する**。受け入れチェックポイントを一つずつチェックし、run URL と調整事項を記録します。このステップは人手で行うものであり、CI ではありません。

---

## 完了定義（Plan 4b）

- `npx vitest run` が全て green（finalize、workflow-structure 含む）；`npx tsc --noEmit` がクリーン。
- 4 つの composite 子 action + 1 つの reusable workflow が配置され、structure テストが通過している。
- README に直接コピーできる job-level 用法が記載されており、「未実装」の記述が残っていない。
- `docs/e2e.md` の手順が整備されており、**初回ライブ e2e を人手で実行してチェックポイントにチェックが入った**後、upkeep v1 をリリースできます（tag を打ち、ref を dev ブランチから `@v1` に戻します）。

## 次のステップへの引き継ぎ

これで Plan 1〜4 が全て完了します → release（v1 tag を打つ）に進みます。[[project-obsidian-filing]] に従い、全 IMPL_APPROVED 後に spec/plans を Obsidian vault にアーカイブします。多言語ドキュメント（en/zh-TW/zh-CN/ja/ko）はこの時点で Content Creator/PR チームが起案します（README の内容は確定済み）。
