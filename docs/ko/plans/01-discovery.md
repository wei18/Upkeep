# Plan 1 — Discovery 확정성 코어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLM을 전혀 사용하지 않는 순수 결정론적 Node CLI를 구축하여 repo를 스캔하고 `inventory.json`(파일 목록 + 모달리티/카테고리 + git 타임스탬프 + 콘텐츠 해시 + 참조 그래프 + 합성된 설정)을 출력합니다. 이 결과물은 이후 reviewer/consolidate/report 단계에서 소비됩니다.

**Architecture:** TypeScript(ESM, Node 20). `git ls-files --cached --others --exclude-standard`로 파일을 나열합니다(`.gitignore`를 자연스럽게 준수하므로 별도 재구현 불필요). 각 책임은 소규모 모듈로 분리(config / classify / scan / hash / gitmeta / refgraph)하며, `discovery.ts`가 이를 편성하여 `Inventory`를 생성하고 JSON으로 출력합니다.

**Tech Stack:** TypeScript, Node 20, vitest, `yaml`(audit.yml 파싱). git CLI는 런타임 의존성입니다(GH runner에 내장).

대응 spec: `../design.md` §1[1] Discovery, §2 rubric 소스 탐색, §5 audit.yml, §7 모달리티 분기.

---

## File Structure

```
upkeep/
├── package.json            # ESM, scripts: build/test, deps: yaml; dev: vitest, typescript, @types/node
├── tsconfig.json           # ES2022, moduleResolution bundler, strict
├── vitest.config.ts        # node 환경
└── src/
    ├── types.ts            # 공용 타입(Inventory/FileEntry/AuditConfig/Severity...), 로직 없음
    ├── config.ts           # .claude/audit.yml 로드 + 기본값 합성
    ├── classify.ts         # 확장자/콘텐츠 → modality + category
    ├── scan.ts             # git ls-files 파일 나열 + binary/lockfile 감지 + 100KB 텍스트 플래그
    ├── hash.ts             # 콘텐츠 sha256
    ├── gitmeta.ts          # 파일별 마지막 커밋 시간
    ├── refgraph.ts         # 참조 그래프(basename 텍스트 언급 휴리스틱)
    └── discovery.ts        # 편성 → Inventory, CLI 진입점
test/                       # src와 대응하는 *.test.ts (vitest)
```

각 파일은 단일 책임을 지며 독립적으로 테스트 가능합니다. `discovery.ts`는 편성만 담당하고 분류/스캔 로직은 포함하지 않습니다.

---

### Task 0: 프로젝트 scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`

- [ ] **Step 1: `package.json` 작성**

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

- [ ] **Step 2: `tsconfig.json` 작성**

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

- [ ] **Step 3: `vitest.config.ts` 작성**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node' },
});
```

- [ ] **Step 4: 설치 및 검증**

Run: `npm install && npx vitest run`
Expected: vitest가 실행되어 `No test files found`를 보고합니다(아직 테스트 없음), exit 0.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts package-lock.json
git commit -m "chore: scaffold TypeScript + vitest for discovery core"
```

---

### Task 1: 공용 타입 `src/types.ts`

**Files:**
- Create: `src/types.ts`

실행 로직 없이 계약만 정의합니다. 검증 방법은 `tsc --noEmit` 통과 여부입니다.

- [ ] **Step 1: 타입 작성**

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
  rubric?: string; // repo 내 상대 경로
}

export interface AuditConfig {
  version: number;
  reviewers: Record<ReviewerName, ReviewerConfig>;
  report: { issueLabel: string; minSeverity: Severity };
}

export interface FileEntry {
  path: string;          // repo root 기준 상대 경로, POSIX 구분자
  modality: Modality;
  category: Category;
  sizeBytes: number;
  hash: string;          // sha256 hex; binary도 포함
  oversizedText: boolean; // 텍스트 타입이면서 > MAX_FILE_KB
  lastCommitISO: string | null; // git 기록 없으면 null
  referencedBy: string[];       // 본문에서 이 파일의 basename을 언급한 파일 목록
}

