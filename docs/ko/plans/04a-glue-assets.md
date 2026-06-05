# Plan 4a — 통합용 결정론적 glue + 나머지 reviewer rubric Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan 4b（재사용 가능한 workflow + composite 서브 action + 라이브 e2e）에 필요한 **결정론적 glue 및 자산**을 보완합니다. `composeRubric`의 `audit.yml` paths glob、`enabledReviewers`（matrix 목록 생성）、reviewer/synthesis의 prompt-bundle 조립、issue 마커 탐색（upsert 순수 로직）、나머지 6개 reviewer의 내장 rubric을 포함합니다. 모두 CI-safe이며 API 호출 없음.

**Architecture:** TS/ESM/vitest를 그대로 사용합니다. 새로 추가되는 항목은 모두 결정론적 TS + 텍스트 자산입니다. workflow/서브 action의 YAML과 라이브 e2e는 Plan 4b에 속합니다.

**Tech Stack:** TypeScript, Node 20, vitest（기존 유지）. 새로운 런타임 의존성 없음（glob은 최소 구현으로 자체 작성하며 패키지를 도입하지 않습니다）.

대응 spec: `../design.md` §1（matrix + sub-action）、§2（rubric/paths）、§5（audit.yml paths）、§4.1（synthesis prompt）.

### 범위 경계（본 plan에서 수행하지 않는 항목）
- `.github/workflows/audit.yml`、`.github/actions/*`、artifact/issue upsert의 gh 호출、라이브 e2e → **Plan 4b**
- issue upsert의 gh API 호출 → 4b（본 plan은 「마커가 포함된 issue 탐색」순수 로직만 수행합니다）

---

## File Structure

```
src/
  rubric.ts        # [개정] glob 매칭 추가, composeRubric이 audit.yml paths 덮어쓰기 지원
  matrix.ts        # [신규] enabledReviewers(config) + CLI（matrix 목록 출력）
  prompt-bundle.ts # [신규] buildReviewerPrompt / buildSynthesisPrompt + CLI（prompt 파일 작성）
  issue.ts         # [신규] findMarkedIssue(issues, marker)（upsert 순수 로직）
reviewers/
  code_hygiene.md  spec_flow.md  visual_icon.md  duplicate_orphan.md  convention.md  i18n.md  # [신규] 나머지 6개 내장 rubric
test/
  rubric-paths.test.ts    matrix.test.ts    prompt-bundle.test.ts    issue.test.ts    all-rubrics.test.ts
```

---

### Task 0: `composeRubric`이 audit.yml `paths` glob 지원

**Files:**
- Modify: `src/rubric.ts`
- Create: `test/rubric-paths.test.ts`

`audit.yml`의 `reviewers.<name>.paths`에 값이 있을 때, target을 glob 매칭으로 교체합니다（category 도메인 대체）. 최소 glob은 자체 구현합니다（`**`=`/` 포함 임의 문자열、`*`=`/` 미포함 임의 문자열、`?`=`/` 미포함 단일 문자）. 패키지를 도입하지 않습니다.

- [ ] **Step 1: 실패 테스트 작성**

```ts
// test/rubric-paths.test.ts
import { describe, it, expect } from 'vitest';
import { composeRubric } from '../src/rubric.js';
import { defaultConfig } from '../src/config.js';
import type { Inventory, FileEntry } from '../src/types.js';

function file(path: string, category: FileEntry['category']): FileEntry {
  return { path, category, modality: 'text', sizeBytes: 1, hash: 'x', oversizedText: false, lastCommitISO: null, referencedBy: [] };
}
function inv(files: FileEntry[], config = defaultConfig()): Inventory {
  return { repoRoot: '/r', generatedAtISO: 't', config, conventions: [], files };
}

describe('composeRubric paths glob override', () => {
  it('uses glob paths instead of category domain when paths set', () => {
    const cfg = defaultConfig();
    cfg.reviewers.visual_icon.paths = ['assets/**'];
    const i = inv([
      file('assets/logo.png', 'visual'),
      file('assets/notes.md', 'doc'),     // doc but under assets/** → included
      file('src/app.ts', 'code'),         // excluded
    ], cfg);
    expect(composeRubric('visual_icon', i, '/a').targetFiles.sort())
      .toEqual(['assets/logo.png', 'assets/notes.md']);
  });

  it('** matches nested; * does not cross /', () => {
    const cfg = defaultConfig();
    cfg.reviewers.docs_staleness.paths = ['**/*.svg'];
    const i = inv([file('a/b/c.svg', 'flow'), file('top.svg', 'flow'), file('a/b.png', 'visual')], cfg);
    expect(composeRubric('docs_staleness', i, '/a').targetFiles.sort()).toEqual(['a/b/c.svg', 'top.svg']);
  });

  it('falls back to category domain when paths empty/absent', () => {
    const i = inv([file('README.md', 'doc'), file('a.ts', 'code')]);
    expect(composeRubric('docs_staleness', i, '/a').targetFiles).toEqual(['README.md']);
  });
});
```

