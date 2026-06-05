# Plan 4b — Reusable workflow + composite 자식 action + e2e 구현 계획

> **agentic worker를 위한 안내:** 필수 서브 스킬: superpowers:subagent-driven-development(권장) 또는 superpowers:executing-plans를 사용하여 이 계획을 태스크 단위로 구현하십시오. 각 단계는 체크박스(`- [ ]`) 구문으로 진행 상황을 추적합니다.

**목표:** Plan 1–4a의 확정적 레이어를 실제로 실행 가능한 GitHub Action으로 연결합니다. 하나의 reusable workflow(`on: workflow_call`)가 jobs+matrix로 discovery → review(matrix) → synthesis → report를 편성하고, 각 LLM 단계는 공식 `claude-code-action`을 사용합니다. 최종적으로 tracking issue를 upsert하고 HTML artifact를 업로드하며, `wei18/Sudoku`를 대상으로 라이브 e2e를 실행합니다.

**아키텍처:** reusable workflow가 jobs를 편성하고, upkeep 자체 코드는 composite 자식 action(`uses: wei18/upkeep/.github/actions/<x>`)을 통해 불러옵니다(`github.action_path`로 위치 지정, `npm ci` + `node --import tsx`). **확정적 finalize** 레이어(LLM 출력 검증, 누락/손상 시 `status:"failed"`로 폴백)를 추가하여 다운스트림이 항상 규격에 맞는 JSON을 읽도록 보장합니다. 이 레이어는 CI-safe이며 TDD로 구현됩니다. YAML은 structure-parse 테스트가 구조를 감시하고, 정확성은 수동 e2e로 확인합니다.

**기술 스택:** TypeScript/Node 20(기존 유지, structure 테스트용 `yaml` 의존성 포함); GitHub Actions(reusable workflow + composite actions); `claude-code-action`; `gh` CLI.

관련 spec: `../design.md` §1(matrix + sub-action 편성), §8(장애 격리/강등), §4/§4.1(findings/synthesis 계약), §10(e2e 샘플 wei18/Sudoku).

### 전제 조건 (검증 완료 ✓)
- `claude-code-action`은 `prompt`를 통한 자율 실행, `claude_args`를 통한 `--allowedTools/--max-turns/--model` 직접 전달, workspace 파일 읽기/쓰기를 지원합니다(Plan 4 이전에 공식 문서 확인 완료).
- composite action의 step에서 다른 action(`uses:`)을 사용할 수 있습니다(서드파티 포함); step에 `if: always()`를 사용할 수 있습니다.
- reusable workflow의 job은 `strategy.matrix`, `continue-on-error`, `needs`, `permissions`, artifacts, `gh`를 사용할 수 있습니다.
- **라이브 미검증 항목(본 plan의 Task 6 e2e에서 최초 확인):** upload/download-artifact v4의 단일 파일 경로 구조, matrix job 내 claude-code-action이 prompt에 따라 규격에 맞는 `findings/<r>.json`을 생성하는지 여부, `github.action_path/../../..`로 upkeep 루트를 올바르게 찾는지 여부.

### 버전 ref 주의 사항
`uses:`의 ref에는 `${{ }}` 보간을 사용할 수 없으므로, workflow 내 각 자식 action의 ref는 리터럴 값이어야 합니다. 본 plan에서는 모두 `@v1`로 작성합니다. **dev/e2e 기간에는** 브랜치 이름으로 변경합니다(Task 6 참조). 릴리스 시 workflow와 자식 action이 동일한 태그를 사용하도록 확인하십시오.

---

## File Structure

```
src/
  finalize.ts     # [신규] finalizeReviewerOutput / finalizeSynthesis(검증+폴백) + CLI
  find-issue.ts   # [신규] CLI: gh issue list JSON 읽기 → ISSUE_MARKER가 포함된 issue number 출력(없으면 빈 문자열)
.github/
  actions/
    discovery/action.yml   # [신규] scan → inventory.json artifact + reviewers matrix 출력
    reviewer/action.yml    # [신규] 리뷰어 1명: prompt-bundle → claude-code-action → finalize → findings-<r> 업로드
    synthesis/action.yml   # [신규] 모든 findings 읽기 → claude-code-action → finalize → synthesis 업로드
    report/action.yml      # [신규] consolidate+render → report.html 업로드 + gh issue upsert
  workflows/
    audit.yml              # [신규] on: workflow_call; jobs: discovery→review(matrix)→synthesis→report
test/
  finalize.test.ts         # [신규]
  workflow-structure.test.ts # [신규] YAML 파싱으로 구조 단언(CI-safe)
README.md                  # [수정] job-level uses 사용법
docs/e2e.md                # [신규] wei18/Sudoku 대상 수동 e2e 절차
```