export interface ConventionSource {
  path: string;          // 탐색된 규범 소스 파일
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

- [ ] **Step 2: 컴파일 검증**

Run: `npx tsc --noEmit`
Expected: 오류 없음, exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared Inventory/config type contracts"
```

---

### Task 2: 설정 합성 `src/config.ts`

**Files:**
- Create: `src/config.ts`, `test/config.test.ts`

기본값: reviewer 6개 활성화, `i18n` 비활성화; `report.issueLabel='audit'`, `minSeverity='low'`. audit.yml 파일이 없으면 전체 기본값 사용; 일부만 지정하면 깊은 병합(deep merge) 적용.

- [ ] **Step 1: 실패 테스트 작성**

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
    expect(merged.reviewers.code_hygiene.enabled).toBe(true); // 미지정 → 기본값 유지
    expect(merged.report.issueLabel).toBe('health');
    expect(merged.report.minSeverity).toBe('low');           // 미지정 → 기본값 유지
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

- [ ] **Step 2: 테스트 실행 후 실패 확인**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL(`config.js` 아직 미구현).

- [ ] **Step 3: 구현 작성**

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

- [ ] **Step 4: 테스트 실행 후 통과 확인**

Run: `npx vitest run test/config.test.ts`
Expected: PASS(4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: parse and merge .claude/audit.yml over defaults"
```

---

### Task 3: 분류 `src/classify.ts`

**Files:**
- Create: `src/classify.ts`, `test/classify.test.ts`

입력: 상대 경로 + 콘텐츠 Buffer. 출력: `{ modality, category }`. binary 감지는 앞 8000바이트에 NUL이 포함되는지 확인합니다. lockfile은 파일명으로 판별합니다.

- [ ] **Step 1: 실패 테스트 작성**

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

- [ ] **Step 2: 테스트 실행 후 실패 확인**

Run: `npx vitest run test/classify.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현 작성**

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
  else if (isSpecPath) category = 'spec'; // 경로에 spec/specs 세그먼트 포함; *.spec.ts 오판 방지
  else if (modality === 'vector_diagram' || /(?:^|[-_])flow(?:[-_.]|$)/.test(name)) category = 'flow';
  else if (CODE.has(ext)) category = 'code';
  else if (DOC.has(ext)) category = 'doc';
  else if (CONFIG.has(ext)) category = 'config';
  else category = 'other';

  return { modality, category };
}
```

- [ ] **Step 4: 테스트 실행 후 통과 확인**

Run: `npx vitest run test/classify.test.ts`
Expected: PASS(10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/classify.ts test/classify.test.ts
git commit -m "feat: classify files by modality and category"
```

---

### Task 4: 파일 나열 `src/scan.ts`

**Files:**
- Create: `src/scan.ts`, `test/scan.test.ts`

`git ls-files --cached --others --exclude-standard`로 파일을 나열합니다(.gitignore를 자연스럽게 준수). 상대 POSIX 경로 배열을 반환합니다. lockfile은 파일명 집합으로 판별합니다(상위 레이어에서 표시하기 위한 것이며, 여기서는 제외하지 않음).

- [ ] **Step 1: 실패 테스트 작성**(임시 git repo 사용)

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

- [ ] **Step 2: 테스트 실행 후 실패 확인**

Run: `npx vitest run test/scan.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현 작성**

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

- [ ] **Step 4: 테스트 실행 후 통과 확인**

Run: `npx vitest run test/scan.test.ts`
Expected: PASS(2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scan.ts test/scan.test.ts
git commit -m "feat: list repo files via git, respecting .gitignore"
```

---

### Task 5: 콘텐츠 해시 `src/hash.ts`

**Files:**
- Create: `src/hash.ts`, `test/hash.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

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

- [ ] **Step 2: 테스트 실행 후 실패 확인**

Run: `npx vitest run test/hash.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현 작성**

```ts
// src/hash.ts
import { createHash } from 'node:crypto';

export function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
```

- [ ] **Step 4: 테스트 실행 후 통과 확인**

Run: `npx vitest run test/hash.test.ts`
Expected: PASS(2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hash.ts test/hash.test.ts
git commit -m "feat: sha256 content hashing for duplicate detection"
```

---

### Task 6: git 메타데이터 `src/gitmeta.ts`

**Files:**
- Create: `src/gitmeta.ts`, `test/gitmeta.test.ts`

`Map<path, lastCommitISO>`를 반환합니다. 추적되지 않거나 기록이 없는 파일은 `null`을 반환합니다. 단일 `git log`로 모든 경로의 마지막 커밋 시간(committer date, ISO 8601)을 조회합니다.

- [ ] **Step 1: 실패 테스트 작성**

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

- [ ] **Step 2: 테스트 실행 후 실패 확인**

Run: `npx vitest run test/gitmeta.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현 작성**

```ts
// src/gitmeta.ts
import { execFileSync } from 'node:child_process';

// 각 경로에 대해 마지막 커밋의 committer ISO 시간을 조회합니다. 기록 없으면 null 반환.
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

> 주: 파일별 `git log`는 대형 repo에서 느릴 수 있습니다. Plan 4 e2e에서 병목이 관찰되면 `git log --name-only` 단일 순회 방식으로 최적화합니다. 우선 정확성을 확보합니다.

- [ ] **Step 4: 테스트 실행 후 통과 확인**

Run: `npx vitest run test/gitmeta.test.ts`
Expected: PASS(1 test).

- [ ] **Step 5: Commit**

```bash
git add src/gitmeta.ts test/gitmeta.test.ts
git commit -m "feat: per-file last commit time via git log"
```

---

### Task 7: 참조 그래프 `src/refgraph.ts`

**Files:**
- Create: `src/refgraph.ts`, `test/refgraph.test.ts`

휴리스틱: 각 파일에 대해 어떤 "텍스트 타입" 파일의 본문이 해당 파일의 basename을 언급하는지 찾습니다. `Map<path, referencedBy[]>`를 반환합니다. 고아 감지에 활용됩니다(`referencedBy`가 비어 있으면 고아 후보이며, 최종 판단은 reviewer가 합니다).

- [ ] **Step 1: 실패 테스트 작성**

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
    expect(g.get('assets/orphan.png')).toEqual([]); // 고아
  });