- [ ] **Step 2: 테스트 실행하여 실패 확인**

Run: `npx vitest run test/rubric-paths.test.ts`
Expected: FAIL（현재 composeRubric은 paths를 무시합니다）.

- [ ] **Step 3: `src/rubric.ts` 수정**

`composeRubric` 위에 glob helper를 추가하고, `targetFiles` 로직을 변경합니다. 추가/교체할 전체 내용:

추가（`composeRubric` 함수 앞에 배치）:

```ts
function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegex(g).test(path));
}
```

`composeRubric` 내의 `targetFiles` 줄을 다음으로 교체:

```ts
    targetFiles: inventory.files
      .filter((f) => (cfg?.paths && cfg.paths.length > 0 ? matchesAny(f.path, cfg.paths) : cats.has(f.category)))
      .map((f) => f.path),
```

（`cfg`는 함수 내에서 이미 `inventory.config.reviewers[reviewer]`로 정의되어 있으며, 나머지는 변경하지 않습니다.）

- [ ] **Step 4: 테스트 실행하여 통과 확인**

Run: `npx vitest run test/rubric-paths.test.ts test/rubric.test.ts`
Expected: 두 파일 모두 PASS（기존 rubric.test.ts에 영향 없음）.

- [ ] **Step 5: Commit**

```bash
git add src/rubric.ts test/rubric-paths.test.ts
git commit -m "feat: support audit.yml paths glob override in composeRubric"
```

---

### Task 1: `src/matrix.ts` — 활성화된 reviewer 목록

**Files:**
- Create: `src/matrix.ts`, `test/matrix.test.ts`

`enabledReviewers(config)`는 활성화된 reviewer 이름 목록을 반환합니다（workflow의 matrix로 사용）. CLI는 repo의 config를 읽어 `reviewers=<json>`을 출력합니다（`>> $GITHUB_OUTPUT` 용도）.

- [ ] **Step 1: 실패 테스트 작성**

```ts
// test/matrix.test.ts
import { describe, it, expect } from 'vitest';
import { enabledReviewers } from '../src/matrix.js';
import { defaultConfig } from '../src/config.js';

describe('enabledReviewers', () => {
  it('returns the 6 default-on reviewers (no i18n)', () => {
    expect(enabledReviewers(defaultConfig()).sort()).toEqual(
      ['code_hygiene', 'convention', 'docs_staleness', 'duplicate_orphan', 'spec_flow', 'visual_icon'],
    );
  });
  it('includes i18n when enabled', () => {
    const c = defaultConfig(); c.reviewers.i18n.enabled = true;
    expect(enabledReviewers(c)).toContain('i18n');
  });
  it('excludes a disabled reviewer', () => {
    const c = defaultConfig(); c.reviewers.visual_icon.enabled = false;
    expect(enabledReviewers(c)).not.toContain('visual_icon');
  });
});
```

- [ ] **Step 2: 테스트 실행하여 실패 확인**

