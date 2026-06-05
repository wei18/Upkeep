# Plan 1 — Discovery Deterministic Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-LLM, purely deterministic Node CLI that scans a repo and produces `inventory.json` (file list + modality/category + git timestamps + content hash + reference graph + synthesized config), consumed by downstream reviewer/consolidate/report phases.

**Architecture:** TypeScript (ESM, Node 20). Files are enumerated via `git ls-files --cached --others --exclude-standard` (naturally respects `.gitignore` with no reimplementation needed); each responsibility is split into small modules (config / classify / scan / hash / gitmeta / refgraph), orchestrated by `discovery.ts` into an `Inventory` and written as JSON.

**Tech Stack:** TypeScript, Node 20, vitest, `yaml` (for parsing audit.yml). git CLI is a runtime dependency (built into GH runners).

Corresponding spec: `../design.md` §1[1] Discovery, §2 rubric source exploration, §5 audit.yml, §7 modality routing.

---

## File Structure

```
upkeep/
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

Each file has a single responsibility and can be tested in isolation. `discovery.ts` handles orchestration only and contains no classification or scanning logic.

---

### Task 0: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "upkeep",
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

- [ ] **Step 2: Create `tsconfig.json`**

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

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node' },
});
```

- [ ] **Step 4: Install and verify**

Run: `npm install && npx vitest run`
Expected: vitest starts and reports `No test files found` (no tests yet), exit 0.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts package-lock.json
git commit -m "chore: scaffold TypeScript + vitest for discovery core"
```

---

### Task 1: Shared types `src/types.ts`

**Files:**
- Create: `src/types.ts`

No runtime logic — defines contracts only. Verified by `tsc --noEmit` passing.

- [ ] **Step 1: Write types**

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

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors, exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared Inventory/config type contracts"
```

---

### Task 2: Config synthesis `src/config.ts`

**Files:**
- Create: `src/config.ts`, `test/config.test.ts`

Defaults: 6 reviewers enabled, `i18n` disabled; `report.issueLabel='audit'`, `minSeverity='low'`. Missing audit.yml falls back to all defaults; partial overrides are deep-merged.

- [ ] **Step 1: Write failing tests**

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

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL (`config.js` not yet implemented).

- [ ] **Step 3: Write implementation**

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

- [ ] **Step 4: Run tests and confirm passing**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: parse and merge .claude/audit.yml over defaults"
```

---

### Task 3: Classification `src/classify.ts`

**Files:**
- Create: `src/classify.ts`, `test/classify.test.ts`

Input: relative path + content Buffer. Output: `{ modality, category }`. Binary detection uses whether the first 8000 bytes contain a NUL byte; lockfile detection uses the filename.

- [ ] **Step 1: Write failing tests**

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

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx vitest run test/classify.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

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

- [ ] **Step 4: Run tests and confirm passing**

Run: `npx vitest run test/classify.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/classify.ts test/classify.test.ts
git commit -m "feat: classify files by modality and category"
```

---

### Task 4: File listing `src/scan.ts`

**Files:**
- Create: `src/scan.ts`, `test/scan.test.ts`

Uses `git ls-files --cached --others --exclude-standard` to enumerate files (naturally respects .gitignore), returning an array of relative POSIX paths. Lockfile detection uses a filename set (for upstream callers to mark; not excluded here).

- [ ] **Step 1: Write failing tests** (using a temp git repo)

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

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx vitest run test/scan.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

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

- [ ] **Step 4: Run tests and confirm passing**

Run: `npx vitest run test/scan.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scan.ts test/scan.test.ts
git commit -m "feat: list repo files via git, respecting .gitignore"
```

---

### Task 5: Content hashing `src/hash.ts`

**Files:**
- Create: `src/hash.ts`, `test/hash.test.ts`

- [ ] **Step 1: Write failing tests**

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

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx vitest run test/hash.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

```ts
// src/hash.ts
import { createHash } from 'node:crypto';

export function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
```

- [ ] **Step 4: Run tests and confirm passing**

Run: `npx vitest run test/hash.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hash.ts test/hash.test.ts
git commit -m "feat: sha256 content hashing for duplicate detection"
```

---

### Task 6: Git metadata `src/gitmeta.ts`

**Files:**
- Create: `src/gitmeta.ts`, `test/gitmeta.test.ts`

Returns `Map<path, lastCommitISO>`; untracked files or files with no history get `null`. Uses a single `git log` call per path to retrieve the last commit time (committer date, ISO 8601).

- [ ] **Step 1: Write failing tests**

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

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx vitest run test/gitmeta.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

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

> Note: per-file `git log` calls are slow on large repos; if a bottleneck is observed during Plan 4 e2e, optimize with a single-pass `git log --name-only` traversal. Correctness first.

- [ ] **Step 4: Run tests and confirm passing**

Run: `npx vitest run test/gitmeta.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/gitmeta.ts test/gitmeta.test.ts
git commit -m "feat: per-file last commit time via git log"
```

---

### Task 7: Reference graph `src/refgraph.ts`

**Files:**
- Create: `src/refgraph.ts`, `test/refgraph.test.ts`

Heuristic: for each file, find which "text-modality" files mention its basename in their content. Returns `Map<path, referencedBy[]>`. Used for orphan detection (`referencedBy` empty = suspected orphan, final judgment deferred to reviewer).

- [ ] **Step 1: Write failing tests**

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

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx vitest run test/refgraph.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

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

- [ ] **Step 4: Run tests and confirm passing**

Run: `npx vitest run test/refgraph.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/refgraph.ts test/refgraph.test.ts
git commit -m "feat: build basename reference graph for orphan detection"
```

---

### Task 8: Orchestration and CLI `src/discovery.ts`

**Files:**
- Create: `src/discovery.ts`, `test/discovery.test.ts`

Combines all preceding modules into an `Inventory`. Discovers convention sources (CLAUDE.md, .claude/skills/**, .claude/workflows/**, .github/workflows/**, .claude/audit.yml). CLI: `node src/discovery.ts <repoRoot> [outPath]`, outputs JSON (defaults to stdout).

- [ ] **Step 1: Write failing tests** (end-to-end temp repo)

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

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx vitest run test/discovery.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

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

- [ ] **Step 4: Run tests and confirm passing**

Run: `npx vitest run test/discovery.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full suite + type check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: All PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/discovery.ts test/discovery.test.ts
git commit -m "feat: orchestrate discovery into Inventory with CLI entrypoint"
```

---

## Definition of Done (Plan 1)

- `npx vitest run` all green (config/classify/scan/hash/gitmeta/refgraph/discovery)
- `node --import tsx src/discovery.ts <repo>` produces a valid `Inventory` JSON for any git repo
- `inventory.json` fields complete (modality/category/hash/lastCommitISO/referencedBy/oversizedText + config + conventions)
- Zero LLM, zero network

## Handoff to Next Step

The `Inventory` type is the input contract for Plan 2 reviewers. Plan 2 will define the `findings.json` schema + validator, and feed this inventory to the lead/reviewer inside claude-code-action.
