# Plan 4a — 整合用确定性 glue + 其余 reviewer rubric Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 Plan 4b（reusable workflow + composite 子 action + 直播 e2e）所需的**确定性 glue 与资产**：`composeRubric` 的 `audit.yml` paths glob、`enabledReviewers`（生成 matrix 清单）、reviewer/synthesis 的 prompt-bundle 组装、issue 标记查找（upsert 的纯逻辑）、其余 6 位 reviewer 的内置 rubric。全部 CI-safe、零 API。

**Architecture:** 沿用 TS/ESM/vitest。新增均为确定性 TS + 文字资产。workflow/子 action 的 YAML 与直播 e2e 属 Plan 4b。

**Tech Stack:** TypeScript, Node 20, vitest（沿用）。无新增 runtime 依赖（glob 自写最小实现，不引入包）。

对应 spec：`../design.md` §1（matrix + sub-action）、§2（rubric/paths）、§5（audit.yml paths）、§4.1（synthesis prompt）。

### 范围边界（本 plan 不做）
- `.github/workflows/audit.yml`、`.github/actions/*`、artifact/issue upsert 的 gh 调用、直播 e2e → **Plan 4b**
- issue upsert 的 gh API 调用 → 4b（本 plan 只做纯粹的「找出带标记的 issue」逻辑）

---

## File Structure

```
src/
  rubric.ts        # [改] 加 glob 比对，composeRubric 支援 audit.yml paths 覆盖
  matrix.ts        # [新] enabledReviewers(config) + CLI（产 matrix 清单）
  prompt-bundle.ts # [新] buildReviewerPrompt / buildSynthesisPrompt + CLI（写 prompt 文件）
  issue.ts         # [新] findMarkedIssue(issues, marker)（upsert 纯逻辑）
reviewers/
  code_hygiene.md  spec_flow.md  visual_icon.md  duplicate_orphan.md  convention.md  i18n.md  # [新] 其余 6 位内置 rubric
test/
  rubric-paths.test.ts    matrix.test.ts    prompt-bundle.test.ts    issue.test.ts    all-rubrics.test.ts
```

---

### Task 0: `composeRubric` 支持 audit.yml `paths` glob

**Files:**
- Modify: `src/rubric.ts`
- Create: `test/rubric-paths.test.ts`

当 `audit.yml` 的 `reviewers.<name>.paths` 有值时，target 改用 glob 匹配（取代 category 领域）。自写最小 glob（`**`=任意含 `/`、`*`=任意不含 `/`、`?`=单一不含 `/`），不引入包。

- [ ] **Step 1: 写失败测试**

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

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/rubric-paths.test.ts`
Expected: FAIL（当前 composeRubric 忽略 paths）。

- [ ] **Step 3: 改 `src/rubric.ts`**

在 `composeRubric` 之上新增 glob helper，并改 `targetFiles` 逻辑。完整新增/替换内容：

新增（放在 `composeRubric` 函数之前）：

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

把 `composeRubric` 内 `targetFiles` 那行替换为：

```ts
    targetFiles: inventory.files
      .filter((f) => (cfg?.paths && cfg.paths.length > 0 ? matchesAny(f.path, cfg.paths) : cats.has(f.category)))
      .map((f) => f.path),
```

（`cfg` 已在函数内定义为 `inventory.config.reviewers[reviewer]`，保持其余不变。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/rubric-paths.test.ts test/rubric.test.ts`
Expected: 两文件全 PASS（既有 rubric.test.ts 不受影响）。

- [ ] **Step 5: Commit**

```bash
git add src/rubric.ts test/rubric-paths.test.ts
git commit -m "feat: support audit.yml paths glob override in composeRubric"
```

---

### Task 1: `src/matrix.ts` — 启用的 reviewer 清单

**Files:**
- Create: `src/matrix.ts`, `test/matrix.test.ts`

`enabledReviewers(config)` 返回启用的 reviewer 名单（给 workflow 当 matrix）。CLI 读取 repo 的 config 输出 `reviewers=<json>`（供 `>> $GITHUB_OUTPUT`）。

- [ ] **Step 1: 写失败测试**

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

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/matrix.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写实现**