Run: `npx vitest run test/matrix.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현 작성**

```ts
// src/matrix.ts
import { writeFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import type { AuditConfig, ReviewerName } from './types.js';

export function enabledReviewers(config: AuditConfig): ReviewerName[] {
  return (Object.keys(config.reviewers) as ReviewerName[]).filter((r) => config.reviewers[r].enabled);
}

// CLI: matrix.ts <repoRoot> [outFile]
// `reviewers=<json-array>` 출력（outFile 없음→stdout；있음→append, `>> $GITHUB_OUTPUT` 용도）
if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const line = `reviewers=${JSON.stringify(enabledReviewers(loadConfig(repoRoot)))}\n`;
  const outFile = process.argv[3];
  if (outFile) writeFileSync(outFile, line, { flag: 'a' });
  else process.stdout.write(line);
}
```

- [ ] **Step 4: 테스트 실행하여 통과 확인**

Run: `npx vitest run test/matrix.test.ts`
Expected: PASS（3 tests）.

- [ ] **Step 5: Commit**

```bash
git add src/matrix.ts test/matrix.test.ts
git commit -m "feat: enabledReviewers + matrix-list CLI"
```

---

### Task 2: `src/prompt-bundle.ts` — reviewer/synthesis prompt 조립

**Files:**
- Create: `src/prompt-bundle.ts`, `test/prompt-bundle.test.ts`

`buildReviewerPrompt`는 다음을 조합합니다: `_reviewer-prompt.md`（`{{REVIEWER}}` 치환）＋내장 rubric 내용＋규범 출처 목록＋（선택）덮어쓰기 rubric＋target 파일 목록. `buildSynthesisPrompt`는 `_synthesis-prompt.md`를 반환합니다. CLI는 reviewer prompt를 파일로 작성합니다（workflow에서 claude-code-action에 전달하기 위해）.

- [ ] **Step 1: 실패 테스트 작성**

```ts
// test/prompt-bundle.test.ts
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { buildReviewerPrompt, buildSynthesisPrompt } from '../src/prompt-bundle.js';
import { defaultConfig } from '../src/config.js';
import type { Inventory, FileEntry } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

function file(path: string, category: FileEntry['category']): FileEntry {
  return { path, category, modality: 'text', sizeBytes: 1, hash: 'x', oversizedText: false, lastCommitISO: null, referencedBy: [] };
}
const inv: Inventory = {
  repoRoot: '/r', generatedAtISO: 't', config: defaultConfig(),
  conventions: [{ path: 'CLAUDE.md', kind: 'claude_md' }],
  files: [file('README.md', 'doc'), file('src/a.ts', 'code')],
};

describe('buildReviewerPrompt', () => {
  it('embeds reviewer name, builtin rubric, convention source, and target files', () => {
    const p = buildReviewerPrompt('docs_staleness', inv, ROOT);
    expect(p).toContain('docs_staleness');
    expect(p).toMatch(/multi|多語/);        // 来自 docs_staleness 内建 rubric
    expect(p).toContain('CLAUDE.md');        // 규범 출처
    expect(p).toContain('README.md');        // target（doc）
    expect(p).not.toContain('src/a.ts');     // docs_staleness 도메인 외
    expect(p).toContain('findings/');        // _reviewer-prompt 템플릿에서 유래
    expect(p).not.toContain('{{REVIEWER}}'); // 치환 완료
  });
});

describe('buildSynthesisPrompt', () => {
  it('returns the synthesis template', () => {
    expect(buildSynthesisPrompt(ROOT)).toContain('synthesis.json');
  });
});
```

- [ ] **Step 2: 테스트 실행하여 실패 확인**

Run: `npx vitest run test/prompt-bundle.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현 작성**

```ts
// src/prompt-bundle.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeRubric } from './rubric.js';
import type { Inventory, ReviewerName } from './types.js';

export function buildReviewerPrompt(reviewer: ReviewerName, inventory: Inventory, actionRoot: string): string {
  const bundle = composeRubric(reviewer, inventory, actionRoot);
  const template = readFileSync(join(actionRoot, 'reviewers', '_reviewer-prompt.md'), 'utf8')
    .replaceAll('{{REVIEWER}}', reviewer);
  const builtin = readFileSync(bundle.builtinRubric, 'utf8');

  const parts = [
    template,
    '\n\n## 你的內建 rubric\n',
    builtin,
    '\n\n## repo 規範來源（請讀；衝突時優先於內建）\n',
    bundle.conventionSources.length ? bundle.conventionSources.map((p) => `- ${p}`).join('\n') : '（無）',
  ];
  if (bundle.explicitRubric) {
    parts.push('\n\n## audit.yml 覆蓋 rubric（最高優先，請讀）\n', `- ${bundle.explicitRubric}`);
  }
  parts.push(
    '\n\n## 你的 target 檔（只審這些）\n',
    bundle.targetFiles.length ? bundle.targetFiles.map((p) => `- ${p}`).join('\n') : '（無；輸出 status:"ok", findings:[]）',
  );
  return parts.join('');
}

export function buildSynthesisPrompt(actionRoot: string): string {
  return readFileSync(join(actionRoot, 'reviewers', '_synthesis-prompt.md'), 'utf8');
}

// CLI: prompt-bundle.ts <reviewer> <inventoryJson> <outFile>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [reviewer, invPath, outFile] = process.argv.slice(2);
  const inventory = JSON.parse(readFileSync(invPath, 'utf8')) as Inventory;
  const actionRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
  writeFileSync(outFile, buildReviewerPrompt(reviewer as ReviewerName, inventory, actionRoot));
}
```

