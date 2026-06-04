# Plan 1 — Discovery 確定性核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一個零 LLM、純確定性的 Node CLI，掃描 repo 產出 `inventory.json`（檔案清單 + 模態/類別 + git 時間 + 內容 hash + 引用圖 + 合成後設定），供後續 reviewer/consolidate/report 階段消費。

**Architecture:** TypeScript（ESM, Node 20）。以 `git ls-files --cached --others --exclude-standard` 列檔（天然遵守 `.gitignore`，無需自行重實作）；各職責拆成小模組（config / classify / scan / hash / gitmeta / refgraph），由 `discovery.ts` 編排成 `Inventory` 並輸出 JSON。

**Tech Stack:** TypeScript, Node 20, vitest, `yaml`（解析 audit.yml）。git CLI 為執行期相依（GH runner 內建）。

對應 spec：`docs/design.md` §1[1] Discovery、§2 rubric 來源探索、§5 audit.yml、§7 模態分流。

---

## File Structure

```
repo-audit-action/
├── package.json            # ESM, scripts: build/test, deps: yaml; dev: vitest, typescript, @types/node
├── tsconfig.json           # ES2022, moduleResolution bundler, strict
├── vitest.config.ts        # node 環境
└── src/
    ├── types.ts            # 共用型別（Inventory/FileEntry/AuditConfig/Severity...），無邏輯
    ├── config.ts           # 載入 .claude/audit.yml + 合成預設
    ├── classify.ts         # 副檔名/內容 → modality + category
    ├── scan.ts             # git ls-files 列檔 + binary/lockfile 偵測 + 100KB 文字旗標
    ├── hash.ts             # 內容 sha256
    ├── gitmeta.ts          # 每檔最後 commit 時間
    ├── refgraph.ts         # 引用圖（basename 文字提及 heuristic）
    └── discovery.ts        # 編排 → Inventory，CLI 進入點
test/                       # 與 src 對應的 *.test.ts（vitest）
```

每個檔單一職責、可獨立測。`discovery.ts` 只做編排，不含分類/掃描邏輯。

---

### Task 0: 專案 scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`

- [ ] **Step 1: 建 `package.json`**

```json
{
  "name": "repo-audit-action",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "discovery": "node --import tsx src/discovery.ts"
  },
  "dependencies": {
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: 建 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: 建 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node' },
});
```

- [ ] **Step 4: 安裝並驗證**

Run: `npm install && npx vitest run`
Expected: vitest 啟動，回報 `No test files found`（尚無測試），exit 0。

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts package-lock.json
git commit -m "chore: scaffold TypeScript + vitest for discovery core"
```

---

### Task 1: 共用型別 `src/types.ts`

**Files:**
- Create: `src/types.ts`

無執行邏輯，只定義契約。驗證方式為 `tsc --noEmit` 通過。

- [ ] **Step 1: 寫型別**

```ts
// src/types.ts
export type Severity = 'low' | 'medium' | 'high';

export type ReviewerName =
  | 'docs_staleness'
  | 'code_hygiene'
  | 'spec_flow'
  | 'visual_icon'
  | 'duplicate_orphan'
  | 'convention'
  | 'i18n';

export type Modality = 'text' | 'vector_diagram' | 'raster_image' | 'binary';

export type Category =
  | 'code' | 'doc' | 'spec' | 'visual' | 'flow' | 'icon' | 'config' | 'other';

export interface ReviewerConfig {
  enabled: boolean;
  paths?: string[];
  rubric?: string; // repo 內相對路徑
}

export interface AuditConfig {
  version: number;
  reviewers: Record<ReviewerName, ReviewerConfig>;
  report: { issueLabel: string; minSeverity: Severity };
}

export interface FileEntry {
  path: string;          // 相對 repo root，POSIX 分隔
  modality: Modality;
  category: Category;
  sizeBytes: number;
  hash: string;          // sha256 hex；binary 也算
  oversizedText: boolean; // 文字類且 > MAX_FILE_KB
  lastCommitISO: string | null; // 無 git 記錄為 null
  referencedBy: string[];       // 哪些檔在內文提及此檔 basename
}

export interface ConventionSource {
  path: string;          // 探索到的規範來源檔
  kind: 'claude_md' | 'skill' | 'workflow' | 'gha_workflow' | 'audit_yml';
}

