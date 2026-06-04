# Plan 2 — Reviewer 契約 + rubric 合成（docs_staleness vertical slice）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 reviewer 層的資料契約：findings 型別 + runtime validator、rubric 三層合成（內建 ⊕ repo 規範 ⊕ audit.yml）、`docs_staleness` 內建 rubric 與共用 reviewer prompt 範本，並以「錄製 findings 樣本」做契約測試——全部 CI-safe、零 API。

**Architecture:** 沿用 Plan 1 的 TS/ESM/vitest。新增的都是**確定性 TS + 文字資產**：`findings.ts`（validator）、`rubric.ts`（合成）、`reviewers/*.md`（rubric 與 prompt 資產）。真正呼叫 `claude-code-action` 跑 LLM 的部分屬 Plan 4 e2e，本 plan 不觸發 API——契約用錄製樣本驗證。

**Tech Stack:** TypeScript, Node 20, vitest（沿用）。無新增 runtime 相依。

對應 spec：`docs/design.md` §2/§2.1（reviewer + rubric 合成 + 多語）、§3（SSOT 原則）、§4（findings schema）。

### 範圍邊界（本 plan 不做）
- 不觸發 `claude-code-action` / 不呼叫 API（→ Plan 4 e2e）
- 只做 `docs_staleness` 一位的 rubric 資產；其餘 6 位的內建 rubric → Plan 4
- `audit.yml` 的 `reviewers.<name>.paths`（glob 覆蓋）→ Plan 4（本 plan target 選擇只用 category 領域對應）
- synthesis 實作 → Plan 3

---

## File Structure

```
src/
  types.ts        # [改] 追加 Finding / ReviewerOutput / Confidence / FindingCategory
  findings.ts     # [新] validateReviewerOutput()：runtime 驗證 reviewer 輸出合約
  rubric.ts       # [新] composeRubric()：三層合成 + 依 category 選 target 檔
reviewers/
  docs_staleness.md   # [新] docs_staleness 內建預設 rubric（文字資產）
  _reviewer-prompt.md # [新] 共用 reviewer prompt 範本（描述一個 reviewer step 的行為）
test/
  findings.test.ts        # [新]
  rubric.test.ts          # [新]
  reviewer-assets.test.ts # [新] 資產存在性與關鍵內容
  contract/
    docs_staleness.sample.json  # [新] 錄製的合法 findings 樣本（契約錨點）
  contract.test.ts        # [新] 錄製樣本過驗證 + 多個壞樣本被拒
```

`types.ts` 維持「只放契約」；驗證邏輯在 `findings.ts`，合成邏輯在 `rubric.ts`。

---

### Task 0: 契約型別 `src/types.ts`（追加）

**Files:**
- Modify: `src/types.ts`（在檔尾、`MAX_FILE_KB` 之前或之後追加；不更動既有型別）

- [ ] **Step 1: 追加型別**

在 `src/types.ts` 末尾（`export const MAX_FILE_KB = 100;` 之後）追加：

```ts

export type Confidence = 'low' | 'medium' | 'high';

export type FindingCategory =
  | 'staleness'
  | 'duplicate'
  | 'orphan'
  | 'convention'
  | 'inconsistency'
  | 'i18n_sync'
  | 'other';

export type SsotDirection = 'stale_a' | 'stale_b' | 'uncertain' | 'n/a';

export interface Finding {
  file: string;            // 主體檔（跨檔問題放主檔）
  related: string[];       // 關聯檔（可空陣列）
  reviewer: ReviewerName;
  category: FindingCategory;
  problem: string;
  evidence: string;
  suggestion: string;
  severity: Severity;
  confidence: Confidence;
  ssot_direction: SsotDirection;
}

export interface ReviewerOutput {
  reviewer: ReviewerName;
  status: 'ok' | 'failed';  // failed 時 findings 必為空
  findings: Finding[];
}
```

- [ ] **Step 2: 驗證編譯**