```ts
// src/matrix.ts
import { writeFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import type { AuditConfig, ReviewerName } from './types.js';

export function enabledReviewers(config: AuditConfig): ReviewerName[] {
  return (Object.keys(config.reviewers) as ReviewerName[]).filter((r) => config.reviewers[r].enabled);
}

// CLI: matrix.ts <repoRoot> [outFile]
// 印出 `reviewers=<json-array>`（无 outFile→stdout；有→append，供 >> $GITHUB_OUTPUT）
if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const line = `reviewers=${JSON.stringify(enabledReviewers(loadConfig(repoRoot)))}\n`;
  const outFile = process.argv[3];
  if (outFile) writeFileSync(outFile, line, { flag: 'a' });
  else process.stdout.write(line);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/matrix.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/matrix.ts test/matrix.test.ts
git commit -m "feat: enabledReviewers + matrix-list CLI"
```

---

### Task 2: `src/prompt-bundle.ts` — 组装 reviewer/synthesis prompt

**Files:**
- Create: `src/prompt-bundle.ts`, `test/prompt-bundle.test.ts`

`buildReviewerPrompt` 组合：`_reviewer-prompt.md`（替换 `{{REVIEWER}}`）+ 内置 rubric 内容 + 规范来源清单 +（可选）覆盖 rubric + target 文件清单。`buildSynthesisPrompt` 返回 `_synthesis-prompt.md`。CLI 把 reviewer prompt 写到文件（供 workflow 喂给 claude-code-action）。

- [ ] **Step 1: 写失败测试**

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
    expect(p).toMatch(/multi|多语/);        // 来自 docs_staleness 内置 rubric
    expect(p).toContain('CLAUDE.md');        // 规范来源
    expect(p).toContain('README.md');        // target（doc）
    expect(p).not.toContain('src/a.ts');     // 非 docs_staleness 领域
    expect(p).toContain('findings/');        // 来自 _reviewer-prompt 模板
    expect(p).not.toContain('{{REVIEWER}}'); // 已替换
  });
});