export interface Inventory {
  repoRoot: string;
  generatedAtISO: string;
  config: AuditConfig;
  conventions: ConventionSource[];
  files: FileEntry[];
}

export const MAX_FILE_KB = 100;
```

- [ ] **Step 2: 驗證編譯**

Run: `npx tsc --noEmit`
Expected: 無錯誤，exit 0。

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared Inventory/config type contracts"
```

---

### Task 2: 設定合成 `src/config.ts`

**Files:**
- Create: `src/config.ts`, `test/config.test.ts`

預設：6 reviewer 開、`i18n` 關；`report.issueLabel='audit'`、`minSeverity='low'`。audit.yml 缺檔→全預設；部分覆蓋→深層合併。

- [ ] **Step 1: 寫失敗測試**

```ts
// test/config.test.ts
import { describe, it, expect } from 'vitest';
import { defaultConfig, mergeConfig, loadConfig } from '../src/config.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('config', () => {
  it('default enables 6 reviewers and disables i18n', () => {
    const c = defaultConfig();
    expect(c.reviewers.docs_staleness.enabled).toBe(true);
    expect(c.reviewers.i18n.enabled).toBe(false);
    expect(c.report.issueLabel).toBe('audit');
    expect(c.report.minSeverity).toBe('low');
  });

  it('partial yaml overrides only specified fields', () => {
    const merged = mergeConfig(defaultConfig(), {
      reviewers: { visual_icon: { enabled: false }, i18n: { enabled: true } },
      report: { issueLabel: 'health' },
    });
    expect(merged.reviewers.visual_icon.enabled).toBe(false);
    expect(merged.reviewers.i18n.enabled).toBe(true);
    expect(merged.reviewers.code_hygiene.enabled).toBe(true); // 未指定 → 保留預設
    expect(merged.report.issueLabel).toBe('health');
    expect(merged.report.minSeverity).toBe('low');           // 未指定 → 保留預設
  });

  it('loadConfig returns defaults when file absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    expect(loadConfig(dir)).toEqual(defaultConfig());
  });

  it('loadConfig parses .claude/audit.yml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude/audit.yml'),
      'version: 1\nreviewers:\n  i18n:\n    enabled: true\n');
    expect(loadConfig(dir).reviewers.i18n.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL（`config.js` 尚未實作）。

- [ ] **Step 3: 寫實作**

```ts
// src/config.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { AuditConfig, ReviewerName, ReviewerConfig } from './types.js';

const REVIEWERS: ReviewerName[] = [
  'docs_staleness', 'code_hygiene', 'spec_flow',
  'visual_icon', 'duplicate_orphan', 'convention', 'i18n',
];