  it('does not count a file referencing itself', () => {
    const files = [
      { path: 'a.md', modality: 'text' as const, content: Buffer.from('a.md title') },
    ];
    expect(buildRefGraph(files).get('a.md')).toEqual([]);
  });
});
```

- [ ] **Step 2: 테스트 실행 후 실패 확인**

Run: `npx vitest run test/refgraph.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현 작성**

```ts
// src/refgraph.ts
import { basename } from 'node:path';
import type { Modality } from './types.js';

interface RefInput { path: string; modality: Modality; content: Buffer; }

// 텍스트 타입 파일만 다른 파일을 "참조"할 수 있습니다. basename 부분 문자열 비교(휴리스틱).
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

- [ ] **Step 4: 테스트 실행 후 통과 확인**

Run: `npx vitest run test/refgraph.test.ts`
Expected: PASS(2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/refgraph.ts test/refgraph.test.ts
git commit -m "feat: build basename reference graph for orphan detection"
```

---

### Task 8: 편성 및 CLI `src/discovery.ts`

**Files:**
- Create: `src/discovery.ts`, `test/discovery.test.ts`

앞서 작성한 모듈들을 조합하여 `Inventory`를 생성합니다. 규범 소스를 탐색합니다(CLAUDE.md, .claude/skills/**, .claude/workflows/**, .github/workflows/**, .claude/audit.yml). CLI: `node src/discovery.ts <repoRoot> [outPath]`, JSON 출력(기본값은 stdout).

- [ ] **Step 1: 실패 테스트 작성**(엔드-투-엔드 임시 repo)

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

- [ ] **Step 2: 테스트 실행 후 실패 확인**

Run: `npx vitest run test/discovery.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현 작성**

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
  // 디렉토리 타입 소스는 이미 나열된 paths에서 prefix로 필터링(git ls-files 재호출 방지)
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

- [ ] **Step 4: 테스트 실행 후 통과 확인**

Run: `npx vitest run test/discovery.test.ts`
Expected: PASS(2 tests).

- [ ] **Step 5: 전체 스위트 + 타입 검사**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 전체 PASS, 타입 오류 없음.

- [ ] **Step 6: Commit**

```bash
git add src/discovery.ts test/discovery.test.ts
git commit -m "feat: orchestrate discovery into Inventory with CLI entrypoint"
```

---

## 완료 정의(Plan 1)

- `npx vitest run` 전체 통과(config/classify/scan/hash/gitmeta/refgraph/discovery)
- `node --import tsx src/discovery.ts <repo>`가 임의의 git repo에 대해 유효한 `Inventory` JSON 출력
- `inventory.json` 필드 완비(modality/category/hash/lastCommitISO/referencedBy/oversizedText + config + conventions)
- LLM 없음, 네트워크 없음

## 다음 단계 연결

`Inventory` 타입은 Plan 2 reviewer의 입력 계약입니다. Plan 2에서는 `findings.json` 스키마 + 검증기를 정의하고, 이 inventory를 claude-code-action 내의 lead/reviewer에 공급합니다.
