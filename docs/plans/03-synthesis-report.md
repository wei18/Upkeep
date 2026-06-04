# Plan 3 — Synthesis 契約 + Consolidate + Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 synthesis 輸出契約（型別 + validator + prompt 資產）與**確定性 report pipeline**：consolidate（合併 `findings/*.json` + synthesis → 去重排序的報告模型）、self-contained HTML 報告、GitHub issue markdown，並提供讀檔組裝的 CLI——全部 CI-safe、零 API。

**Architecture:** 沿用 TS/ESM/vitest。新增皆為**確定性 TS + 文字資產**：`synthesis.ts`（validator）、`consolidate.ts`（純函式合併）、`report-html.ts` / `report-issue.ts`（純 render）、`report.ts`（讀檔 CLI）、`reviewers/_synthesis-prompt.md`。真正跑 LLM 的 synthesis step、gh issue upsert、artifact 上傳、matrix 接線都屬 Plan 4。

**Tech Stack:** TypeScript, Node 20, vitest（沿用）。無新增 runtime 相依。

對應 spec：`docs/design.md` §1[3][4][5]、§4（去重/排序規則）、§4.1（synthesis 契約）、§8（synthesis 降級）。

### 範圍邊界（本 plan 不做）
- 不觸發 `claude-code-action`（synthesis 的 LLM 實際呼叫 → Plan 4）
- 不 post GitHub issue（gh upsert）、不上傳 artifact → Plan 4
- 不接 matrix workflow → Plan 4
- HTML 用「依 severity 篩選 + 摺疊」的最小互動；不做排序/搜尋等進階 UI（YAGNI）

---

## File Structure

```
src/
  types.ts        # [改] 追加 Theme / SynthesisOutput / ConsolidatedFinding / ReportStats / ConsolidatedReport
  synthesis.ts    # [新] validateSynthesisOutput()
  consolidate.ts  # [新] consolidate(outputs, synthesis, opts) -> ConsolidatedReport（純函式）
  report-issue.ts # [新] renderIssueMarkdown(report) + ISSUE_MARKER
  report-html.ts  # [新] renderHtml(report)：self-contained 單檔
  report.ts       # [新] CLI：讀 findings/ + synthesis.json → 寫 report.html + issue.md
reviewers/
  _synthesis-prompt.md  # [新] synthesis step 的 prompt 範本
test/
  synthesis.test.ts
  consolidate.test.ts
  report-issue.test.ts
  report-html.test.ts
  report.test.ts          # 整合：loader + pipeline 對 fixtures
  synthesis-assets.test.ts
```

`types.ts` 維持「只放契約」；render/合併/驗證邏輯各自分檔，單一職責。

---

### Task 0: 契約型別 `src/types.ts`（追加）

**Files:**
- Modify: `src/types.ts`（檔尾追加；不更動既有型別）

- [ ] **Step 1: 追加型別**（接在 `ReviewerOutput` 之後）

```ts

export interface Theme {
  title: string;
  narrative: string;
  related_files: string[];   // 此主題涵蓋的檔路徑
  priority: Severity;
}

export interface SynthesisOutput {
  themes: Theme[];
  semantic_duplicates: string[][]; // 每組為 "reviewer|file|category" 鍵
  executive_summary: string;
  status: 'ok' | 'failed';         // failed 時 themes 必為空
}

export interface ConsolidatedFinding extends Finding {
  reviewers: ReviewerName[];       // 回報此 file+category 的所有 reviewer（聯集）
}

export interface ReportStats {
  total: number;
  bySeverity: Record<Severity, number>;
  byReviewer: Partial<Record<ReviewerName, number>>;
  failedReviewers: ReviewerName[];
}

export interface ConsolidatedReport {
  generatedAtISO: string;
  findings: ConsolidatedFinding[];
  themes: Theme[];
  executiveSummary: string;
  synthesisStatus: 'ok' | 'failed' | 'absent';
  stats: ReportStats;
}
```

- [ ] **Step 2: 驗證編譯**

Run: `npx tsc --noEmit`
Expected: 無錯誤，exit 0。

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add synthesis and consolidated-report contract types"
```

---

### Task 1: synthesis validator `src/synthesis.ts`

**Files:**
- Create: `src/synthesis.ts`, `test/synthesis.test.ts`

手寫 validator（同 findings 風格）。`status:"failed"` 必須 `themes:[]`。

- [ ] **Step 1: 寫失敗測試**

```ts
// test/synthesis.test.ts
import { describe, it, expect } from 'vitest';
import { validateSynthesisOutput } from '../src/synthesis.js';