export function defaultConfig(): AuditConfig {
  const reviewers = {} as Record<ReviewerName, ReviewerConfig>;
  for (const r of REVIEWERS) reviewers[r] = { enabled: r !== 'i18n' };
  return { version: 1, reviewers, report: { issueLabel: 'audit', minSeverity: 'low' } };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function mergeConfig(base: AuditConfig, over: DeepPartial<AuditConfig>): AuditConfig {
  const out: AuditConfig = structuredClone(base);
  if (over.version !== undefined) out.version = over.version;
  if (over.report) Object.assign(out.report, over.report);
  if (over.reviewers) {
    for (const [name, cfg] of Object.entries(over.reviewers)) {
      const key = name as ReviewerName;
      if (out.reviewers[key]) Object.assign(out.reviewers[key], cfg);
    }
  }
  return out;
}

export function loadConfig(repoRoot: string): AuditConfig {
  const p = join(repoRoot, '.claude', 'audit.yml');
  if (!existsSync(p)) return defaultConfig();
  const parsed = parse(readFileSync(p, 'utf8')) ?? {};
  return mergeConfig(defaultConfig(), parsed as DeepPartial<AuditConfig>);
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/config.test.ts`
Expected: PASS（4 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: parse and merge .claude/audit.yml over defaults"
```

---

### Task 3: 分類 `src/classify.ts`

**Files:**
- Create: `src/classify.ts`, `test/classify.test.ts`

輸入：相對路徑 + 內容 Buffer。輸出：`{ modality, category }`。binary 偵測用前 8000 bytes 是否含 NUL；lockfile 用檔名。

- [ ] **Step 1: 寫失敗測試**

```ts
// test/classify.test.ts
import { describe, it, expect } from 'vitest';
import { classify } from '../src/classify.js';

const txt = (s: string) => Buffer.from(s, 'utf8');

describe('classify', () => {
  it('source code', () => {
    expect(classify('src/App.swift', txt('struct A {}')))
      .toEqual({ modality: 'text', category: 'code' });
  });
  it('markdown doc', () => {
    expect(classify('README.md', txt('# hi')).category).toBe('doc');
  });
  it('spec path', () => {
    expect(classify('docs/spec/flow.md', txt('x')).category).toBe('spec');
  });
  it('raster image is not byte-capped as text', () => {
    expect(classify('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])))
      .toEqual({ modality: 'raster_image', category: 'visual' });
  });
  it('icon by name', () => {
    expect(classify('Assets.xcassets/AppIcon.appiconset/icon.png', txt('')).category)
      .toBe('icon');
  });
  it('vector diagram is text-modality', () => {
    expect(classify('docs/flow.mmd', txt('graph TD; A-->B')))
      .toEqual({ modality: 'vector_diagram', category: 'flow' });
  });
  it('binary content with NUL byte', () => {
    expect(classify('data.bin', Buffer.from([1, 0, 2])).modality).toBe('binary');
  });
  it('test file with .spec. suffix is code, not spec', () => {
    expect(classify('src/auth.spec.ts', txt('test()')).category).toBe('code');
  });
  it('"flow" as a word-internal substring is not flow category', () => {
    expect(classify('src/overflow.ts', txt('x')).category).toBe('code');
    expect(classify('docs/workflow.md', txt('x')).category).toBe('doc');
  });
  it('"icon" in a directory name does not make a file an icon', () => {
    expect(classify('src/iconography/util.ts', txt('x')).category).toBe('code');
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/classify.test.ts`
Expected: FAIL。

- [ ] **Step 3: 寫實作**

```ts
// src/classify.ts
import { basename, extname } from 'node:path';
import type { Modality, Category } from './types.js';

const RASTER = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.heic', '.ico', '.icns']);
const VECTOR = new Set(['.svg', '.mmd', '.dot', '.puml', '.plantuml']);
const CODE = new Set(['.ts', '.tsx', '.js', '.jsx', '.swift', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.c', '.h', '.cpp', '.m', '.sh']);
const DOC = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc']);
const CONFIG = new Set(['.yml', '.yaml', '.json', '.toml', '.plist', '.xml']);

function hasNul(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function classify(path: string, content: Buffer): { modality: Modality; category: Category } {
  const ext = extname(path).toLowerCase();
  const name = basename(path).toLowerCase();
  const lower = path.toLowerCase();

  // modality
  let modality: Modality;
  if (RASTER.has(ext)) modality = 'raster_image';
  else if (VECTOR.has(ext)) modality = 'vector_diagram';
  else if (hasNul(content)) modality = 'binary';
  else modality = 'text';

  // category
  let category: Category;
  const segs = lower.split('/');
  const isSpecPath = segs.some((s) => s === 'spec' || s === 'specs');
  if (name.includes('icon') || ext === '.icns' || ext === '.ico') category = 'icon';
  else if (modality === 'raster_image') category = 'visual';
  else if (isSpecPath) category = 'spec'; // 路徑含 spec/specs 區段；避免 *.spec.ts 誤判
  else if (modality === 'vector_diagram' || /(?:^|[-_])flow(?:[-_.]|$)/.test(name)) category = 'flow';
  else if (CODE.has(ext)) category = 'code';
  else if (DOC.has(ext)) category = 'doc';
  else if (CONFIG.has(ext)) category = 'config';
  else category = 'other';

  return { modality, category };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/classify.test.ts`
Expected: PASS（10 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/classify.ts test/classify.test.ts
git commit -m "feat: classify files by modality and category"
```

---

### Task 4: 列檔 `src/scan.ts`

**Files:**
- Create: `src/scan.ts`, `test/scan.test.ts`

用 `git ls-files --cached --others --exclude-standard` 列檔（天然遵守 .gitignore），回傳相對 POSIX 路徑陣列。lockfile 由檔名集合判定（供上層標記，不在此排除）。

- [ ] **Step 1: 寫失敗測試**（用 temp git repo）

```ts
// test/scan.test.ts
import { describe, it, expect } from 'vitest';
import { listFiles, isLockfile } from '../src/scan.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

describe('scan', () => {
  it('lists tracked + untracked, respects .gitignore', () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, 'a.ts'), 'x');
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\nbuild/\n');
    writeFileSync(join(dir, 'ignored.txt'), 'x');
    mkdirSync(join(dir, 'build'));
    writeFileSync(join(dir, 'build/out.js'), 'x');
    const files = listFiles(dir).sort();
    expect(files).toContain('a.ts');
    expect(files).toContain('.gitignore');
    expect(files).not.toContain('ignored.txt');
    expect(files).not.toContain('build/out.js');
  });

  it('isLockfile detects common lockfiles', () => {
    expect(isLockfile('package-lock.json')).toBe(true);
    expect(isLockfile('ios/Podfile.lock')).toBe(true);
    expect(isLockfile('src/app.ts')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/scan.test.ts`
Expected: FAIL。

- [ ] **Step 3: 寫實作**

```ts
// src/scan.ts
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'podfile.lock', 'cargo.lock', 'gemfile.lock', 'composer.lock',
  'package.resolved',
]);

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(basename(path).toLowerCase());
}

export function listFiles(repoRoot: string): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\0').filter((p) => p.length > 0);
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/scan.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/scan.ts test/scan.test.ts
git commit -m "feat: list repo files via git, respecting .gitignore"
```

---

### Task 5: 內容雜湊 `src/hash.ts`

**Files:**
- Create: `src/hash.ts`, `test/hash.test.ts`

- [ ] **Step 1: 寫失敗測試**

```ts
// test/hash.test.ts
import { describe, it, expect } from 'vitest';
import { sha256 } from '../src/hash.js';

describe('hash', () => {
  it('stable hex digest', () => {
    expect(sha256(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('same content same hash (duplicate detection basis)', () => {
    expect(sha256(Buffer.from('dup'))).toBe(sha256(Buffer.from('dup')));
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/hash.test.ts`
Expected: FAIL。

- [ ] **Step 3: 寫實作**

```ts
// src/hash.ts
import { createHash } from 'node:crypto';

export function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/hash.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/hash.ts test/hash.test.ts
git commit -m "feat: sha256 content hashing for duplicate detection"
```

---

### Task 6: git 後設 `src/gitmeta.ts`

**Files:**
- Create: `src/gitmeta.ts`, `test/gitmeta.test.ts`

回傳 `Map<path, lastCommitISO>`；未追蹤/無記錄的檔給 `null`。用單一 `git log` 走訪所有路徑的最後 commit 時間（committer date, ISO 8601）。

- [ ] **Step 1: 寫失敗測試**

```ts
// test/gitmeta.test.ts
import { describe, it, expect } from 'vitest';
import { lastCommitTimes } from '../src/gitmeta.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function commitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gm-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'tracked.ts'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir, env });
  writeFileSync(join(dir, 'untracked.ts'), 'x');
  return dir;
}

describe('gitmeta', () => {
  it('returns ISO time for tracked, null for untracked', () => {
    const dir = commitRepo();
    const m = lastCommitTimes(dir, ['tracked.ts', 'untracked.ts']);
    expect(m.get('tracked.ts')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(m.get('untracked.ts')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/gitmeta.test.ts`
Expected: FAIL。

- [ ] **Step 3: 寫實作**

```ts
// src/gitmeta.ts
import { execFileSync } from 'node:child_process';

// 對每個路徑查最後 commit 的 committer ISO 時間；無記錄回 null。
export function lastCommitTimes(repoRoot: string, paths: string[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const p of paths) {
    try {
      const out = execFileSync(
        'git', ['log', '-1', '--format=%cI', '--', p],
        { cwd: repoRoot, encoding: 'utf8' },
      ).trim();
      m.set(p, out.length > 0 ? out : null);
    } catch {
      m.set(p, null);
    }
  }
  return m;
}
```

> 註：逐檔 `git log` 在大型 repo 偏慢；Plan 4 e2e 若觀察到瓶頸再改批次 `git log --name-only` 單次走訪優化。先求正確。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/gitmeta.test.ts`
Expected: PASS（1 test）。

- [ ] **Step 5: Commit**

```bash
git add src/gitmeta.ts test/gitmeta.test.ts
git commit -m "feat: per-file last commit time via git log"
```

---

### Task 7: 引用圖 `src/refgraph.ts`

**Files:**
- Create: `src/refgraph.ts`, `test/refgraph.test.ts`

heuristic：對每個檔，找出哪些「文字類」檔的內文提及它的 basename。回傳 `Map<path, referencedBy[]>`。供孤兒偵測（`referencedBy` 為空 = 疑似孤兒，由 reviewer 再判）。

- [ ] **Step 1: 寫失敗測試**

```ts
// test/refgraph.test.ts
import { describe, it, expect } from 'vitest';
import { buildRefGraph } from '../src/refgraph.js';

describe('refgraph', () => {
  it('maps which text files mention a basename', () => {
    const files = [
      { path: 'README.md', modality: 'text' as const, content: Buffer.from('see logo.png here') },
      { path: 'assets/logo.png', modality: 'raster_image' as const, content: Buffer.from([0x89]) },
      { path: 'assets/orphan.png', modality: 'raster_image' as const, content: Buffer.from([0x89]) },
    ];
    const g = buildRefGraph(files);
    expect(g.get('assets/logo.png')).toEqual(['README.md']);
    expect(g.get('assets/orphan.png')).toEqual([]); // 孤兒
  });

  it('does not count a file referencing itself', () => {
    const files = [
      { path: 'a.md', modality: 'text' as const, content: Buffer.from('a.md title') },
    ];
    expect(buildRefGraph(files).get('a.md')).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/refgraph.test.ts`
Expected: FAIL。

- [ ] **Step 3: 寫實作**

```ts
// src/refgraph.ts
import { basename } from 'node:path';
import type { Modality } from './types.js';

interface RefInput { path: string; modality: Modality; content: Buffer; }

// 只有文字類檔能「引用」別人。以 basename 子字串比對（heuristic）。
export function buildRefGraph(files: RefInput[]): Map<string, string[]> {
  const texts = files
    .filter((f) => f.modality === 'text' || f.modality === 'vector_diagram')
    .map((f) => ({ path: f.path, text: f.content.toString('utf8') }));

  const graph = new Map<string, string[]>();
  for (const target of files) {
    const base = basename(target.path);
    const refs: string[] = [];
    for (const src of texts) {
      if (src.path === target.path) continue;
      if (src.text.includes(base)) refs.push(src.path);
    }
    graph.set(target.path, refs);
  }
  return graph;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/refgraph.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/refgraph.ts test/refgraph.test.ts
git commit -m "feat: build basename reference graph for orphan detection"
```

---

### Task 8: 編排與 CLI `src/discovery.ts`

**Files:**
- Create: `src/discovery.ts`, `test/discovery.test.ts`

組合前述模組 → `Inventory`。探索規範來源（CLAUDE.md、.claude/skills/**、.claude/workflows/**、.github/workflows/**、.claude/audit.yml）。CLI：`node src/discovery.ts <repoRoot> [outPath]`，輸出 JSON（預設 stdout）。

- [ ] **Step 1: 寫失敗測試**（端到端 temp repo）

```ts
// test/discovery.test.ts
import { describe, it, expect } from 'vitest';
import { discover } from '../src/discovery.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'disc-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# proj\nuses logo.png');
  writeFileSync(join(dir, 'CLAUDE.md'), 'rules');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets/logo.png'), Buffer.from([0x89, 0x50]));
  writeFileSync(join(dir, 'assets/orphan.png'), Buffer.from([0x89, 0x50]));
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir, env });
  return dir;
}

describe('discover', () => {
  it('produces a complete inventory', () => {
    const inv = discover(repo());
    const byPath = Object.fromEntries(inv.files.map((f) => [f.path, f]));

    expect(inv.files.length).toBe(4);
    expect(byPath['assets/logo.png'].modality).toBe('raster_image');
    expect(byPath['assets/logo.png'].referencedBy).toEqual(['README.md']);
    expect(byPath['assets/orphan.png'].referencedBy).toEqual([]);
    expect(byPath['README.md'].lastCommitISO).toMatch(/^\d{4}-/);
    expect(byPath['README.md'].hash).toMatch(/^[0-9a-f]{64}$/);

    expect(inv.config.reviewers.i18n.enabled).toBe(false);
    expect(inv.conventions.some((c) => c.kind === 'claude_md')).toBe(true);
  });

  it('flags oversized text files', () => {
    const dir = repo();
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(101 * 1024));
    const inv = discover(dir);
    const big = inv.files.find((f) => f.path === 'big.md')!;
    expect(big.oversizedText).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/discovery.test.ts`
Expected: FAIL。

- [ ] **Step 3: 寫實作**

```ts
// src/discovery.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { classify } from './classify.js';
import { listFiles, isLockfile } from './scan.js';
import { sha256 } from './hash.js';
import { lastCommitTimes } from './gitmeta.js';
import { buildRefGraph } from './refgraph.js';
import { MAX_FILE_KB } from './types.js';
import type { Inventory, FileEntry, ConventionSource } from './types.js';

function discoverConventions(repoRoot: string, paths: string[]): ConventionSource[] {
  const out: ConventionSource[] = [];
  const add = (rel: string, kind: ConventionSource['kind']) => {
    if (existsSync(join(repoRoot, rel))) out.push({ path: rel, kind });
  };
  add('CLAUDE.md', 'claude_md');
  add('.claude/audit.yml', 'audit_yml');
  // 目錄型來源從已列出的 paths 前綴過濾（重用，不再呼叫一次 git ls-files）
  for (const f of paths) {
    if (f.startsWith('.claude/skills/')) out.push({ path: f, kind: 'skill' });
    else if (f.startsWith('.claude/workflows/')) out.push({ path: f, kind: 'workflow' });
    else if (f.startsWith('.github/workflows/')) out.push({ path: f, kind: 'gha_workflow' });
  }
  return out;
}

export function discover(repoRoot: string): Inventory {
  const config = loadConfig(repoRoot);
  const paths = listFiles(repoRoot);
  const times = lastCommitTimes(repoRoot, paths);

  const raw = paths.map((p) => {
    const content = readFileSync(join(repoRoot, p));
    const { modality, category } = classify(p, content);
    return { path: p, content, modality, category };
  });

  const graph = buildRefGraph(raw.map((r) => ({ path: r.path, modality: r.modality, content: r.content })));

  const files: FileEntry[] = raw.map((r) => {
    const sizeBytes = r.content.length;
    const oversizedText =
      (r.modality === 'text' || r.modality === 'vector_diagram') &&
      sizeBytes > MAX_FILE_KB * 1024;
    return {
      path: r.path,
      modality: r.modality,
      category: isLockfile(r.path) ? 'other' : r.category,
      sizeBytes,
      hash: sha256(r.content),
      oversizedText,
      lastCommitISO: times.get(r.path) ?? null,
      referencedBy: graph.get(r.path) ?? [],
    };
  });

  return {
    repoRoot,
    generatedAtISO: new Date().toISOString(),
    config,
    conventions: discoverConventions(repoRoot, paths),
    files,
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const json = JSON.stringify(discover(repoRoot), null, 2);
  const outPath = process.argv[3];
  if (outPath) writeFileSync(outPath, json + '\n');
  else process.stdout.write(json + '\n');
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/discovery.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 5: 全套件 + 型別檢查**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全 PASS、無型別錯誤。

- [ ] **Step 6: Commit**

```bash
git add src/discovery.ts test/discovery.test.ts
git commit -m "feat: orchestrate discovery into Inventory with CLI entrypoint"
```

---

## 完成定義（Plan 1）

- `npx vitest run` 全綠（config/classify/scan/hash/gitmeta/refgraph/discovery）
- `node --import tsx src/discovery.ts <repo>` 對任意 git repo 產出合法 `Inventory` JSON
- `inventory.json` 欄位齊全（modality/category/hash/lastCommitISO/referencedBy/oversizedText + config + conventions）
- 零 LLM、零網路

## 銜接下一步

`Inventory` 型別即 Plan 2 reviewer 的輸入契約。Plan 2 將定義 `findings.json` schema + validator，並以此 inventory 餵給 claude-code-action 內的 lead/reviewer。