- [ ] **Step 4: 테스트 실행하여 통과 확인**

Run: `npx vitest run test/prompt-bundle.test.ts`
Expected: PASS（2 tests）.

- [ ] **Step 5: Commit**

```bash
git add src/prompt-bundle.ts test/prompt-bundle.test.ts
git commit -m "feat: assemble reviewer/synthesis prompts from template + rubric + targets"
```

---

### Task 3: 나머지 6개 reviewer 내장 rubric

**Files:**
- Create: `reviewers/code_hygiene.md`, `reviewers/spec_flow.md`, `reviewers/visual_icon.md`, `reviewers/duplicate_orphan.md`, `reviewers/convention.md`, `reviewers/i18n.md`
- Create: `test/all-rubrics.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

```ts
// test/all-rubrics.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeRubric } from '../src/rubric.js';
import { defaultConfig } from '../src/config.js';
import type { Inventory, ReviewerName } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const inv: Inventory = { repoRoot: '/r', generatedAtISO: 't', config: defaultConfig(), conventions: [], files: [] };
const ALL: ReviewerName[] = ['docs_staleness', 'code_hygiene', 'spec_flow', 'visual_icon', 'duplicate_orphan', 'convention', 'i18n'];

describe('all reviewer rubrics exist', () => {
  it('every reviewer has a builtin rubric file at the composed path', () => {
    for (const r of ALL) {
      expect(existsSync(composeRubric(r, inv, ROOT).builtinRubric), r).toBe(true);
    }
  });
  it('each rubric states the no-edit + SSOT discipline', () => {
    for (const r of ALL) {
      const text = readFileSync(join(ROOT, 'reviewers', `${r}.md`), 'utf8');
      expect(text, r).toMatch(/不要改|不修改|只報告/);
      expect(text, r).toMatch(/ssot_direction|SSOT|分歧/);
    }
  });
  it('convention rubric references repo self-standards; i18n references localization', () => {
    expect(readFileSync(join(ROOT, 'reviewers/convention.md'), 'utf8')).toMatch(/CLAUDE\.md|skills|workflows/);
    expect(readFileSync(join(ROOT, 'reviewers/i18n.md'), 'utf8')).toMatch(/在地化|Localizable|\.lproj|翻譯/);
  });
});
```

- [ ] **Step 2: 테스트 실행하여 실패 확인**

Run: `npx vitest run test/all-rubrics.test.ts`
Expected: FAIL（파일 6개 미존재）.

- [ ] **Step 3: 6개 rubric 파일 생성**

`reviewers/code_hygiene.md`:

```markdown
# code_hygiene — 內建 rubric

你是程式碼衛生 reviewer。對指派給你的原始碼檔，找出：

## 抓什麼
- **死碼／用不到的檔或函式**：未被任何地方引用的 export、檔案、私有函式（用 inventory 的 referencedBy 當線索）。
- **與 spec 不符**：實作與對應 spec/設計文件描述不一致。
- **明顯壞味道**：重複邏輯、未處理的錯誤路徑、與既有風格明顯不符處（以 repo 自身慣例為準）。

## SSOT 原則
偵測「分歧」即可，不預設 code 或 spec 哪邊才對；附證據（git 近期度、引用關係）。不確定方向標 `ssot_direction: "uncertain"`。

## 不要做
- 不要改檔（只報告）。不要為純風格偏好開 finding（除非違反 repo 明文慣例）。
```

`reviewers/spec_flow.md`:

```markdown
# spec_flow — 內建 rubric

你是 spec／流程 reviewer。對指派給你的 spec、流程圖（mermaid/dot/svg 等）、狀態機，找出：

## 抓什麼
- **flow 與實作不一致**：流程圖/狀態機描述的步驟、分支、狀態與真實 code 不符。
- **spec 過時**：spec 描述的行為、介面、決策已被 code 推翻。
- **內部矛盾**：同一份 spec 前後不一致。