describe('buildSynthesisPrompt', () => {
  it('returns the synthesis template', () => {
    expect(buildSynthesisPrompt(ROOT)).toContain('synthesis.json');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/prompt-bundle.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写实现**

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
    '\n\n## 你的内置 rubric\n',
    builtin,
    '\n\n## repo 规范来源（请读；冲突时优先于内置）\n',
    bundle.conventionSources.length ? bundle.conventionSources.map((p) => `- ${p}`).join('\n') : '（无）',
  ];
  if (bundle.explicitRubric) {
    parts.push('\n\n## audit.yml 覆盖 rubric（最高优先，请读）\n', `- ${bundle.explicitRubric}`);
  }
  parts.push(
    '\n\n## 你的 target 文件（只审这些）\n',
    bundle.targetFiles.length ? bundle.targetFiles.map((p) => `- ${p}`).join('\n') : '（无；输出 status:"ok", findings:[]）',
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

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/prompt-bundle.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/prompt-bundle.ts test/prompt-bundle.test.ts
git commit -m "feat: assemble reviewer/synthesis prompts from template + rubric + targets"
```

---

### Task 3: 其余 6 位 reviewer 内置 rubric

**Files:**
- Create: `reviewers/code_hygiene.md`, `reviewers/spec_flow.md`, `reviewers/visual_icon.md`, `reviewers/duplicate_orphan.md`, `reviewers/convention.md`, `reviewers/i18n.md`
- Create: `test/all-rubrics.test.ts`

- [ ] **Step 1: 写失败测试**

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
      expect(text, r).toMatch(/不要改|不修改|只报告/);
      expect(text, r).toMatch(/ssot_direction|SSOT|分歧/);
    }
  });
  it('convention rubric references repo self-standards; i18n references localization', () => {
    expect(readFileSync(join(ROOT, 'reviewers/convention.md'), 'utf8')).toMatch(/CLAUDE\.md|skills|workflows/);
    expect(readFileSync(join(ROOT, 'reviewers/i18n.md'), 'utf8')).toMatch(/在地化|Localizable|\.lproj|翻译/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/all-rubrics.test.ts`
Expected: FAIL（6 个文件不存在）。

- [ ] **Step 3: 创建 6 个 rubric 文件**

`reviewers/code_hygiene.md`:

```markdown
# code_hygiene — 内置 rubric

你是代码卫生 reviewer。对分配给你的源码文件，找出：

## 抓什么
- **死码／用不到的文件或函数**：未被任何地方引用的 export、文件、私有函数（用 inventory 的 referencedBy 当线索）。
- **与 spec 不符**：实现与对应 spec/设计文档描述不一致。
- **明显坏味道**：重复逻辑、未处理的错误路径、与既有风格明显不符处（以 repo 自身惯例为准）。

## SSOT 原则
检测「分歧」即可，不预设 code 或 spec 哪边才对；附证据（git 近期度、引用关系）。不确定方向标 `ssot_direction: "uncertain"`。

## 不要做
- 不要改文件（只报告）。不要为纯风格偏好开 finding（除非违反 repo 明文惯例）。
```

`reviewers/spec_flow.md`:

```markdown
# spec_flow — 内置 rubric

你是 spec／流程 reviewer。对分配给你的 spec、流程图（mermaid/dot/svg 等）、状态机，找出：

## 抓什么
- **flow 与实现不一致**：流程图/状态机描述的步骤、分支、状态与真实 code 不符。
- **spec 过时**：spec 描述的行为、接口、决策已被 code 推翻。
- **内部矛盾**：同一份 spec 前后不一致。

## SSOT 原则
不预设 spec 一定是真实来源——**有时过时的反而是 spec 本身**。只报分歧、附证据（git 近期度、引用），方向不明确标 `ssot_direction: "uncertain"`。

## 不要做
- 不要改文件（只报告）。
```

`reviewers/visual_icon.md`:

```markdown
# visual_icon — 内置 rubric

你是视觉／icon reviewer。对分配给你的图片、icon、设计稿，找出：

## 抓什么
- **未使用素材（孤儿）**：没有任何文件引用的图（用 inventory 的 referencedBy）。
- **重复图**：内容相同（用 inventory 的 hash）或明显重复的素材。
- **命名/尺寸不符规范**：与 repo 设计规范（若有）或常见约定不符。

## 注意
多数判断不需「看」图：孤儿看 referencedBy、重复看 hash、命名看路径。只有「图内容是否符合设计/spec」才需要视觉判断。

## SSOT 原则
只报分歧、附证据；不确定标 `ssot_direction: "uncertain"`（多数视觉问题为 `n/a`）。

## 不要做
- 不要改文件或删文件（只报告）。
```

`reviewers/duplicate_orphan.md`:

```markdown
# duplicate_orphan — 内置 rubric

你是重复／孤儿文件 reviewer，看全 repo。找出：

## 抓什么
- **重复文件**：内容相同（inventory 的 hash 相同）或高度重复、应合并的文件。
- **孤儿文件**：没有任何文件引用、看似已无用的资源（inventory 的 referencedBy 为空是强线索，但需判断是否为合理的入口点如 README/配置文件）。
- **无人引用的资产**：被遗留的暂存/实验文件。

## SSOT 原则
报「疑似重复/孤儿」并附证据（hash、referencedBy）；入口文件（README、LICENSE、配置）referencedBy 空属正常，勿误报。category 多为 `duplicate`/`orphan`，`ssot_direction` 多为 `n/a`。

## 不要做
- 不要删文件（只报告）。
```

`reviewers/convention.md`:

```markdown
# convention — 内置 rubric

你是规范遵循 reviewer，看全 repo。判断依据**几乎全来自 repo 自身规范**：`CLAUDE.md`、`.claude/skills/`、`.claude/workflows/`、`.github/workflows/`、以及其他惯例文档（这些已列在你的「repo 规范来源」中，请读）。

## 抓什么
- 违反 repo 自身声明的规范、流程、命名、结构约定之处。
- 与 repo 既定 SOP/skills 不一致的实现或文档。

## SSOT 原则
以 repo 自身规范为对照；只报违反处并引用是哪条规范（附证据）。规范本身可能过时——若 code 与规范分歧但证据显示规范较旧，标 `ssot_direction: "uncertain"` 交人判断。

## 不要做
- 不要改文件（只报告）。不要套用你自己的偏好——只依 repo 明文规范。
```

`reviewers/i18n.md`:

```markdown
# i18n — 内置 rubric（默认关闭）

你是在地化 reviewer。对分配给你的在地化资源（如 `Localizable.strings`、`.lproj/`、i18n JSON、多语文档）找出：

## 抓什么
- **缺翻译**：base 语言有、其他语言缺的 key。
- **未使用 key**：定义了但 code/文档未引用的在地化 key。
- **与 base 不同步**：翻译落后 base 的新增/修改。

> 注：多语 **README/doc** 的同步由 `docs_staleness` 负责；本 reviewer 专注 code 层在地化字串。

## SSOT 原则
base 通常为真实来源，但仍附证据（git 近期度）；方向不明确标 `ssot_direction: "uncertain"`。

## 不要做
- 不要改文件或补翻译（只报告）。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/all-rubrics.test.ts`
Expected: PASS（3 tests，涵盖 7 位）。

- [ ] **Step 5: Commit**

```bash
git add reviewers/code_hygiene.md reviewers/spec_flow.md reviewers/visual_icon.md reviewers/duplicate_orphan.md reviewers/convention.md reviewers/i18n.md test/all-rubrics.test.ts
git commit -m "feat: builtin rubrics for the remaining 6 reviewers"
```

---

### Task 4: `src/issue.ts` — 找出带标记的既有 issue（upsert 纯逻辑）

**Files:**
- Create: `src/issue.ts`, `test/issue.test.ts`

只做纯逻辑：给一串 issue（number + body），找出 body 含 `ISSUE_MARKER` 的第一个 number（用于 4b 决定 update 还是 create）。实际 gh API 调用属 4b。

- [ ] **Step 1: 写失败测试**

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

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/issue.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写实现**

```ts
// src/issue.ts
export interface IssueRef {
  number: number;
  body: string;
}

// 返回第一个 body 含 marker 的 issue number；无则 null。
export function findMarkedIssue(issues: IssueRef[], marker: string): number | null {
  const hit = issues.find((i) => typeof i.body === 'string' && i.body.includes(marker));
  return hit ? hit.number : null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/issue.test.ts`
Expected: PASS（4 tests）。

- [ ] **Step 5: 全套件 + 类型检查**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全 PASS、无类型错误。

- [ ] **Step 6: Commit**

```bash
git add src/issue.ts test/issue.test.ts
git commit -m "feat: findMarkedIssue for report issue upsert logic"
```

---

## 完成定义（Plan 4a）

- `npx vitest run` 全绿（rubric-paths/matrix/prompt-bundle/all-rubrics/issue + 既有）
- `composeRubric` 在 `audit.yml` 有 `paths` 时用 glob 选 target，否则沿用 category 领域
- `enabledReviewers` 正确生成 matrix 清单；`buildReviewerPrompt`/`buildSynthesisPrompt` 产出可喂 claude-code-action 的 prompt
- 7 位 reviewer 均有内置 rubric，含 no-edit + SSOT 纪律
- `findMarkedIssue` 提供 upsert 纯逻辑
- 零 API、零网络

## 衔接 Plan 4b

4b 用本 plan 的 `matrix`/`prompt-bundle`/`issue` + Plan 1-3 的 `discovery`/`report`，写：
1. `.github/actions/{discovery,reviewer,synthesis,report}/action.yml`（composite，自带 upkeep 代码：`npm ci` + `node --import tsx ...` + 必要的 claude-code-action / gh / upload-artifact）。
2. `.github/workflows/audit.yml`（`on: workflow_call`）：`discovery` job 产 matrix 清单 → `review` matrix job（`fail-fast:false`）每位写 `findings/<r>.json` 上传 artifact → `synthesis` job（`continue-on-error`）→ `report` job（`if: always()`）consolidate+render+gh issue upsert+artifact。
3. README job-level `uses:` 用法 + 权限/secret。
4. 对 `wei18/Sudoku` 跑直播 e2e：验证 claude-code-action 依 prompt 写出合规 `findings/<r>.json`、报告与 issue 正确生成。
