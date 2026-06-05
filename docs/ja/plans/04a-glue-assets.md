# Plan 4a — 統合用確定的 glue + その他 reviewer rubric 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan 4b（reusable workflow + composite 子 action + ライブ e2e）に必要な**確定的 glue とアセット**を整備します。対象は `composeRubric` の `audit.yml` paths glob、`enabledReviewers`（matrix リスト生成）、reviewer/synthesis の prompt-bundle 組み立て、issue マーカー検索（upsert の純粋ロジック）、その他 6 名の reviewer 内蔵 rubric です。すべて CI-safe・ゼロ API で動作します。

**Architecture:** TS/ESM/vitest を継続使用します。追加するのはすべて確定的 TS とテキストアセットです。workflow/子 action の YAML とライブ e2e は Plan 4b の範囲です。

**Tech Stack:** TypeScript, Node 20, vitest（継続使用）。新規 runtime 依存なし（glob は最小実装を自作し、パッケージは追加しません）。

対応 spec：`../design.md` §1（matrix + sub-action）、§2（rubric/paths）、§5（audit.yml paths）、§4.1（synthesis prompt）。

### 範囲の境界（本 plan では行いません）
- `.github/workflows/audit.yml`、`.github/actions/*`、artifact/issue upsert の gh 呼び出し、ライブ e2e → **Plan 4b**
- issue upsert の gh API 呼び出し → 4b（本 plan では純粋な「マーカー付き issue の検索」ロジックのみ実装します）

---

## File Structure

```
src/
  rubric.ts        # [改] glob 比較を追加、composeRubric が audit.yml paths オーバーライドをサポート
  matrix.ts        # [新] enabledReviewers(config) + CLI（matrix リスト生成）
  prompt-bundle.ts # [新] buildReviewerPrompt / buildSynthesisPrompt + CLI（prompt ファイル書き出し）
  issue.ts         # [新] findMarkedIssue(issues, marker)（upsert 純粋ロジック）
reviewers/
  code_hygiene.md  spec_flow.md  visual_icon.md  duplicate_orphan.md  convention.md  i18n.md  # [新] その他 6 名の内蔵 rubric
test/
  rubric-paths.test.ts    matrix.test.ts    prompt-bundle.test.ts    issue.test.ts    all-rubrics.test.ts
```

---

### Task 0: `composeRubric` が audit.yml `paths` glob をサポート

**Files:**
- Modify: `src/rubric.ts`
- Create: `test/rubric-paths.test.ts`

`audit.yml` の `reviewers.<name>.paths` に値が設定されている場合、target の絞り込みを glob 比較に切り替えます（category ドメインの代替）。glob は最小実装を自作し（`**`=任意の `/` を含む文字列、`*`=`/` を含まない任意の文字列、`?`=`/` を含まない任意の 1 文字）、パッケージは使いません。

- [ ] **Step 1: 失敗するテストを書く**

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

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run test/rubric-paths.test.ts`
Expected: FAIL（現在の composeRubric は paths を無視しています）。

- [ ] **Step 3: `src/rubric.ts` を修正する**

`composeRubric` の前に glob helper を追加し、`targetFiles` のロジックを変更します。追加・置換する内容は以下のとおりです。

追加（`composeRubric` 関数の前に配置）：

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

`composeRubric` 内の `targetFiles` の行を以下に置き換えます：

```ts
    targetFiles: inventory.files
      .filter((f) => (cfg?.paths && cfg.paths.length > 0 ? matchesAny(f.path, cfg.paths) : cats.has(f.category)))
      .map((f) => f.path),
```

（`cfg` は関数内で `inventory.config.reviewers[reviewer]` として定義済みです。その他は変更しません。）

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx vitest run test/rubric-paths.test.ts test/rubric.test.ts`
Expected: 両ファイルすべて PASS（既存の rubric.test.ts に影響なし）。

- [ ] **Step 5: Commit**

```bash
git add src/rubric.ts test/rubric-paths.test.ts
git commit -m "feat: support audit.yml paths glob override in composeRubric"
```

---

### Task 1: `src/matrix.ts` — 有効な reviewer リスト

**Files:**
- Create: `src/matrix.ts`, `test/matrix.test.ts`

`enabledReviewers(config)` は有効な reviewer の名前一覧を返します（workflow の matrix として使用）。CLI は repo の config を読み込み `reviewers=<json>` を出力します（`>> $GITHUB_OUTPUT` に使用）。

- [ ] **Step 1: 失敗するテストを書く**

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

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run test/matrix.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装を書く**

```ts
// src/matrix.ts
import { writeFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import type { AuditConfig, ReviewerName } from './types.js';

export function enabledReviewers(config: AuditConfig): ReviewerName[] {
  return (Object.keys(config.reviewers) as ReviewerName[]).filter((r) => config.reviewers[r].enabled);
}

// CLI: matrix.ts <repoRoot> [outFile]
// 印出 `reviewers=<json-array>`（無 outFile→stdout；有→append，供 >> $GITHUB_OUTPUT）
if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const line = `reviewers=${JSON.stringify(enabledReviewers(loadConfig(repoRoot)))}\n`;
  const outFile = process.argv[3];
  if (outFile) writeFileSync(outFile, line, { flag: 'a' });
  else process.stdout.write(line);
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx vitest run test/matrix.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/matrix.ts test/matrix.test.ts
git commit -m "feat: enabledReviewers + matrix-list CLI"
```

---

### Task 2: `src/prompt-bundle.ts` — reviewer/synthesis prompt の組み立て