## SSOT 原則
不預設 spec 一定是真實來源——**有時過時的反而是 spec 本身**。只報分歧、附證據（git 近期度、引用），方向不明確標 `ssot_direction: "uncertain"`。

## 不要做
- 不要改檔（只報告）。
```

`reviewers/visual_icon.md`:

```markdown
# visual_icon — 內建 rubric

你是視覺／icon reviewer。對指派給你的圖片、icon、設計稿，找出：

## 抓什麼
- **未使用素材（孤兒）**：沒有任何檔引用的圖（用 inventory 的 referencedBy）。
- **重複圖**：內容相同（用 inventory 的 hash）或明顯重複的素材。
- **命名/尺寸不符規範**：與 repo 設計規範（若有）或常見約定不符。

## 注意
多數判斷不需「看」圖：孤兒看 referencedBy、重複看 hash、命名看路徑。只有「圖內容是否符合設計/spec」才需要視覺判斷。

## SSOT 原則
只報分歧、附證據；不確定標 `ssot_direction: "uncertain"`（多數視覺問題為 `n/a`）。

## 不要做
- 不要改檔或刪檔（只報告）。
```

`reviewers/duplicate_orphan.md`:

```markdown
# duplicate_orphan — 內建 rubric

你是重複／孤兒檔 reviewer，看全 repo。找出：

## 抓什麼
- **重複檔**：內容相同（inventory 的 hash 相同）或高度重複、應合併的檔。
- **孤兒檔**：沒有任何檔引用、看似已無用的資源（inventory 的 referencedBy 為空是強線索，但需判斷是否為合理的進入點如 README/設定檔）。
- **無人引用的資產**：被遺留的暫存/實驗檔。

## SSOT 原則
報「疑似重複/孤兒」並附證據（hash、referencedBy）；入口檔（README、LICENSE、設定）referencedBy 空屬正常，勿誤報。category 多為 `duplicate`/`orphan`，`ssot_direction` 多為 `n/a`。

## 不要做
- 不要刪檔（只報告）。
```

`reviewers/convention.md`:

```markdown
# convention — 內建 rubric

你是規範遵循 reviewer，看全 repo。判斷依據**幾乎全來自 repo 自身規範**：`CLAUDE.md`、`.claude/skills/`、`.claude/workflows/`、`.github/workflows/`、以及其他慣例文件（這些已列在你的「repo 規範來源」中，請讀）。

## 抓什麼
- 違反 repo 自身宣告的規範、流程、命名、結構約定之處。
- 與 repo 既定 SOP/skills 不一致的實作或文件。

## SSOT 原則
以 repo 自身規範為對照；只報違反處並引用是哪條規範（附證據）。規範本身可能過時——若 code 與規範分歧但證據顯示規範較舊，標 `ssot_direction: "uncertain"` 交人判斷。

## 不要做
- 不要改檔（只報告）。不要套用你自己的偏好——只依 repo 明文規範。
```

`reviewers/i18n.md`:

```markdown
# i18n — 內建 rubric（預設關閉）

你是在地化 reviewer。對指派給你的在地化資源（如 `Localizable.strings`、`.lproj/`、i18n JSON、多語文件）找出：

## 抓什麼
- **缺翻譯**：base 語言有、其他語言缺的 key。
- **未使用 key**：定義了但 code/文件未引用的在地化 key。
- **與 base 不同步**：翻譯落後 base 的新增/修改。

> 註：多語 **README/doc** 的同步由 `docs_staleness` 負責；本 reviewer 專注 code 層在地化字串。

## SSOT 原則
base 通常為真實來源，但仍附證據（git 近期度）；方向不明確標 `ssot_direction: "uncertain"`。

## 不要做
- 不要改檔或補翻譯（只報告）。
```

- [ ] **Step 4: 테스트 실행하여 통과 확인**

Run: `npx vitest run test/all-rubrics.test.ts`
Expected: PASS（3 tests, 7개 reviewer 포함）.

- [ ] **Step 5: Commit**

```bash
git add reviewers/code_hygiene.md reviewers/spec_flow.md reviewers/visual_icon.md reviewers/duplicate_orphan.md reviewers/convention.md reviewers/i18n.md test/all-rubrics.test.ts
git commit -m "feat: builtin rubrics for the remaining 6 reviewers"
```

---

### Task 4: `src/issue.ts` — 마커가 있는 기존 issue 탐색（upsert 순수 로직）

**Files:**
- Create: `src/issue.ts`, `test/issue.test.ts`

순수 로직만 구현합니다: issue 목록（number + body）을 받아 body에 `ISSUE_MARKER`가 포함된 첫 번째 number를 반환합니다（4b에서 update 또는 create 여부 결정에 사용）. 실제 gh API 호출은 4b에 속합니다.

- [ ] **Step 1: 실패 테스트 작성**

```ts
// test/issue.test.ts
import { describe, it, expect } from 'vitest';
import { findMarkedIssue } from '../src/issue.js';
import { ISSUE_MARKER } from '../src/report-issue.js';