Run: `npx tsc --noEmit`
Expected: 無錯誤，exit 0。

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git -c user.name='zw' -c user.email='41205mw@gmail.com' commit -m "feat: add Finding/ReviewerOutput contract types"
```

---

### Task 1: 驗證器 `src/findings.ts`

**Files:**
- Create: `src/findings.ts`, `test/findings.test.ts`

手寫 validator（schema 小，不引入 ajv — YAGNI）。回傳 `{ valid, errors[] }`，逐欄檢查型別與列舉值域；`status:"failed"` 必須 `findings:[]`。

- [ ] **Step 1: 寫失敗測試**

```ts
// test/findings.test.ts
import { describe, it, expect } from 'vitest';
import { validateReviewerOutput } from '../src/findings.js';

const goodFinding = {
  file: 'README.md',
  related: [],
  reviewer: 'docs_staleness',
  category: 'staleness',
  problem: 'README 安裝步驟與 package.json scripts 不符',
  evidence: 'README 寫 npm start；package.json 無 start script',
  suggestion: 'README 較舊，建議更新安裝段落',
  severity: 'medium',
  confidence: 'high',
  ssot_direction: 'stale_a',
};
const goodOutput = { reviewer: 'docs_staleness', status: 'ok', findings: [goodFinding] };

describe('validateReviewerOutput', () => {
  it('accepts a well-formed output', () => {
    const r = validateReviewerOutput(goodOutput);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects non-object root', () => {
    expect(validateReviewerOutput(null).valid).toBe(false);
    expect(validateReviewerOutput('x').valid).toBe(false);
  });

  it('rejects unknown reviewer name', () => {
    const r = validateReviewerOutput({ ...goodOutput, reviewer: 'nope' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('reviewer'))).toBe(true);
  });

  it('rejects bad status', () => {
    expect(validateReviewerOutput({ ...goodOutput, status: 'done' }).valid).toBe(false);
  });

  it('rejects findings that is not an array', () => {
    expect(validateReviewerOutput({ ...goodOutput, findings: {} }).valid).toBe(false);
  });

  it('rejects invalid enum values in a finding', () => {
    const bad = { ...goodOutput, findings: [{ ...goodFinding, severity: 'urgent' }] };
    const r = validateReviewerOutput(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('severity'))).toBe(true);
  });

  it('rejects missing required string fields', () => {
    const { problem, ...noProblem } = goodFinding;
    const r = validateReviewerOutput({ ...goodOutput, findings: [noProblem] });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('problem'))).toBe(true);
  });

  it('rejects failed status carrying findings', () => {
    const r = validateReviewerOutput({ reviewer: 'i18n', status: 'failed', findings: [goodFinding] });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('failed'))).toBe(true);
  });

  it('accepts failed status with empty findings', () => {
    expect(validateReviewerOutput({ reviewer: 'i18n', status: 'failed', findings: [] }).valid).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/findings.test.ts`
Expected: FAIL（`findings.js` 未實作）。

- [ ] **Step 3: 寫實作**

```ts
// src/findings.ts
import type { ReviewerName } from './types.js';

const REVIEWERS = new Set<string>([
  'docs_staleness', 'code_hygiene', 'spec_flow',
  'visual_icon', 'duplicate_orphan', 'convention', 'i18n',
]);
const LEVELS = new Set(['low', 'medium', 'high']);
const CATEGORIES = new Set([
  'staleness', 'duplicate', 'orphan', 'convention', 'inconsistency', 'i18n_sync', 'other',
]);
const SSOT = new Set(['stale_a', 'stale_b', 'uncertain', 'n/a']);

export function validateReviewerOutput(input: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) {
    return { valid: false, errors: ['root must be an object'] };
  }
  const o = input as Record<string, unknown>;
  if (!REVIEWERS.has(o.reviewer as string)) errors.push(`reviewer invalid: ${String(o.reviewer)}`);
  if (o.status !== 'ok' && o.status !== 'failed') errors.push('status must be "ok" or "failed"');

  if (!Array.isArray(o.findings)) {
    errors.push('findings must be an array');
    return { valid: false, errors };
  }

  const reqStr = (v: unknown) => typeof v === 'string' && v.length > 0;
  o.findings.forEach((raw, i) => {
    const at = `findings[${i}]`;
    const f = raw as Record<string, unknown>;
    if (typeof f !== 'object' || f === null) { errors.push(`${at} must be an object`); return; }
    if (!reqStr(f.file)) errors.push(`${at}.file required (non-empty string)`);
    if (!Array.isArray(f.related)) errors.push(`${at}.related must be an array`);
    if (!REVIEWERS.has(f.reviewer as string)) errors.push(`${at}.reviewer invalid`);
    if (!CATEGORIES.has(f.category as string)) errors.push(`${at}.category invalid`);
    if (!reqStr(f.problem)) errors.push(`${at}.problem required`);
    if (typeof f.evidence !== 'string') errors.push(`${at}.evidence required`);
    if (typeof f.suggestion !== 'string') errors.push(`${at}.suggestion required`);
    if (!LEVELS.has(f.severity as string)) errors.push(`${at}.severity invalid`);
    if (!LEVELS.has(f.confidence as string)) errors.push(`${at}.confidence invalid`);
    if (!SSOT.has(f.ssot_direction as string)) errors.push(`${at}.ssot_direction invalid`);
  });

  if (o.status === 'failed' && o.findings.length > 0) {
    errors.push('failed status must carry empty findings');
  }
  return { valid: errors.length === 0, errors };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/findings.test.ts`
Expected: PASS（9 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/findings.ts test/findings.test.ts
git -c user.name='zw' -c user.email='41205mw@gmail.com' commit -m "feat: runtime validator for reviewer output contract"
```

---

### Task 2: rubric 合成 `src/rubric.ts`

**Files:**
- Create: `src/rubric.ts`, `test/rubric.test.ts`

`composeRubric(reviewer, inventory, actionRoot)` 回傳 `RubricBundle`：內建 rubric 路徑（`<actionRoot>/reviewers/<reviewer>.md`）、repo 規範來源（取自 `inventory.conventions`）、audit.yml 顯式 rubric 覆蓋、依 category 領域選出的 target 檔。

- [ ] **Step 1: 寫失敗測試**

```ts
// test/rubric.test.ts
import { describe, it, expect } from 'vitest';
import { composeRubric } from '../src/rubric.js';
import { defaultConfig } from '../src/config.js';
import type { Inventory, FileEntry } from '../src/types.js';

function file(path: string, category: FileEntry['category']): FileEntry {
  return {
    path, category, modality: 'text', sizeBytes: 1, hash: 'x',
    oversizedText: false, lastCommitISO: null, referencedBy: [],
  };
}

function inv(files: FileEntry[], over: Partial<Inventory> = {}): Inventory {
  return {
    repoRoot: '/r', generatedAtISO: 't', config: defaultConfig(),
    conventions: [{ path: 'CLAUDE.md', kind: 'claude_md' }],
    files, ...over,
  };
}

describe('composeRubric', () => {
  it('selects target files by the reviewer category domain', () => {
    const i = inv([file('README.md', 'doc'), file('src/a.ts', 'code'), file('docs/g.md', 'doc')]);
    const b = composeRubric('docs_staleness', i, '/action');
    expect(b.targetFiles.sort()).toEqual(['README.md', 'docs/g.md']);
  });

  it('points builtinRubric at the action reviewers dir', () => {
    const b = composeRubric('docs_staleness', inv([]), '/action');
    expect(b.builtinRubric).toBe('/action/reviewers/docs_staleness.md');
  });

  it('carries repo convention sources', () => {
    const b = composeRubric('convention', inv([file('x.ts', 'code')]), '/action');
    expect(b.conventionSources).toEqual(['CLAUDE.md']);
  });

  it('passes through audit.yml explicit rubric override', () => {
    const cfg = defaultConfig();
    cfg.reviewers.docs_staleness.rubric = '.claude/audit/docs.md';
    const b = composeRubric('docs_staleness', inv([], { config: cfg }), '/action');
    expect(b.explicitRubric).toBe('.claude/audit/docs.md');
  });

  it('explicitRubric is null when not configured', () => {
    expect(composeRubric('docs_staleness', inv([]), '/action').explicitRubric).toBeNull();
  });

  it('whole-repo reviewers see all categories', () => {
    const i = inv([file('a.ts', 'code'), file('b.png', 'visual'), file('c.md', 'doc')]);
    expect(composeRubric('duplicate_orphan', i, '/action').targetFiles.length).toBe(3);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/rubric.test.ts`
Expected: FAIL。

- [ ] **Step 3: 寫實作**

```ts
// src/rubric.ts
import { join } from 'node:path';
import type { Inventory, ReviewerName, Category } from './types.js';

const ALL: Category[] = ['code', 'doc', 'spec', 'visual', 'flow', 'icon', 'config', 'other'];

// 每個 reviewer 負責的 file 類別（target 選擇用）
const DOMAINS: Record<ReviewerName, Category[]> = {
  docs_staleness: ['doc'],
  code_hygiene: ['code'],
  spec_flow: ['spec', 'flow'],
  visual_icon: ['visual', 'icon'],
  duplicate_orphan: ALL,
  convention: ALL,
  i18n: ['doc'], // v1：多語 doc；code 層在地化字串待 Plan 4
};

export interface RubricBundle {
  reviewer: ReviewerName;
  builtinRubric: string;         // action 內建 rubric 檔絕對路徑
  conventionSources: string[];   // repo 規範來源（相對路徑）
  explicitRubric: string | null; // audit.yml reviewers.<name>.rubric 或 null
  targetFiles: string[];         // 此 reviewer 要看的檔（相對路徑）
}

export function composeRubric(
  reviewer: ReviewerName,
  inventory: Inventory,
  actionRoot: string,
): RubricBundle {
  const cats = new Set<Category>(DOMAINS[reviewer]);
  const cfg = inventory.config.reviewers[reviewer];
  return {
    reviewer,
    builtinRubric: join(actionRoot, 'reviewers', `${reviewer}.md`),
    conventionSources: inventory.conventions.map((c) => c.path),
    explicitRubric: cfg?.rubric ?? null,
    targetFiles: inventory.files.filter((f) => cats.has(f.category)).map((f) => f.path),
  };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/rubric.test.ts`
Expected: PASS（6 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/rubric.ts test/rubric.test.ts
git -c user.name='zw' -c user.email='41205mw@gmail.com' commit -m "feat: compose per-reviewer rubric bundle (builtin + conventions + override + targets)"
```

---

### Task 3: reviewer 資產（rubric + prompt 範本）

**Files:**
- Create: `reviewers/docs_staleness.md`, `reviewers/_reviewer-prompt.md`, `test/reviewer-assets.test.ts`

兩個文字資產：`docs_staleness.md` 是該 reviewer 的內建判斷依據；`_reviewer-prompt.md` 是所有 reviewer step 共用的行為範本（描述：讀 inventory + target 檔 + rubric，遵守 SSOT 原則，輸出 `findings/<reviewer>.json` 合約）。測試只斷言關鍵內容存在（文字資產不逐字測）。

- [ ] **Step 1: 寫失敗測試**

```ts
// test/reviewer-assets.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeRubric } from '../src/rubric.js';
import { defaultConfig } from '../src/config.js';

// ESM-safe repo root (project is "type": "module"; do not rely on __dirname)
const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('reviewer assets', () => {
  it('docs_staleness builtin rubric file exists at the composed path', () => {
    const inv = {
      repoRoot: '/r', generatedAtISO: 't', config: defaultConfig(),
      conventions: [], files: [],
    };
    const b = composeRubric('docs_staleness', inv, ROOT.replace(/\/$/, ''));
    expect(existsSync(b.builtinRubric)).toBe(true);
  });

  it('docs_staleness rubric covers staleness + multilingual sync', () => {
    const text = readFileSync(join(ROOT, 'reviewers/docs_staleness.md'), 'utf8');
    expect(text.toLowerCase()).toContain('stale');
    expect(text).toMatch(/multi|多語|README\.<locale>|zh-TW/);
  });

  it('shared reviewer prompt template states the contract and SSOT rule', () => {
    const text = readFileSync(join(ROOT, 'reviewers/_reviewer-prompt.md'), 'utf8');
    expect(text).toContain('findings/');          // 輸出路徑
    expect(text).toMatch(/ssot_direction|SSOT/);  // SSOT 原則
    expect(text).toMatch(/severity/);             // 契約欄位
    expect(text).toMatch(/confidence/);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/reviewer-assets.test.ts`
Expected: FAIL（資產檔不存在）。

- [ ] **Step 3: 建立 `reviewers/docs_staleness.md`**

```markdown
# docs_staleness — 內建 rubric

你是文件陳舊偵測 reviewer。對指派給你的文件檔（README、docs、註解、**多語 README/doc 變體**），找出：

## 抓什麼
- **內容陳舊**：文件描述與真實程式碼/設定/近期 commit 不符（例：README 安裝指令對不上 package.json scripts）。
- **與 code 漂移**：文件提及的 API、檔名、旗標、路徑已不存在或已改名。
- **過期連結**：指向已刪除檔案或失效錨點的連結。
- **多語同步（multilingual doc-set）**：以 `README.md`（base=en）對照各 `README.<locale>.md`（zh-TW/zh-CN/ja/ko）。報告哪個翻譯落後/缺漏 base 新增的章節/過時。

## SSOT 原則（重要）
不要預設文件就是該被更新的一方。只報「分歧」：A 說 X、B 說 Y、兩者不一致。附證據（git 最後修改時間、被引用關係、具體不符之處）。
- 證據強（如 base 上週大改、某翻譯半年沒動）→ 建議裡可明講方向（「該翻譯較舊，建議更新」），但仍視為需人工確認。
- 證據弱 → `ssot_direction: "uncertain"`，標「方向待裁決」。

## 不要做
- 不要改檔（只報告）。
- 不要對沒有實質佐證的「風格偏好」開 finding。
```

- [ ] **Step 4: 建立 `reviewers/_reviewer-prompt.md`**

```markdown
# 共用 reviewer prompt 範本

你是 repo-audit 的一位專業 reviewer，名稱：`{{REVIEWER}}`。

## 你拿到的輸入
- `inventory.json`：整個 repo 的檔案清單與 metadata（modality/category/hash/lastCommitISO/referencedBy/oversizedText）。
- 你的 target 檔清單（只審這些）。
- 你的內建 rubric（定義你抓什麼、怎麼判斷）。
- repo 自身規範來源（CLAUDE.md、.claude/skills、.claude/workflows 等）；衝突時 **repo 規範優先於內建預設**。
- （若有）audit.yml 指定的覆蓋 rubric，優先序最高。

## 你要做的
1. 只在你的 target 檔範圍內工作；需要時用 inventory 的 metadata 當證據（例：lastCommitISO 比對漂移方向）。
2. 遵守你 rubric 內的 **SSOT 原則**：不預設真實來源、只報分歧、附證據、不確定就標 `ssot_direction: "uncertain"`。
3. **不修改任何檔**——只產出 findings。

## 輸出（嚴格遵守契約）
把結果寫到 `findings/{{REVIEWER}}.json`，格式：

```json
{
  "reviewer": "{{REVIEWER}}",
  "status": "ok",
  "findings": [
    {
      "file": "相對路徑",
      "related": [],
      "reviewer": "{{REVIEWER}}",
      "category": "staleness | duplicate | orphan | convention | inconsistency | i18n_sync | other",
      "problem": "問題描述",
      "evidence": "支撐證據",
      "suggestion": "建議修法",
      "severity": "low | medium | high",
      "confidence": "low | medium | high",
      "ssot_direction": "stale_a | stale_b | uncertain | n/a"
    }
  ]
}
```

沒有問題時 `findings: []`、`status: "ok"`。你無法完成時 `status: "failed"`、`findings: []`。
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run test/reviewer-assets.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 6: Commit**

```bash
git add reviewers/docs_staleness.md reviewers/_reviewer-prompt.md test/reviewer-assets.test.ts
git -c user.name='zw' -c user.email='41205mw@gmail.com' commit -m "feat: docs_staleness builtin rubric + shared reviewer prompt template"
```

---

### Task 4: 錄製樣本契約測試

**Files:**
- Create: `test/contract/docs_staleness.sample.json`, `test/contract.test.ts`

錄製一份「像是 docs_staleness 真的會產出」的 findings 樣本當契約錨點：證明 LLM 輸出格式（手寫模擬）能通過 validator，且幾個刻意破壞的變體會被拒。CI-safe、零 API。

- [ ] **Step 1: 建立錄製樣本 `test/contract/docs_staleness.sample.json`**

```json
{
  "reviewer": "docs_staleness",
  "status": "ok",
  "findings": [
    {
      "file": "README.md",
      "related": ["package.json"],
      "reviewer": "docs_staleness",
      "category": "staleness",
      "problem": "README 的 Getting Started 用 `npm start`，但 package.json 沒有 start script。",
      "evidence": "package.json scripts 僅有 build/test/discovery；README 最後 commit 2025-11，package.json 2026-05 改過。",
      "suggestion": "README 較舊，建議把 `npm start` 改為實際可用的指令。",
      "severity": "medium",
      "confidence": "high",
      "ssot_direction": "stale_a"
    },
    {
      "file": "README.zh-TW.md",
      "related": ["README.md"],
      "reviewer": "docs_staleness",
      "category": "i18n_sync",
      "problem": "zh-TW 版缺少 base(en) 於近期新增的 Configuration 章節。",
      "evidence": "README.md 含 ## Configuration；README.zh-TW.md 無對應章節，且 base 該段 2026-05 才加入。",
      "suggestion": "補譯 Configuration 章節到 zh-TW 版。",
      "severity": "low",
      "confidence": "medium",
      "ssot_direction": "stale_b"
    }
  ]
}
```

- [ ] **Step 2: 寫測試（先失敗）**

```ts
// test/contract.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReviewerOutput } from '../src/findings.js';

const HERE = fileURLToPath(new URL('.', import.meta.url)); // .../test/
const sample = JSON.parse(
  readFileSync(join(HERE, 'contract/docs_staleness.sample.json'), 'utf8'),
);

describe('recorded findings contract', () => {
  it('recorded docs_staleness sample passes the validator', () => {
    const r = validateReviewerOutput(sample);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('a finding missing ssot_direction is rejected', () => {
    const broken = structuredClone(sample);
    delete broken.findings[0].ssot_direction;
    expect(validateReviewerOutput(broken).valid).toBe(false);
  });

  it('an out-of-domain enum value is rejected', () => {
    const broken = structuredClone(sample);
    broken.findings[1].category = 'totally_made_up';
    expect(validateReviewerOutput(broken).valid).toBe(false);
  });
});
```

> 此測試在 Task 1 的 `findings.ts` 已存在的前提下，僅因樣本檔/測試檔尚未建立而失敗；建立後即通過。

- [ ] **Step 3: 跑測試確認通過**

Run: `npx vitest run test/contract.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 4: 全套件 + 型別檢查**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全 PASS、無型別錯誤。

- [ ] **Step 5: Commit**

```bash
git add test/contract/docs_staleness.sample.json test/contract.test.ts
git -c user.name='zw' -c user.email='41205mw@gmail.com' commit -m "test: recorded findings contract anchor for docs_staleness"
```

---

## 完成定義（Plan 2）

- `npx vitest run` 全綠（findings/rubric/reviewer-assets/contract + Plan 1 既有）
- `validateReviewerOutput` 正確接受合法、拒絕各類畸形輸出（含 failed-with-findings、未知列舉、缺必填）
- `composeRubric` 對任一 reviewer 產出正確 `RubricBundle`（內建路徑、規範來源、覆蓋、依領域選 target）
- `reviewers/docs_staleness.md` 與 `_reviewer-prompt.md` 存在且含關鍵內容（含多語同步、SSOT、契約欄位）
- 零 API、零網路

## 銜接下一步

`ReviewerOutput`/`Finding` 是 Plan 3 consolidate 的輸入、`synthesis.json`（§4.1）的素材。Plan 3 將做確定性 consolidate（合併 `findings/*.json`、key 去重、severity×confidence 排序）與 HTML/issue 報告組裝。Plan 4 才把 `composeRubric` + `_reviewer-prompt.md` 接到 `claude-code-action` matrix step，對 `wei18/Sudoku` 跑真實 e2e。