---

### Task 0: 확정적 finalize 레이어 `src/finalize.ts` + `src/find-issue.ts`

**Files:**
- Create: `src/finalize.ts`, `src/find-issue.ts`, `test/finalize.test.ts`

`finalizeReviewerOutput(raw, reviewer)`: raw가 규격에 맞고 reviewer가 일치하면 그대로 반환; 그렇지 않으면 `{reviewer, status:"failed", findings:[]}`로 폴백합니다. `finalizeSynthesis(raw)`: 규격에 맞으면 그대로 반환; 그렇지 않으면 `{themes:[],semantic_duplicates:[],executive_summary:"",status:"failed"}`를 반환합니다. CLI는 파일을 읽고 finalize한 후 덮어씁니다(파일이 없으면 null로 처리). `find-issue.ts`는 upsert용 얇은 CLI입니다.

- [ ] **Step 1: 실패 테스트 작성**

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

- [ ] **Step 2: 테스트 실행하여 실패 확인**

Run: `npx vitest run test/finalize.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현 작성**

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

- [ ] **Step 4: 테스트 실행하여 통과 확인**

Run: `npx vitest run test/finalize.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: `src/find-issue.ts` 작성**

```ts
// src/find-issue.ts
import { readFileSync } from 'node:fs';
import { findMarkedIssue } from './issue.js';
import { ISSUE_MARKER } from './report-issue.js';
import type { IssueRef } from './issue.js';

// CLI: find-issue.ts <issuesJsonFile>
// 파일 내용은 `gh issue list --json number,body`의 JSON 배열; marker가 포함된 number를 출력(없으면 빈 문자열 출력)
if (import.meta.url === `file://${process.argv[1]}`) {
  const issues = JSON.parse(readFileSync(process.argv[2], 'utf8')) as IssueRef[];
  const n = findMarkedIssue(issues, ISSUE_MARKER);
  process.stdout.write(n === null ? '' : String(n));
}
```

> `IssueRef`는 `src/issue.ts`에서 export되어야 합니다(Plan 4a에서 이미 `interface IssueRef`를 export함).

- [ ] **Step 6: 전체 스위트 + 타입 검사**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 전체 PASS, 타입 오류 없음.

- [ ] **Step 7: Commit**

```bash
git add src/finalize.ts src/find-issue.ts test/finalize.test.ts
git commit -m "feat: finalize layer (validate+fallback) and find-issue CLI for upsert"
```

---

### Task 1: discovery + reviewer 자식 action

**Files:**
- Create: `.github/actions/discovery/action.yml`, `.github/actions/reviewer/action.yml`

- [ ] **Step 1: `.github/actions/discovery/action.yml` 생성**

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

- [ ] **Step 2: `.github/actions/reviewer/action.yml` 생성**

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

> 장애 격리: `claude-code-action`에 `continue-on-error: true`를 설정하고, `finalize`와 `upload`에 `if: always()`를 설정합니다. 따라서 LLM 단계가 실패하더라도 `status:"failed"`인 규격 맞는 findings를 작성하여 업로드합니다. workflow의 review job에는 별도로 `fail-fast: false`를 설정합니다(Task 3 참조).

- [ ] **Step 3: Commit**

```bash
git add .github/actions/discovery/action.yml .github/actions/reviewer/action.yml
git commit -m "feat: discovery and reviewer composite sub-actions"
```

---

### Task 2: synthesis + report 자식 action

**Files:**
- Create: `.github/actions/synthesis/action.yml`, `.github/actions/report/action.yml`

- [ ] **Step 1: `.github/actions/synthesis/action.yml` 생성**

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

> 위 synthesis action의 `build synthesis prompt` 단계는 `src/synthesis-prompt-cli.ts`를 호출합니다(다음 단계에서 생성). 두 파일을 같은 commit으로 등록합니다.

- [ ] **Step 2: 얇은 CLI `src/synthesis-prompt-cli.ts` 추가** (synthesis prompt 출력을 안정적으로 만들고 위 YAML에서 호출할 수 있도록 함)

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

- [ ] **Step 3: `.github/actions/report/action.yml` 생성**

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

### Task 3: reusable workflow `.github/workflows/audit.yml` + structure 테스트

**Files:**
- Create: `.github/workflows/audit.yml`, `test/workflow-structure.test.ts`

- [ ] **Step 1: structure 테스트 작성 (먼저 실패 확인)**

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

- [ ] **Step 2: 테스트 실행하여 실패 확인**

Run: `npx vitest run test/workflow-structure.test.ts`
Expected: FAIL (파일이 존재하지 않음).

- [ ] **Step 3: `.github/workflows/audit.yml` 생성**

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

- [ ] **Step 4: 테스트 실행하여 통과 확인**

Run: `npx vitest run test/workflow-structure.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/audit.yml test/workflow-structure.test.ts
git commit -m "feat: reusable audit workflow orchestrating discovery/review/synthesis/report"
```

---

### Task 4: README 사용법 + 호출자 예시

**Files:**
- Modify: `README.md`

- [ ] **Step 1: `README.md` 수정** — "상태: 설계 단계" 단락을 사용 가능한 job-level 사용법으로 교체

README의 현재 "예상 사용법(구현 후)" 단락 전체를 아래 내용으로 교체하십시오.

````markdown
## 사용법

레포지토리에 `.github/workflows/audit.yml`을 생성합니다.

```yaml
name: repo audit
on:
  schedule:
    - cron: '0 3 * * 1'   # 매주 월요일 03:00 UTC 전체 스캔
  workflow_dispatch:       # 수동 트리거도 가능

jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@v1
    with:
      model: claude-opus-4-8     # 선택 사항
      issue_label: audit         # 선택 사항; 기본값 audit
    secrets:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

요구 사항:
- repo secret `CLAUDE_CODE_OAUTH_TOKEN`.
- 기본 권한에 `contents: read` + `issues: write`가 포함되어 있습니다(workflow에 내장).

출력:
- `audit` 라벨이 붙은 tracking issue 1개(매 실행마다 동일한 issue를 upsert).
- self-contained HTML 보고서. 해당 workflow run의 artifacts(`report-html`)에 저장됩니다.

선택적 설정 파일 `.claude/audit.yml`(모두 선택 사항)은 `../design.md` §5를 참조하십시오.
````

- [ ] **Step 2: README에 "미구현" 문구가 없는지 확인**

Run: `grep -n "尚未實作\|設計階段" README.md || echo "OK: no stale status"`
Expected: `OK: no stale status`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document job-level reusable-workflow usage"
```

---

### Task 5: 전체 스위트 회귀 테스트 + 타입 검사

**Files:** (신규 없음; 전체 green 확인)

- [ ] **Step 1: 전체 스위트 + 타입 검사 + workflow 구조 확인**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 전체 PASS(finalize/workflow-structure 포함), 타입 오류 없음.

- [ ] **Step 2: 로컬 스모크 테스트 — report CLI가 가짜 findings에서도 출력을 생성하는지 확인**

Run (임시 디렉터리에 규격에 맞는 findings + synthesis를 넣고 `node --import tsx src/report.ts`를 실행하여 `report.html`/`issue.md`가 생성되고 예상 문자열이 포함되어 있는지 확인):
```bash
d=$(mktemp -d); mkdir -p "$d/findings"
printf '%s' '{"reviewer":"docs_staleness","status":"ok","findings":[{"file":"README.md","related":[],"reviewer":"docs_staleness","category":"staleness","problem":"p","evidence":"e","suggestion":"s","severity":"high","confidence":"high","ssot_direction":"stale_a"}]}' > "$d/findings/docs_staleness.json"
printf '%s' '{"themes":[],"semantic_duplicates":[],"executive_summary":"sum","status":"ok"}' > "$d/synthesis.json"
node --import tsx src/report.ts "$d/findings" "$d/synthesis.json" "$d/report.html" "$d/issue.md"
grep -q "upkeep:report" "$d/issue.md" && head -c 20 "$d/report.html"
```
Expected: `report: 1 findings ...`가 출력되고, `issue.md`에 marker가 포함되며, `report.html`이 `<!doctype html>`로 시작합니다.

- [ ] **Step 3: Commit(수정 사항이 있는 경우)**; 수정 사항이 없으면 생략합니다.

---

### Task 6: 라이브 e2e (`wei18/Sudoku` 대상, 수동)

**Files:**
- Create: `docs/e2e.md`

> 이 단계는 **실제 GitHub + CLAUDE_CODE_OAUTH_TOKEN이 필요**하며, CI 단위 테스트로는 완료할 수 없습니다. 절차를 문서화하고 사람이 한 번 실행합니다. dev 기간에는 `uses:`의 ref를 브랜치 이름으로 사용합니다(`@v1` 아님).

- [ ] **Step 1: `docs/e2e.md` 생성**

````markdown
# e2e 절차 (wei18/Sudoku 대상)

전제 조건: upkeep이 `wei18/upkeep`에 push되어 있음(브랜치 또는 태그); `wei18/Sudoku`에 repo secret `CLAUDE_CODE_OAUTH_TOKEN`이 존재함.

## 1. 자식 action / workflow의 ref를 dev 브랜치로 임시 변경
로컬의 upkeep에서: `.github/workflows/audit.yml` 내 `@v1` 4곳을 `@<dev-branch>`로 변경하고 해당 브랜치에 push합니다.
(릴리스 시 `@v1`로 되돌리고 태그를 붙입니다.)

## 2. Sudoku에 트리거 workflow 추가
`wei18/Sudoku`에 `.github/workflows/audit.yml`을 생성합니다.
```yaml
on: { workflow_dispatch: {} }
jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@<dev-branch>
    secrets:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```
push 후 Actions 페이지에서 `Run workflow`를 실행합니다.

## 3. 검수 체크포인트
- [ ] `discovery` job green: artifacts에 `inventory`가 있고, `reviewers` 출력이 6개(i18n은 기본값으로 비활성).
- [ ] `review` matrix에서 6개 job 실행(`fail-fast:false`); 각각 `findings-<reviewer>`를 업로드.
- [ ] **artifact 경로**: 각 `findings-<reviewer>` 내에 `<reviewer>.json`이 포함되어 있음(단일 파일 upload 구조 가정 검증; 실제로 `findings/` 접두사가 붙는 경우 report의 download path 또는 upload의 working-directory를 조정할 것).
- [ ] 각 findings가 `validateReviewerOutput`을 통과함(finalize가 보장; LLM 실제 출력 형식이 올바른지 한 건 발췌 확인).
- [ ] `synthesis` job이 일부 reviewer 실패 시에도 실행됨(`if: always()`); `synthesis`를 출력함.
- [ ] `report` job이 `report-html` artifact를 생성하고 Sudoku에 `audit` 라벨이 붙은 issue를 개설함; **재실행 시** 새 issue를 개설하지 않고 **동일 issue를 edit**하는지 확인(upsert, `ISSUE_MARKER` 기반).
- [ ] HTML을 다운로드하여 오프라인으로 열 수 있고, severity 필터가 동작하며, 외부 리소스가 없음.

## 4. 관찰 및 파라미터 조정
- 토큰 비용: 각 reviewer job의 사용량 확인; 필요 시 `max_turns` 또는 reviewer 범위를 조정합니다.
- claude-code-action이 findings를 작성하지 않은 경우: prompt가 `reviewer-prompt.txt`를 정상적으로 읽었는지, `--allowedTools`에 `Write`가 포함되어 있는지 확인합니다.

## 5. 결과 기록
최초 e2e의 run URL과 발견된 조정 사항을 이 파일 말미에 기록하여 릴리스 전 참고 자료로 활용합니다.
````

- [ ] **Step 2: Commit**

```bash
git add docs/e2e.md
git commit -m "docs: live e2e procedure against wei18/Sudoku"
```

- [ ] **Step 3: (수동) `docs/e2e.md`에 따라 라이브 e2e를 한 번 실행하고**, 검수 체크포인트를 모두 체크하며 run URL과 조정 사항을 기록합니다. 이 단계는 사람이 실행하며 CI가 아닙니다.

---

## 완료 기준 (Plan 4b)

- `npx vitest run` 전체 green(finalize, workflow-structure 포함); `npx tsc --noEmit` 오류 없음.
- composite 자식 action 4개 + reusable workflow 1개가 배치되고 구조 테스트를 통과함.
- README에 바로 복사하여 사용할 수 있는 job-level 사용법이 제공되고, "미구현" 문구가 없음.
- `docs/e2e.md` 절차가 준비되어 있고, **최초 라이브 e2e를 사람이 실행하여 체크포인트를 모두 완료**한 후 upkeep v1을 릴리스합니다(태그 붙이기, ref를 dev 브랜치에서 `@v1`으로 변경).

## 다음 단계

Plan 1–4가 모두 완료되었습니다 → 릴리스(v1 태그 붙이기)로 진행합니다. [[project-obsidian-filing]]에 따라, 모든 IMPL_APPROVED 완료 후 spec/plans를 Obsidian vault에 보관합니다. 다국어 문서(en/zh-TW/zh-CN/ja/ko)는 이 시점에 Content Creator/PR 팀이 착수합니다(README 내용이 확정된 후).