describe('findMarkedIssue', () => {
  const marked = { number: 7, body: `intro\n${ISSUE_MARKER}\nbody` };
  it('returns the number of the issue containing the marker', () => {
    expect(findMarkedIssue([{ number: 1, body: 'x' }, marked], ISSUE_MARKER)).toBe(7);
  });
  it('returns null when no issue carries the marker', () => {
    expect(findMarkedIssue([{ number: 1, body: 'x' }], ISSUE_MARKER)).toBeNull();
  });
  it('returns the first match when several carry the marker', () => {
    expect(findMarkedIssue([{ number: 3, body: ISSUE_MARKER }, { number: 5, body: ISSUE_MARKER }], ISSUE_MARKER)).toBe(3);
  });
  it('tolerates missing/null body', () => {
    expect(findMarkedIssue([{ number: 1 } as unknown as { number: number; body: string }], ISSUE_MARKER)).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트 실행하여 실패 확인**

Run: `npx vitest run test/issue.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현 작성**

```ts
// src/issue.ts
export interface IssueRef {
  number: number;
  body: string;
}

// body에 marker가 포함된 첫 번째 issue number를 반환합니다. 없으면 null.
export function findMarkedIssue(issues: IssueRef[], marker: string): number | null {
  const hit = issues.find((i) => typeof i.body === 'string' && i.body.includes(marker));
  return hit ? hit.number : null;
}
```

- [ ] **Step 4: 테스트 실행하여 통과 확인**

Run: `npx vitest run test/issue.test.ts`
Expected: PASS（4 tests）.

- [ ] **Step 5: 전체 테스트 스위트 + 타입 검사**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 전체 PASS, 타입 오류 없음.

- [ ] **Step 6: Commit**

```bash
git add src/issue.ts test/issue.test.ts
git commit -m "feat: findMarkedIssue for report issue upsert logic"
```

---

## 완료 정의（Plan 4a）

- `npx vitest run` 전체 녹색（rubric-paths/matrix/prompt-bundle/all-rubrics/issue + 기존）
- `composeRubric`은 `audit.yml`에 `paths`가 있을 때 glob으로 target을 선택하고, 없을 때는 category 도메인을 그대로 사용합니다
- `enabledReviewers`가 matrix 목록을 올바르게 생성하고, `buildReviewerPrompt`/`buildSynthesisPrompt`가 claude-code-action에 전달 가능한 prompt를 출력합니다
- 7명의 reviewer 모두 내장 rubric을 갖추고 있으며, no-edit + SSOT 원칙이 포함됩니다
- `findMarkedIssue`가 upsert 순수 로직을 제공합니다
- API 없음, 네트워크 없음

## Plan 4b 연결

4b는 본 plan의 `matrix`/`prompt-bundle`/`issue`와 Plan 1-3의 `discovery`/`report`를 사용하여 다음을 작성합니다:
1. `.github/actions/{discovery,reviewer,synthesis,report}/action.yml`（composite, 자체 upkeep 코드 포함: `npm ci` + `node --import tsx ...` + 필요한 claude-code-action / gh / upload-artifact）.
2. `.github/workflows/audit.yml`（`on: workflow_call`）: `discovery` job이 matrix 목록 생성 → `review` matrix job（`fail-fast:false`）각 reviewer가 `findings/<r>.json` 작성 후 artifact 업로드 → `synthesis` job（`continue-on-error`）→ `report` job（`if: always()`）통합+렌더링+gh issue upsert+artifact.
3. README job-level `uses:` 사용법 + 권한/secret.
4. `wei18/Sudoku`에서 라이브 e2e 실행: claude-code-action이 prompt에 따라 규격에 맞는 `findings/<r>.json`을 작성하고, 리포트와 issue가 올바르게 생성되는지 검증합니다.