const good = {
  themes: [
    { title: '文件與實作系統性漂移', narrative: '多處 README 與 code 不符，集中在近兩月大改的模組。', related_files: ['README.md', 'src/discovery.ts'], priority: 'high' },
  ],
  semantic_duplicates: [['docs_staleness|README.md|staleness', 'convention|README.md|convention']],
  executive_summary: '整體健康度尚可，主要風險是文件漂移。',
  status: 'ok',
};

describe('validateSynthesisOutput', () => {
  it('accepts a well-formed synthesis', () => {
    const r = validateSynthesisOutput(good);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });
  it('rejects non-object root', () => {
    expect(validateSynthesisOutput(null).valid).toBe(false);
  });
  it('rejects bad status', () => {
    expect(validateSynthesisOutput({ ...good, status: 'done' }).valid).toBe(false);
  });
  it('rejects non-string executive_summary', () => {
    expect(validateSynthesisOutput({ ...good, executive_summary: 5 }).valid).toBe(false);
  });
  it('rejects theme with invalid priority', () => {
    const bad = { ...good, themes: [{ ...good.themes[0], priority: 'urgent' }] };
    const r = validateSynthesisOutput(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('priority'))).toBe(true);
  });
  it('rejects related_files containing a non-string', () => {
    const bad = { ...good, themes: [{ ...good.themes[0], related_files: ['ok', 7] }] };
    expect(validateSynthesisOutput(bad).valid).toBe(false);
  });
  it('rejects semantic_duplicates that is not array of string arrays', () => {
    expect(validateSynthesisOutput({ ...good, semantic_duplicates: ['x'] }).valid).toBe(false);
  });
  it('rejects failed status carrying themes', () => {
    const r = validateSynthesisOutput({ ...good, status: 'failed' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('failed'))).toBe(true);
  });
  it('accepts failed status with empty themes', () => {
    expect(validateSynthesisOutput({ themes: [], semantic_duplicates: [], executive_summary: '', status: 'failed' }).valid).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/synthesis.test.ts`
Expected: FAIL。

- [ ] **Step 3: 寫實作**

```ts
// src/synthesis.ts
const LEVELS = new Set(['low', 'medium', 'high']);

export function validateSynthesisOutput(input: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) {
    return { valid: false, errors: ['root must be an object'] };
  }
  const o = input as Record<string, unknown>;

  if (o.status !== 'ok' && o.status !== 'failed') errors.push('status must be "ok" or "failed"');
  if (typeof o.executive_summary !== 'string') errors.push('executive_summary must be a string');

  if (!Array.isArray(o.themes)) {
    errors.push('themes must be an array');
  } else {
    o.themes.forEach((raw, i) => {
      const at = `themes[${i}]`;
      const t = raw as Record<string, unknown>;
      if (typeof t !== 'object' || t === null) { errors.push(`${at} must be an object`); return; }
      if (typeof t.title !== 'string' || t.title.length === 0) errors.push(`${at}.title required`);
      if (typeof t.narrative !== 'string') errors.push(`${at}.narrative required`);
      if (!Array.isArray(t.related_files) || !t.related_files.every((x) => typeof x === 'string')) {
        errors.push(`${at}.related_files must be an array of strings`);
      }
      if (!LEVELS.has(t.priority as string)) errors.push(`${at}.priority invalid`);
    });
  }

  if (!Array.isArray(o.semantic_duplicates)
    || !o.semantic_duplicates.every((g) => Array.isArray(g) && g.every((x) => typeof x === 'string'))) {
    errors.push('semantic_duplicates must be an array of string arrays');
  }

  if (o.status === 'failed' && Array.isArray(o.themes) && o.themes.length > 0) {
    errors.push('failed status must carry empty themes');
  }
  return { valid: errors.length === 0, errors };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/synthesis.test.ts`
Expected: PASS（9 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/synthesis.ts test/synthesis.test.ts
git commit -m "feat: runtime validator for synthesis output contract"
```

---

### Task 2: synthesis prompt 資產

**Files:**
- Create: `reviewers/_synthesis-prompt.md`, `test/synthesis-assets.test.ts`

- [ ] **Step 1: 寫失敗測試**

```ts
// test/synthesis-assets.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('synthesis prompt asset', () => {
  it('states it reads all findings + inventory and writes synthesis.json', () => {
    const text = readFileSync(join(ROOT, 'reviewers/_synthesis-prompt.md'), 'utf8');
    expect(text).toContain('synthesis.json');
    expect(text).toMatch(/findings/);
    expect(text).toMatch(/related_files/);
    expect(text).toMatch(/executive_summary/);
    expect(text).toMatch(/semantic_duplicates/);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/synthesis-assets.test.ts`
Expected: FAIL。

- [ ] **Step 3: 建立 `reviewers/_synthesis-prompt.md`**

```markdown
# Synthesis prompt 範本

你是 upkeep 的 synthesis（綜合）角色——唯一看到「全部 reviewer 結果」的腦。

## 你拿到的輸入
- `inventory.json`：repo 檔案清單與 metadata。
- 全部 `findings/*.json`：各專業 reviewer 的結構化發現（每筆有 file/category/severity/confidence/ssot_direction…）。

## 你要做的（融會貫通，不重做各 reviewer 的工作）
1. **跨 reviewer 關聯**：找出多筆 finding 其實指向同一系統性根因，歸納成 themes（每個 theme 一段 narrative 說明為何相關）。
2. **語意去重**：找出語意上重複、機械式 file+category 去重抓不到的 finding，列為 `semantic_duplicates`（用 `"reviewer|file|category"` 鍵）。
3. **優先級敘事**：寫一段 `executive_summary`，講整體健康度與最該先處理什麼。

## 重要
- 用 **file 路徑**引用 findings（不要用整數索引）。
- 不要改檔。不要捏造 findings 裡沒有的證據。

## 輸出（嚴格遵守契約）
寫到 `synthesis.json`：

```json
{
  "themes": [
    {
      "title": "系統性問題簡述",
      "narrative": "為何這些 finding 指向同一根因",
      "related_files": ["path/a", "path/b"],
      "priority": "low | medium | high"
    }
  ],
  "semantic_duplicates": [["reviewer|file|category", "reviewer|file|category"]],
  "executive_summary": "整體健康度與優先處理建議的一段話",
  "status": "ok"
}
```

無法完成時輸出 `status: "failed"`、`themes: []`（report 會降級為只呈現 raw findings）。
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/synthesis-assets.test.ts`
Expected: PASS（1 test）。

- [ ] **Step 5: Commit**

```bash
git add reviewers/_synthesis-prompt.md test/synthesis-assets.test.ts
git commit -m "feat: synthesis prompt template asset"
```

---

### Task 3: consolidate `src/consolidate.ts`

**Files:**
- Create: `src/consolidate.ts`, `test/consolidate.test.ts`

純函式：攤平 reviewer outputs（failed 的記入 `failedReviewers`）、以 `file|category` 去重（代表 = severity×confidence 最高、平手取先者）、排序、計 stats、套上 synthesis（ok 才用）。

- [ ] **Step 1: 寫失敗測試**

```ts
// test/consolidate.test.ts
import { describe, it, expect } from 'vitest';
import { consolidate } from '../src/consolidate.js';
import type { ReviewerOutput, Finding, SynthesisOutput } from '../src/types.js';

function f(over: Partial<Finding>): Finding {
  return {
    file: 'README.md', related: [], reviewer: 'docs_staleness', category: 'staleness',
    problem: 'p', evidence: 'e', suggestion: 's', severity: 'low', confidence: 'low',
    ssot_direction: 'n/a', ...over,
  };
}
const OPTS = { generatedAtISO: '2026-06-04T00:00:00Z' };

describe('consolidate', () => {
  it('merges same file+category across reviewers, union reviewers, keeps higher severity', () => {
    const outputs: ReviewerOutput[] = [
      { reviewer: 'docs_staleness', status: 'ok', findings: [f({ severity: 'low', confidence: 'low' })] },
      { reviewer: 'convention', status: 'ok', findings: [f({ reviewer: 'convention', severity: 'high', confidence: 'medium' })] },
    ];
    const r = consolidate(outputs, null, OPTS);
    expect(r.findings.length).toBe(1);
    expect(r.findings[0].severity).toBe('high'); // 代表取較高
    expect(r.findings[0].reviewers.sort()).toEqual(['convention', 'docs_staleness']);
  });

  it('does not merge different categories on the same file', () => {
    const outputs: ReviewerOutput[] = [
      { reviewer: 'docs_staleness', status: 'ok', findings: [f({ category: 'staleness' })] },
      { reviewer: 'duplicate_orphan', status: 'ok', findings: [f({ reviewer: 'duplicate_orphan', category: 'orphan' })] },
    ];
    expect(consolidate(outputs, null, OPTS).findings.length).toBe(2);
  });

  it('sorts by severity desc, then confidence desc, then file asc', () => {
    const outputs: ReviewerOutput[] = [{
      reviewer: 'docs_staleness', status: 'ok', findings: [
        f({ file: 'b.md', severity: 'low', confidence: 'high' }),
        f({ file: 'a.md', category: 'orphan', severity: 'high', confidence: 'low' }),
        f({ file: 'c.md', category: 'duplicate', severity: 'high', confidence: 'high' }),
      ],
    }];
    const order = consolidate(outputs, null, OPTS).findings.map((x) => x.file);
    expect(order).toEqual(['c.md', 'a.md', 'b.md']);
  });

  it('records failed reviewers and excludes them from findings', () => {
    const outputs: ReviewerOutput[] = [
      { reviewer: 'docs_staleness', status: 'ok', findings: [f({})] },
      { reviewer: 'i18n', status: 'failed', findings: [] },
    ];
    const r = consolidate(outputs, null, OPTS);
    expect(r.stats.failedReviewers).toEqual(['i18n']);
    expect(r.findings.length).toBe(1);
  });

  it('computes severity and reviewer stats', () => {
    const outputs: ReviewerOutput[] = [{
      reviewer: 'docs_staleness', status: 'ok', findings: [
        f({ file: 'a.md', severity: 'high' }), f({ file: 'b.md', category: 'orphan', severity: 'low' }),
      ],
    }];
    const s = consolidate(outputs, null, OPTS).stats;
    expect(s.total).toBe(2);
    expect(s.bySeverity).toEqual({ high: 1, medium: 0, low: 1 });
    expect(s.byReviewer.docs_staleness).toBe(2);
  });

  it('carries synthesis when status ok; marks absent when null', () => {
    const syn: SynthesisOutput = {
      themes: [{ title: 'T', narrative: 'N', related_files: ['a.md'], priority: 'high' }],
      semantic_duplicates: [], executive_summary: 'sum', status: 'ok',
    };
    const ok = consolidate([], syn, OPTS);
    expect(ok.themes.length).toBe(1);
    expect(ok.executiveSummary).toBe('sum');
    expect(ok.synthesisStatus).toBe('ok');

    const none = consolidate([], null, OPTS);
    expect(none.synthesisStatus).toBe('absent');
    expect(none.themes).toEqual([]);
  });

  it('drops synthesis content when synthesis failed', () => {
    const syn: SynthesisOutput = { themes: [], semantic_duplicates: [], executive_summary: '', status: 'failed' };
    const r = consolidate([], syn, OPTS);
    expect(r.synthesisStatus).toBe('failed');
    expect(r.themes).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/consolidate.test.ts`
Expected: FAIL。

- [ ] **Step 3: 寫實作**

```ts
// src/consolidate.ts
import type {
  ReviewerOutput, Finding, ReviewerName, Severity, Confidence, Theme,
  SynthesisOutput, ConsolidatedFinding, ConsolidatedReport, ReportStats,
} from './types.js';

const SEV: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
const CONF: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

function cmp(a: Finding, b: Finding): number {
  return (SEV[b.severity] - SEV[a.severity]) || (CONF[b.confidence] - CONF[a.confidence]);
}
function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function consolidate(
  outputs: ReviewerOutput[],
  synthesis: SynthesisOutput | null,
  opts: { generatedAtISO: string },
): ConsolidatedReport {
  const failedReviewers: ReviewerName[] = [];
  const flat: Finding[] = [];
  for (const o of outputs) {
    if (o.status === 'failed') { failedReviewers.push(o.reviewer); continue; }
    for (const fnd of o.findings) flat.push(fnd);
  }

  // group by file|category
  const groups = new Map<string, Finding[]>();
  for (const fnd of flat) {
    const key = `${fnd.file}|${fnd.category}`;
    const arr = groups.get(key);
    if (arr) arr.push(fnd); else groups.set(key, [fnd]);
  }

  const merged: ConsolidatedFinding[] = [];
  for (const group of groups.values()) {
    const rep = [...group].sort(cmp)[0]; // 代表：severity×confidence 最高（穩定取先者）
    merged.push({
      ...rep,
      reviewers: uniq(group.map((g) => g.reviewer)).sort() as ReviewerName[],
      related: uniq(group.flatMap((g) => g.related)).sort(),
    });
  }
  merged.sort((a, b) => cmp(a, b) || a.file.localeCompare(b.file));

  // synthesis 只在 status === 'ok' 才採用；用 if 讓 TS 正確 narrow synthesis 非空
  let themes: Theme[] = [];
  let executiveSummary = '';
  if (synthesis !== null && synthesis.status === 'ok') {
    themes = synthesis.themes;
    executiveSummary = synthesis.executive_summary;
  }

  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  const byReviewer: Partial<Record<ReviewerName, number>> = {};
  for (const m of merged) {
    bySeverity[m.severity] += 1;
    for (const r of m.reviewers) byReviewer[r] = (byReviewer[r] ?? 0) + 1;
  }
  const stats: ReportStats = { total: merged.length, bySeverity, byReviewer, failedReviewers };

  return {
    generatedAtISO: opts.generatedAtISO,
    findings: merged,
    themes,
    executiveSummary,
    synthesisStatus: synthesis === null ? 'absent' : synthesis.status,
    stats,
  };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/consolidate.test.ts`
Expected: PASS（7 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/consolidate.ts test/consolidate.test.ts
git commit -m "feat: deterministic consolidate of findings + synthesis into report model"
```

---

### Task 4: issue markdown `src/report-issue.ts`

**Files:**
- Create: `src/report-issue.ts`, `test/report-issue.test.ts`

純函式產 GitHub issue markdown：含穩定 upsert 標記、severity 統計表、exec summary、themes、findings 表、failed reviewers 提示。

- [ ] **Step 1: 寫失敗測試**

```ts
// test/report-issue.test.ts
import { describe, it, expect } from 'vitest';
import { renderIssueMarkdown, ISSUE_MARKER } from '../src/report-issue.js';
import type { ConsolidatedReport } from '../src/types.js';

const report: ConsolidatedReport = {
  generatedAtISO: '2026-06-04T00:00:00Z',
  findings: [
    { file: 'README.md', related: [], reviewer: 'docs_staleness', reviewers: ['docs_staleness'],
      category: 'staleness', problem: 'pipe | in text', evidence: 'e', suggestion: 's',
      severity: 'high', confidence: 'high', ssot_direction: 'stale_a' },
  ],
  themes: [{ title: 'Drift', narrative: 'why', related_files: ['README.md'], priority: 'high' }],
  executiveSummary: 'overall ok',
  synthesisStatus: 'ok',
  stats: { total: 1, bySeverity: { high: 1, medium: 0, low: 0 }, byReviewer: { docs_staleness: 1 }, failedReviewers: ['i18n'] },
};

describe('renderIssueMarkdown', () => {
  it('includes the upsert marker', () => {
    expect(renderIssueMarkdown(report)).toContain(ISSUE_MARKER);
  });
  it('shows severity counts and total', () => {
    const md = renderIssueMarkdown(report);
    expect(md).toMatch(/High.*1/);
    expect(md).toMatch(/Total.*1/);
  });
  it('lists themes and the finding file', () => {
    const md = renderIssueMarkdown(report);
    expect(md).toContain('Drift');
    expect(md).toContain('README.md');
  });
  it('escapes pipes in table cells so the markdown table is not broken', () => {
    expect(renderIssueMarkdown(report)).toContain('pipe \\| in text');
  });
  it('warns about failed reviewers', () => {
    expect(renderIssueMarkdown(report)).toMatch(/i18n/);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/report-issue.test.ts`
Expected: FAIL。

- [ ] **Step 3: 寫實作**

```ts
// src/report-issue.ts
import type { ConsolidatedReport } from './types.js';

export const ISSUE_MARKER = '<!-- upkeep:report -->';

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderIssueMarkdown(report: ConsolidatedReport): string {
  const s = report.stats;
  const L: string[] = [];
  L.push(ISSUE_MARKER);
  L.push('# 🔍 Upkeep Report');
  L.push('');
  L.push(`_Generated ${report.generatedAtISO}_`);
  L.push('');
  if (report.synthesisStatus !== 'ok') {
    L.push(`> Synthesis ${report.synthesisStatus} — showing raw findings only.`);
    L.push('');
  }
  if (report.executiveSummary) {
    L.push(report.executiveSummary);
    L.push('');
  }
  L.push('## Summary');
  L.push('');
  L.push('| Severity | Count |');
  L.push('|---|---|');
  L.push(`| 🔴 High | ${s.bySeverity.high} |`);
  L.push(`| 🟠 Medium | ${s.bySeverity.medium} |`);
  L.push(`| 🟡 Low | ${s.bySeverity.low} |`);
  L.push(`| **Total** | **${s.total}** |`);
  L.push('');
  if (s.failedReviewers.length > 0) {
    L.push(`> ⚠️ Reviewers that failed this run (results incomplete): ${s.failedReviewers.join(', ')}`);
    L.push('');
  }
  if (report.themes.length > 0) {
    L.push('## Themes');
    L.push('');
    for (const t of report.themes) {
      L.push(`### ${t.priority.toUpperCase()} — ${cell(t.title)}`);
      L.push(cell(t.narrative));
      if (t.related_files.length > 0) {
        L.push(`Files: ${t.related_files.map((f) => `\`${f}\``).join(', ')}`);
      }
      L.push('');
    }
  }
  L.push('## Findings');
  L.push('');
  L.push('| Severity | Conf | File | Category | Reviewers | Problem |');
  L.push('|---|---|---|---|---|---|');
  for (const f of report.findings) {
    L.push(`| ${f.severity} | ${f.confidence} | \`${f.file}\` | ${f.category} | ${f.reviewers.join(', ')} | ${cell(f.problem)} |`);
  }
  L.push('');
  L.push('_Full interactive report: see the workflow run HTML artifact._');
  return L.join('\n');
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/report-issue.test.ts`
Expected: PASS（5 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/report-issue.ts test/report-issue.test.ts
git commit -m "feat: render GitHub issue markdown from consolidated report"
```

---

### Task 5: HTML 報告 `src/report-html.ts`

**Files:**
- Create: `src/report-html.ts`, `test/report-html.test.ts`

純函式產 self-contained 單檔 HTML：inline CSS/JS、severity 色碼、依 severity 篩選。所有動態文字經 `esc()` 跳脫。

- [ ] **Step 1: 寫失敗測試**

```ts
// test/report-html.test.ts
import { describe, it, expect } from 'vitest';
import { renderHtml } from '../src/report-html.js';
import type { ConsolidatedReport } from '../src/types.js';

const report: ConsolidatedReport = {
  generatedAtISO: '2026-06-04T00:00:00Z',
  findings: [
    { file: 'README.md', related: [], reviewer: 'docs_staleness', reviewers: ['docs_staleness'],
      category: 'staleness', problem: 'has <script>alert(1)</script>', evidence: 'e', suggestion: 's',
      severity: 'high', confidence: 'high', ssot_direction: 'stale_a' },
  ],
  themes: [{ title: 'Drift', narrative: 'why', related_files: ['README.md'], priority: 'high' }],
  executiveSummary: 'overall ok',
  synthesisStatus: 'ok',
  stats: { total: 1, bySeverity: { high: 1, medium: 0, low: 0 }, byReviewer: { docs_staleness: 1 }, failedReviewers: [] },
};

describe('renderHtml', () => {
  it('is a self-contained html document', () => {
    const html = renderHtml(report);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
  });
  it('references no external resources (offline self-contained)', () => {
    const html = renderHtml(report);
    expect(/(src|href)\s*=\s*["']https?:/i.test(html)).toBe(false);
  });
  it('includes exec summary, theme, and finding file', () => {
    const html = renderHtml(report);
    expect(html).toContain('overall ok');
    expect(html).toContain('Drift');
    expect(html).toContain('README.md');
  });
  it('HTML-escapes dynamic text to prevent injection', () => {
    const html = renderHtml(report);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
  it('embeds a severity filter control', () => {
    expect(renderHtml(report)).toMatch(/data-f="high"/);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/report-html.test.ts`
Expected: FAIL。

- [ ] **Step 3: 寫實作**

```ts
// src/report-html.ts
import type { ConsolidatedReport } from './types.js';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderHtml(report: ConsolidatedReport): string {
  const s = report.stats;

  const themes = report.themes.map((t) => `
    <section class="theme prio-${esc(t.priority)}">
      <h3>${esc(t.title)} <span class="badge sev-${esc(t.priority)}">${esc(t.priority)}</span></h3>
      <p>${esc(t.narrative)}</p>
      ${t.related_files.length ? `<p class="files">${t.related_files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>` : ''}
    </section>`).join('');

  const rows = report.findings.map((f) => `
    <tr class="sev-row-${esc(f.severity)}" data-sev="${esc(f.severity)}">
      <td><span class="badge sev-${esc(f.severity)}">${esc(f.severity)}</span></td>
      <td>${esc(f.confidence)}</td>
      <td><code>${esc(f.file)}</code></td>
      <td>${esc(f.category)}</td>
      <td>${esc(f.reviewers.join(', '))}</td>
      <td>${esc(f.problem)}</td>
      <td>${esc(f.suggestion)}</td>
    </tr>`).join('');

  const synNote = report.synthesisStatus !== 'ok'
    ? `<p class="warn">Synthesis ${esc(report.synthesisStatus)} — showing raw findings only.</p>` : '';
  const failedNote = s.failedReviewers.length
    ? `<p class="warn">⚠️ Failed reviewers (incomplete): ${esc(s.failedReviewers.join(', '))}</p>` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upkeep Report</title>
<style>
  body{font:14px/1.5 system-ui,-apple-system,sans-serif;margin:0;padding:2rem;color:#1a1a1a;background:#fafafa}
  h1,h2,h3{margin:.4em 0}
  .badge{display:inline-block;padding:.1em .5em;border-radius:6px;font-size:.8em;color:#fff}
  .sev-high{background:#d33}.sev-medium{background:#e8820c}.sev-low{background:#b39200}
  .stats{display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0}
  .stat{padding:.6rem 1rem;border-radius:8px;background:#fff;box-shadow:0 1px 3px #0002}
  table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 3px #0002}
  th,td{border-bottom:1px solid #eee;padding:.5rem;text-align:left;vertical-align:top}
  th{background:#f0f0f0}
  code{background:#f4f4f4;padding:.1em .3em;border-radius:4px}
  .theme{background:#fff;border-left:4px solid #888;padding:.5rem 1rem;margin:.5rem 0;border-radius:0 8px 8px 0}
  .theme.prio-high{border-color:#d33}.theme.prio-medium{border-color:#e8820c}.theme.prio-low{border-color:#b39200}
  .warn{color:#b30000;font-weight:600}
  .filters{margin:1rem 0}
  .filters button{margin-right:.5rem;padding:.3rem .8rem;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer}
  .filters button.active{background:#1a1a1a;color:#fff}
</style></head>
<body>
<h1>🔍 Upkeep Report</h1>
<p>Generated ${esc(report.generatedAtISO)}</p>
${synNote}${failedNote}
${report.executiveSummary ? `<section><h2>Executive Summary</h2><p>${esc(report.executiveSummary)}</p></section>` : ''}
<div class="stats">
  <div class="stat"><span class="badge sev-high">High</span> ${s.bySeverity.high}</div>
  <div class="stat"><span class="badge sev-medium">Medium</span> ${s.bySeverity.medium}</div>
  <div class="stat"><span class="badge sev-low">Low</span> ${s.bySeverity.low}</div>
  <div class="stat"><strong>Total</strong> ${s.total}</div>
</div>
${report.themes.length ? `<h2>Themes</h2>${themes}` : ''}
<h2>Findings</h2>
<div class="filters">
  <button data-f="all" class="active">All</button>
  <button data-f="high">High</button>
  <button data-f="medium">Medium</button>
  <button data-f="low">Low</button>
</div>
<table><thead><tr><th>Severity</th><th>Conf</th><th>File</th><th>Category</th><th>Reviewers</th><th>Problem</th><th>Suggestion</th></tr></thead>
<tbody>${rows}</tbody></table>
<script>
(function(){
  var btns=document.querySelectorAll('.filters button');
  btns.forEach(function(b){b.addEventListener('click',function(){
    btns.forEach(function(x){x.classList.remove('active')});
    b.classList.add('active');
    var f=b.getAttribute('data-f');
    document.querySelectorAll('tbody tr').forEach(function(tr){
      tr.style.display=(f==='all'||tr.getAttribute('data-sev')===f)?'':'none';
    });
  });});
})();
</script>
</body></html>`;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/report-html.test.ts`
Expected: PASS（5 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/report-html.ts test/report-html.test.ts
git commit -m "feat: render self-contained HTML report with severity filter"
```

---

### Task 6: report CLI `src/report.ts`

**Files:**
- Create: `src/report.ts`, `test/report.test.ts`

讀 `findings/` 目錄全部 `*.json` + 可選 `synthesis.json`，consolidate 後寫 `report.html` 與 `issue.md`。匯出 loader 供測試。

- [ ] **Step 1: 寫失敗測試（整合：temp dir fixtures → pipeline）**

```ts
// test/report.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReviewerOutputs, loadSynthesis } from '../src/report.js';
import { consolidate } from '../src/consolidate.js';
import { renderHtml } from '../src/report-html.js';
import { renderIssueMarkdown } from '../src/report-issue.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rep-'));
  const fdir = join(dir, 'findings');
  mkdirSync(fdir);
  writeFileSync(join(fdir, 'docs_staleness.json'), JSON.stringify({
    reviewer: 'docs_staleness', status: 'ok',
    findings: [{ file: 'README.md', related: [], reviewer: 'docs_staleness', category: 'staleness',
      problem: 'p', evidence: 'e', suggestion: 's', severity: 'high', confidence: 'high', ssot_direction: 'stale_a' }],
  }));
  writeFileSync(join(fdir, 'i18n.json'), JSON.stringify({ reviewer: 'i18n', status: 'failed', findings: [] }));
  writeFileSync(join(dir, 'synthesis.json'), JSON.stringify({
    themes: [{ title: 'Drift', narrative: 'n', related_files: ['README.md'], priority: 'high' }],
    semantic_duplicates: [], executive_summary: 'sum', status: 'ok',
  }));
  return { dir, fdir };
}

describe('report pipeline', () => {
  it('loads reviewer outputs from a directory (sorted, json only)', () => {
    const { fdir } = fixture();
    const outs = loadReviewerOutputs(fdir);
    expect(outs.map((o) => o.reviewer)).toEqual(['docs_staleness', 'i18n']);
  });

  it('loadSynthesis returns null when file absent', () => {
    expect(loadSynthesis(join(tmpdir(), 'no-such-synthesis.json'))).toBeNull();
  });

  it('end-to-end: load → consolidate → render produces report with theme and finding', () => {
    const { dir, fdir } = fixture();
    const outs = loadReviewerOutputs(fdir);
    const syn = loadSynthesis(join(dir, 'synthesis.json'));
    const report = consolidate(outs, syn, { generatedAtISO: 't' });

    expect(report.stats.failedReviewers).toEqual(['i18n']);
    expect(report.findings.length).toBe(1);
    expect(report.themes.length).toBe(1);

    const html = renderHtml(report);
    const md = renderIssueMarkdown(report);
    expect(html).toContain('README.md');
    expect(md).toContain('Drift');
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/report.test.ts`
Expected: FAIL（`report.js` 未實作）。

- [ ] **Step 3: 寫實作**

```ts
// src/report.ts
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { consolidate } from './consolidate.js';
import { renderHtml } from './report-html.js';
import { renderIssueMarkdown } from './report-issue.js';
import type { ReviewerOutput, SynthesisOutput } from './types.js';

export function loadReviewerOutputs(findingsDir: string): ReviewerOutput[] {
  if (!existsSync(findingsDir)) return [];
  return readdirSync(findingsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(findingsDir, f), 'utf8')) as ReviewerOutput);
}

export function loadSynthesis(path: string): SynthesisOutput | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as SynthesisOutput) : null;
}

// CLI: report.ts <findingsDir> <synthesisJson|-> <outHtml> <outIssueMd>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [findingsDir, synPath, outHtml, outIssue] = process.argv.slice(2);
  const outputs = loadReviewerOutputs(findingsDir ?? 'findings');
  const synthesis = synPath && synPath !== '-' ? loadSynthesis(synPath) : null;
  const report = consolidate(outputs, synthesis, { generatedAtISO: new Date().toISOString() });
  writeFileSync(outHtml ?? 'report.html', renderHtml(report));
  writeFileSync(outIssue ?? 'issue.md', renderIssueMarkdown(report));
  process.stdout.write(`report: ${report.stats.total} findings, ${report.themes.length} themes, ${report.stats.failedReviewers.length} failed reviewers\n`);
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/report.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 5: 全套件 + 型別檢查**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全 PASS、無型別錯誤。

- [ ] **Step 6: Commit**

```bash
git add src/report.ts test/report.test.ts
git commit -m "feat: report CLI wiring findings + synthesis into html + issue outputs"
```

---

## 完成定義（Plan 3）

- `npx vitest run` 全綠（synthesis/consolidate/report-issue/report-html/report/synthesis-assets + 既有）
- `validateSynthesisOutput` 正確接受/拒絕（含 failed-with-themes、壞 priority、related_files 非字串、semantic_duplicates 形狀）
- `consolidate` 正確去重（file+category，代表取最高 severity×confidence）、排序、stats、synthesis 降級（ok/absent/failed）
- `renderHtml` 產 self-contained 單檔（無外部資源、跳脫注入）、含 severity 篩選
- `renderIssueMarkdown` 含 upsert 標記、統計、themes、findings（cell 跳脫 pipe）、failed reviewers 提示
- `report.ts` CLI 可從 `findings/` + `synthesis.json` 產 `report.html` + `issue.md`
- 零 API、零網路

## 銜接下一步

Plan 4（最後一塊）：`action.yml` composite + GHA matrix（每 reviewer 一個 `claude-code-action` step，用 Plan 2 的 `composeRubric` + `_reviewer-prompt.md`）→ synthesis step（`_synthesis-prompt.md` → `synthesis.json`）→ `report.ts` → gh issue upsert（用 `ISSUE_MARKER` 找舊 issue）+ artifact 上傳；補齊其餘 6 位 reviewer 的內建 rubric 與 `audit.yml` 的 `paths` glob；對 `wei18/Sudoku` 跑真實 e2e，並首次 live 驗證 `claude_args` 是否放行 `--agents`/`Agent`。