**Files:**
- Create: `src/prompt-bundle.ts`, `test/prompt-bundle.test.ts`

`buildReviewerPrompt` は次の要素を結合します：`_reviewer-prompt.md`（`{{REVIEWER}}` を置換）＋内蔵 rubric の内容＋規範ソースリスト＋（任意）オーバーライド rubric＋target ファイルリスト。`buildSynthesisPrompt` は `_synthesis-prompt.md` を返します。CLI は reviewer prompt をファイルに書き出します（workflow から claude-code-action に渡すために使用）。

- [ ] **Step 1: 失敗するテストを書く**

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
    expect(p).toMatch(/multi|多語/);        // 來自 docs_staleness 內建 rubric
    expect(p).toContain('CLAUDE.md');        // 規範來源
    expect(p).toContain('README.md');        // target（doc）
    expect(p).not.toContain('src/a.ts');     // 非 docs_staleness 領域
    expect(p).toContain('findings/');        // 來自 _reviewer-prompt 範本
    expect(p).not.toContain('{{REVIEWER}}'); // 已替換
  });
});

describe('buildSynthesisPrompt', () => {
  it('returns the synthesis template', () => {
    expect(buildSynthesisPrompt(ROOT)).toContain('synthesis.json');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run test/prompt-bundle.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装を書く**

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

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx vitest run test/prompt-bundle.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/prompt-bundle.ts test/prompt-bundle.test.ts
git commit -m "feat: assemble reviewer/synthesis prompts from template + rubric + targets"
```

---

### Task 3: その他 6 名の reviewer 内蔵 rubric

**Files:**
- Create: `reviewers/code_hygiene.md`, `reviewers/spec_flow.md`, `reviewers/visual_icon.md`, `reviewers/duplicate_orphan.md`, `reviewers/convention.md`, `reviewers/i18n.md`
- Create: `test/all-rubrics.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

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

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run test/all-rubrics.test.ts`
Expected: FAIL（6 ファイルが存在しません）。

- [ ] **Step 3: 6 つの rubric ファイルを作成する**

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

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx vitest run test/all-rubrics.test.ts`
Expected: PASS（3 tests、7 名すべてを対象）。

- [ ] **Step 5: Commit**

```bash
git add reviewers/code_hygiene.md reviewers/spec_flow.md reviewers/visual_icon.md reviewers/duplicate_orphan.md reviewers/convention.md reviewers/i18n.md test/all-rubrics.test.ts
git commit -m "feat: builtin rubrics for the remaining 6 reviewers"
```

---

### Task 4: `src/issue.ts` — マーカー付き既存 issue の検索（upsert 純粋ロジック）

**Files:**
- Create: `src/issue.ts`, `test/issue.test.ts`

純粋なロジックのみ実装します。issue のリスト（number + body）を受け取り、body に `ISSUE_MARKER` を含む最初の number を返します（4b で update か create かを判断するために使用）。実際の gh API 呼び出しは 4b の範囲です。

- [ ] **Step 1: 失敗するテストを書く**

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

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run test/issue.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装を書く**

```ts
// src/issue.ts
export interface IssueRef {
  number: number;
  body: string;
}

// 回傳第一個 body 含 marker 的 issue number；無則 null。
export function findMarkedIssue(issues: IssueRef[], marker: string): number | null {
  const hit = issues.find((i) => typeof i.body === 'string' && i.body.includes(marker));
  return hit ? hit.number : null;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx vitest run test/issue.test.ts`
Expected: PASS（4 tests）。

- [ ] **Step 5: 全テストスイート + 型チェック**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全 PASS・型エラーなし。

- [ ] **Step 6: Commit**

```bash
git add src/issue.ts test/issue.test.ts
git commit -m "feat: findMarkedIssue for report issue upsert logic"
```

---

## 完了定義（Plan 4a）

- `npx vitest run` 全グリーン（rubric-paths/matrix/prompt-bundle/all-rubrics/issue + 既存テスト）
- `composeRubric` は `audit.yml` に `paths` がある場合は glob でターゲットを絞り込み、ない場合は category ドメインを継続使用
- `enabledReviewers` が正しく matrix リストを生成し、`buildReviewerPrompt`/`buildSynthesisPrompt` が claude-code-action に渡せる prompt を出力
- 7 名の reviewer すべてに内蔵 rubric があり、no-edit + SSOT 規律を含む
- `findMarkedIssue` が upsert 純粋ロジックを提供
- ゼロ API・ゼロネットワーク

## Plan 4b との接続

4b では本 plan の `matrix`/`prompt-bundle`/`issue` と Plan 1-3 の `discovery`/`report` を使用し、以下を実装します。
1. `.github/actions/{discovery,reviewer,synthesis,report}/action.yml`（composite、upkeep コードを内包：`npm ci` + `node --import tsx ...` + 必要な claude-code-action / gh / upload-artifact）。
2. `.github/workflows/audit.yml`（`on: workflow_call`）：`discovery` job が matrix リストを生成 → `review` matrix job（`fail-fast:false`）が各 reviewer の `findings/<r>.json` を出力してアーティファクトにアップロード → `synthesis` job（`continue-on-error`）→ `report` job（`if: always()`）が consolidate+render+gh issue upsert+artifact を実行。
3. README に job レベルの `uses:` 使用例と権限/secret の説明を追加。
4. `wei18/Sudoku` に対してライブ e2e を実行し、claude-code-action が prompt に従って適正な `findings/<r>.json` を出力し、レポートと issue が正しく生成されることを検証。
```
