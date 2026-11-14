# Upkeep — 设计文档

- 状态：已发布。本 spec 描述当前的行为。
- 位置：repo `wei18/upkeep`。英文 base：`docs/en/design.md`；各语言译本：`docs/<locale>/design.md`（见 §6）
- 自我约束：**本 spec 是 SSOT，需随实现持续 up-to-date**（此工具本身即在检测 drift，spec 不得漂移）

---

## 0. 目标

一个**可复用 GitHub Workflow（`on: workflow_call`）**，任何 repo 在自己的 workflow 以 job 级 `uses: wei18/upkeep/.github/workflows/audit.yml@v2` 引用。它扫描 repo 内容，分派一组各有专业的 subagent reviewer，检查资产（code / doc / spec / 视觉图 / icon / flow 等）是否：

- up-to-date（与真实代码/近期 commit 是否漂移）
- 符合 repo **自身**的规范
- 有无重复文件
- 有无用不到（孤儿）的资产

输出：HTML 深度报告（artifact）＋ GitHub tracking issue（摘要入口）。

核心原则：**约定优于配置**——能从 repo 现状推断的，绝不要求人工填写；config 过旧本身就是 drift 来源，必须避免。

---

## 1. 架构与执行流程

形态：**可复用 workflow**（`.github/workflows/audit.yml`，`on: workflow_call`），内部以官方 `claude-code-action` 为 LLM 引擎。需要调用方提供 `CLAUDE_CODE_OAUTH_TOKEN` secret（`secrets: inherit` 或显式传入）。
> 为何不是 composite action：composite action 是单一 job 的 step 序列，**不能使用 `strategy.matrix`**；matrix（每个 reviewer 一个并行 job）只能在 workflow job 层做，故采用 reusable workflow（已查 GitHub 官方文档确认）。

**编排模型：fan-out → reduce（matrix + synthesis），无 LLM lead。** 每个启用的 reviewer 各跑一个独立 matrix **job**（内含一个 `claude-code-action` step；`fail-fast: false` + `continue-on-error` 做失败隔离），各自输出结构化 findings；之后一个 synthesis job（单一 LLM）读取全部 findings 做语义级跨 reviewer 关联。不依赖「单次 run 内 spawn subagent」（该能力虽经实证可行，但 per-job 在确定性/隔离/零残留风险上更优）。

触发：可重用 workflow 只声明 `on: workflow_call`，因此触发条件由调用方的 workflow 决定——通常是 `schedule`（cron 定期全量扫描）加 `workflow_dispatch`（手动运行）。此 workflow 没有范围相关的 input：每次运行都是全量扫描。
> 「重复文件 / 孤儿文件 / 全局 up-to-date」需要全局视角，PR 增量做不到，故以全量扫描为主。

单次 run 数据流：

```
Caller's trigger (schedule / workflow_dispatch)
  │
  ▼
[1] Discovery (deterministic, non-LLM heavy lifting)
    Scan repo → file inventory + modality classification (code/doc/spec/visual/flow/icon...)
    Read convention sources: CLAUDE.md, .claude/skills, .claude/workflows,
                .github/workflows, .claude/audit.yml (if present)
  │
  ▼
[2] Review (matrix: one claude-code-action step per enabled reviewer)
    GHA matrix gives native parallelism + fault isolation; the only concentrated LLM cost
    Each step carries: inventory + its file subset + composed rubric (built-in default ⊕ repo conventions)
    Each emits findings/<reviewer>.json (schema in §4)
  │
  ▼
[3] Synthesis (single claude-code-action, the only "connect-the-dots" brain)
    Reads all findings/*.json + inventory (compact structured material, no re-reading the whole repo)
    → semantic cross-reviewer correlation, dedup, systemic themes, prioritized narrative
    → synthesis.json
  │
  ▼
[4] Consolidate (deterministic)
    Mechanically merge findings + synthesis, dedup by key, sort (severity × confidence)
  │
  ▼
[5] Report (deterministic, zero LLM cost)
    ├─ Produce a self-contained single-file HTML report → upload artifact
    └─ Create/update tracking issue (markdown summary + link to HTML artifact)
```

要点：
- Discovery / Consolidate / Report 是**确定性编排骨架**；Review 与 Synthesis 是 LLM。
- **无 LLM lead**：编排＝GHA workflow（matrix）＋ Node。Review 阶段各 reviewer 完全独立（无需互通）；跨领域全局视角由 Synthesis 这个 reduce step 实现。
- findings 使用统一 schema，让 Synthesis 与 Consolidate 都能机械化处理。

### 本地执行（skill / 脚本）

同一套 pipeline 可通过 `scripts/local-audit.sh <target>` 在本地执行：discovery → 并行 `claude -p` reviewer 子进程 → synthesis → report。所有中间产物（inventory、prompts、findings、synthesis）都放在 `mktemp` 工作目录，通过 `--add-dir` 授权给 Claude——不会写入目标 repo。本地执行产出同一份 self-contained HTML 报告；不会 upsert GitHub issue，而是把 issue markdown 打印出来作为终端摘要。`skills/upkeep-audit/SKILL.md` 是包装此脚本的 Claude Code 薄包装：维护 `~/.cache/upkeep` 的 clone、执行审计、在对话中总结 findings。此 skill 以三种方式发布，均指向同一个目录：作为 Claude Code plugin（repo 根目录的 `.claude-plugin/marketplace.json` 将 `skills/upkeep-audit/` 列为名为 `upkeep` 的 single-skill plugin，通过 `/plugin install upkeep@upkeep` 安装）、通过 `npx skills add wei18/upkeep --skill upkeep-audit`（vercel-labs/skills 扁平布局），或手动复制到 `~/.claude/skills/`。发布仅是打包层面——CI workflow 仍是直接的 pipeline 入口，不会绕经此 skill。

### Marketplace Composite Action

第三种集成形态把同一套引擎打包成 repo 根目录下的一个 composite action（`action.yml`），提供常见的 `- uses: wei18/upkeep@v2` step 语法，并可上架 [GitHub Marketplace](https://github.com/marketplace)。由于 composite action 是单一 job、不能使用 `strategy.matrix`，它的 `discovery` → `reviewer`（×7）→ `synthesis` → `report` 各 step 会依次执行而非并行——同一套引擎、同样的输入，只是在启用较多 reviewer 的 repo 上会更慢。为何上面的 reusable workflow 仍是主要路径，见 `docs/zh-CN/why-reusable-workflow.md`。这里的发布同样仅是打包层面，与 skill 相同：`action.yml` 调用的是 reusable workflow 所用的同一批 `.github/actions/<x>@v2` 子 action。

---

## 2. Reviewer 团队

内置 **7 位**（6 开 1 关）：

| Reviewer | 范围 | 主要检测问题 | 默认 |
|---|---|---|---|
| `docs_staleness` | README、文档、注释、**多语 README/doc 变体** | 内容陈旧、与 code 漂移、过期链接、**多语版本与 base 不同步** | on |
| `code_hygiene` | 源代码 | 死代码、用不到的文件/函数、与 spec 不符、明显的坏味道 | on |
| `spec_flow` | spec、流程图、状态机 | flow 与实现不一致、spec 过时 | on |
| `visual_icon` | 图片、icon、设计稿 | 未使用素材、重复图、尺寸/命名不符规范 | on |
| `duplicate_orphan` | 全 repo | 重复文件、孤儿文件、无人引用资源 | on |
| `convention` | 全 repo | 违反 repo 自身 skills/workflows/CLAUDE.md 规范 | on |
| `i18n` | 本地化字符串、`.lproj` 等 | 缺翻译、未使用 key、与 base 不同步 | **off** |

不支持动态自定义 reviewer（§11）。内置的 `i18n` reviewer（默认关闭）已覆盖常见需求。

### Rubric 三层合成（优先级由低到高）

```
Built-in default rubric (shipped with the action; defines what this specialty looks for)
   ⊕ repo-convention auto-discovery (the domain-relevant parts of
                         CLAUDE.md / .claude/skills / .claude/workflows)
   ⊕ audit.yml explicit override (the repo file pointed to by reviewers.<name>.rubric) ← highest priority
```

repo 有自己的标准时优先使用 repo 的。`convention` 几乎全靠 repo 自身规范；`visual_icon` 多靠内置默认＋repo 设计规范（若有）。

**Reviewer rubric 语言（`rubric_lang`）**：内置 rubric 按语系分置于 `reviewers/<locale>/`，共有两套：`en` 与 `zh-TW`。`rubric_lang` 这个 workflow input（默认 `en`）决定 reviewer 与 synthesis 使用哪一套。填入其他值时找不到对应的 prompt 文件，所有 reviewer 与 synthesis step 都会失败。

### 2.1 多语文档同步检测（multilingual doc-set）

由 `docs_staleness` 负责（非 `i18n`——`i18n` 管 code 层本地化字符串如 `.lproj`/`Localizable.strings`；文档翻译漂移属 doc 范畴）。

- **目录约定**：多语文档放在 `docs/<locale>/<name>.md`（如 `docs/zh-TW/overview.md`）。唯一例外是 repo 根的 `README.md`＝**英文 base**（GitHub 惯例），其各语译本在 `docs/<locale>/README.md`。
- **base 语言**：`en`（根 `README.md` 与 `docs/en/*` 为权威来源）。
- **支持语言（最多 6）**：`en`(base)、`zh-TW`、`zh-CN`、`ja`、`ko`（预留第 6）。
- **检测**：以 base（`docs/en/<name>.md`，README 则为根 `README.md`）为对照，对每个 `docs/<locale>/<name>.md` 报告「落后/缺漏/过时」。沿用 §3 原则——附证据（git 近期度：base 改了但某语译本没跟进），不预设「翻译一定是该更新的那方」，但 base 较新时通常倾向翻译落后。
- **分组**：reviewer 由「同名文件跨 `docs/<locale>/` 子目录」分组（README 另把根 `README.md` 与 `docs/<locale>/README.md` 视为同组）。
- **Dogfood**：本 repo 自身全套用户文档（README、overview、design、why-reusable-workflow）均多语化于 `docs/<locale>/`，同时作为此能力的真实测试样本（见 §10）。

---

## 3. SSOT 处理原则（不预设谁是真实来源）

问题：spec/code 不一定是 SSOT；有时**过期的反而是 spec 本身**。默认固定方向会产生误报。

原则：**reviewer 不预设 SSOT，只检测「分歧」，方向交给证据＋分级裁决。**

1. **检测分歧、不下定论**：报「A 说 X，B 说 Y，不一致」，而非「B 过时了」。
2. **附证据信号**：git 最后修改时间 / commit 近期度、被引用次数、引用方向。
3. **分级裁决**：
   - 证据强（如某文件半年未动、相关 code 上周大改）→ 将 `ssot_direction` 设为 `stale_a` 或 `stale_b`（§4），并在建议里明确方向（「README 较旧，建议更新」）。仍需人工确认。
   - 证据弱 → 将 `ssot_direction` 设为 `uncertain`，并在建议里说明方向需由人判断。
   - **任何情况都不自动修改**（自动修复不在范围内，见 §11）。
4. **SSOT 不靠声明文件**：方向全靠推断，避免声明文件自身过旧。真有固定策略的 repo 可以把策略写进覆盖用的 rubric（`reviewers.<name>.rubric`，§5）；非必要、不鼓励。

---

## 4. findings schema

每位 reviewer 写出一份 `findings/<reviewer>.json`，每个问题一条记录：

```json
{
  "reviewer": "docs_staleness",
  "status": "ok",
  "findings": [
    {
      "file": "path/to/file",
      "related": ["path/to/other-file"],
      "reviewer": "docs_staleness",
      "category": "staleness",
      "problem": "...",
      "evidence": "...",
      "suggestion": "...",
      "severity": "medium",
      "confidence": "high",
      "ssot_direction": "stale_a"
    }
  ]
}
```

- `status`：`ok` 或 `failed`。失败的 reviewer 写出 `status: "failed"` 与 `findings: []`；不影响其他 reviewer。
- `file`：主体文件。跨文件问题放在主体文件，其余文件列在 `related`。
- `related`：其他相关文件，可为空。比对的另一方排在第一个。这个顺序只在 `findings/<reviewer>.json` 内有意义：Consolidate 会合并并重新排序 `related`，因此汇总后的报告不保留此顺序。
- `category`：`staleness`、`duplicate`、`orphan`、`convention`、`inconsistency`、`i18n_sync`、`other` 之一。
- `problem`：人类可读的问题描述。
- `evidence`：支撑证据（git 时间、引用关系、具体不符之处）。
- `suggestion`：建议修法；在分级裁决下可指出方向（§3）。
- `severity`、`confidence`：各为 `low`、`medium`、`high` 之一。
- `ssot_direction`：以下四个值之一。
  - `stale_a`：`file` 是过时的一方。
  - `stale_b`：`related` 的第一个文件是过时的一方。
  - `uncertain`：两方不一致，但证据无法判断哪一方过时。
  - `n/a`：此问题没有可比对的两方。

`category`、`severity`、`confidence` 各值的判断标准只定义在一处：reviewer prompt（`reviewers/<locale>/_reviewer-prompt.md`）。`src/findings.ts` 会按合法值校验每份文件；校验失败的文件会被替换为 `failed` 结果。

**Consolidate 去重/排序（确定性）**：以 `file` + `category` 为键合并跨 reviewer 重复——同键取「代表 finding」= severity×confidence 最高者（平手以 reviewer 枚举顺序为稳定 tiebreak），`reviewers[]` 为该键所有上报者的并集、`related[]` 取并集。排序键 = severity desc → confidence desc → file asc。

### 4.1 synthesis 输出

Synthesis step 读取全部 `findings/*.json` + inventory，输出 `synthesis.json`。**以 file 路径引用 findings（不用整数索引——对 LLM 更稳定、人类可读）**：

```json
{
  "themes": [
    {
      "title": "...",
      "narrative": "...",
      "related_files": ["path/a", "path/b"],
      "priority": "high"
    }
  ],
  "semantic_duplicates": [["reviewer|file|category", "reviewer|file|category"]],
  "executive_summary": "...",
  "status": "ok"
}
```

- `themes`：跨 reviewer 的系统性主题。`title` 简述系统性问题；`narrative` 说明为何这些 finding 指向同一根因；`related_files` 列出此主题涵盖的文件路径；`priority` 为 `low`、`medium` 或 `high`。
- `semantic_duplicates`：描述同一问题的 finding 键群，每个键的格式为 `reviewer|file|category`。Consolidate 会把每一群合并成一条 finding。
- `executive_summary`：整体健康度的一段话摘要。
- `status`：`ok` 或 `failed`。synthesis 失败时写出 `themes: []`。

Report 同时使用 raw findings 与 synthesis；synthesis 失败或不存在时降级为只呈现 raw findings（无 themes/exec summary）。

---

## 5. 配置文件 `.claude/audit.yml`（全部可选，不存在也能完整运行）

`scan` 与 `ssot` **不放入配置**（会自行过旧）；改为自动推断。

```yaml
# .claude/audit.yml
version: 1
ignore:
  - "docs/*/plans/**"
reviewers:
  visual_icon: { enabled: false }
  i18n:        { enabled: true }
  docs_staleness:
    paths: ["README.md", "docs/**"]
    rubric: "docs/audit-rubric.md"
report:
  min_severity: "low"
```

所有键均为可选：

- `version`：配置 schema 版本；目前为 `1`。
- `ignore`：glob 路径。匹配的文件会从 inventory 中排除，任何 reviewer 都看不到。默认：无。
- `reviewers.<name>.enabled`：开启或关闭某位 reviewer。默认：除 `i18n` 外全部开启。未列出的 reviewer 保持默认；未知的名称会被忽略。
- `reviewers.<name>.paths`：glob 路径。设置后，该 reviewer 的 target 文件改为 inventory 中匹配的文件，不再按文件类型选取（§2 表格的「范围」列）。
- `reviewers.<name>.rubric`：rubric 文件相对于 repo 根的路径。reviewer 会把它当作最高优先级的 rubric 层（§2）。
- `report.min_severity`：`low`、`medium` 或 `high`。低于此值的 finding 不进 tracking issue；HTML 报告仍保留全部 finding。默认：`low`。也接受 camelCase 写法 `minSeverity`。

Glob 语法：`*` 匹配单个路径段内的字符，`**` 可跨路径段，`?` 匹配一个字符。

issue 的 label 不是配置键，请用 `issue_label` 这个 workflow input 设置（默认 `audit`）。

### 自动推断（无需配置）

- **扫描范围**：`git ls-files --cached --others --exclude-standard` 列出的所有文件（已跟踪与未跟踪的文件，遵守 `.gitignore`），再扣除 `ignore` 的 glob。lockfile 的文件类别为 `other`，因此只有查看全 repo 的 reviewer（`duplicate_orphan`、`convention`）会收到。超过 100KB 的文本文件只会被标记，不会被跳过（§7）。
- **SSOT 方向**：全靠证据推断（§3），无声明文件。

---

## 6. Repo 落点（已定）

Upkeep 以 `uses:` 被引用，故独立成 repo：`wei18/upkeep`（`uses: wei18/upkeep@v2`）。

结构：

```
upkeep/
├── action.yml                        # composite action (Marketplace listing): `uses: wei18/upkeep@v2`, sequential reviewer steps
├── .github/
│   ├── workflows/audit.yml          # reusable workflow (on: workflow_call): jobs/matrix orchestration
│   └── actions/                     # composite sub-actions (used by the workflow's jobs; carry Upkeep's own code)
│       ├── discovery/  reviewer/  synthesis/  report/
├── .claude-plugin/marketplace.json  # plugin marketplace catalog (plugin name: upkeep, source: ./skills/upkeep-audit)
├── README.md                        # English base usage (job-level uses: example, secret/permissions) + language switcher
├── docs/
│   ├── en/      overview.md  design.md  why-reusable-workflow.md   (no README: the root README.md is the en base)
│   ├── zh-TW/   README.md  overview.md  design.md  why-reusable-workflow.md
│   ├── zh-CN/ … ja/ … ko/   (same set as zh-TW)
│   ├── archive/plans/               # original implementation plans: historical record, not localized
│   └── superpowers/                 # design-process specs and plans: historical record, not localized
├── reviewers/<locale>/              # 7 built-in rubrics + _reviewer-prompt + _synthesis-prompt, per locale (en, zh-TW); picked by rubric_lang
├── skills/upkeep-audit/             # Claude Code skill: thin local-run wrapper (clones to ~/.cache/upkeep)
│   └── .claude-plugin/plugin.json   # plugin manifest (single-skill layout; SKILL.md at plugin root)
├── scripts/local-audit.sh           # local pipeline orchestrator (same flow as CI; temp-dir intermediates)
├── src/                             # deterministic TS: discovery/consolidate/report/matrix/prompt-bundle, etc.
└── test/                            # unit + contract tests (§10)
```

> 归档说明：`docs/archive/plans/` 与 `docs/superpowers/` 是 Upkeep 构建过程的历史记录。它们不做多语化、不被任何导航索引链接，也不是现行规则——现行规则以本 spec 为准。`.claude/audit.yml` 把这两个 `plans/` 目录排除在自我审计之外。

> 子 action 机制：reusable workflow 的 job 跑在**调用方**的 checkout；Upkeep 自身代码（src/、reviewers/）通过 `uses: wei18/upkeep/.github/actions/<x>@v2` 引入（GitHub 自动拉取 Upkeep repo）。每个 reviewer 是独立 matrix job 跑一个 plain `claude-code-action` prompt（写入 `findings/<reviewer>.json`），**无需 in-run subagent**，故 `--agents`/`Agent` passthrough 风险消失。

---

## 7. 模态分流

Discovery 为每个文件指定一个 `modality`。100KB 上限只管 reviewer 当文本读取的文件，不套用到图片。

| `modality` | 适用对象 | reviewer 如何处理 |
|---|---|---|
| `raster_image` | `.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.bmp`、`.tiff`、`.heic`、`.ico`、`.icns` | 无 byte 上限。依 metadata 判断；只有下方列出的唯一情况才当图片打开 |
| `vector_diagram` | `.svg`、`.mmd`、`.dot`、`.puml`、`.plantuml` | 当**源码文本**读取（语义可 diff）。超过 100KB 时，inventory 会设 `oversizedText: true` |
| `binary` | 前 8000 bytes 内含 NUL byte 的其他文件 | 只依 metadata 判断（`hash`、`sizeBytes`、`referencedBy`） |
| `text` | 其余所有文件 | 当文本读取。超过 100KB 时，inventory 会设 `oversizedText: true` |

`oversizedText` 只是 inventory 里的一个标记：不会有任何文件因为大小而被截断、分块、摘要或丢弃。reviewer prompt 会要求 reviewer 分段读取被标记的文件。

visual reviewer 多数工作不需「看」图：
- 重复图 → 文件 hash（完全相同）
- 孤儿图 → 引用关系图
- 命名/尺寸规范 → metadata
- **只有「图内容是否符合设计/spec」才需要打开图片**；rubric 限制只打开少数可疑素材

---

## 8. 韧性 / 降级

| 失败场景 | 处置方式 |
|---|---|
| 某 reviewer 挂掉、超时或写出不合法的输出 | 该 reviewer 的结果变为 `status:"failed"`、`findings:[]`（matrix `fail-fast: false`）；其余 reviewer 照常；报告与 issue 以「未完整运行」警告列出失败的 reviewer |
| Synthesis step 失败 | 降级：Report 只呈现 raw findings（不含跨领域主题/叙事），不让整个 run 失败 |
| 全部 reviewer 失败 | run 仍会完成：照常产出报告与 issue，内容没有 finding，「未完整运行」警告会列出每一位 reviewer |
| Discovery 扫到 0 个文件 | 正常结束，非错误 |

原则：Review/Synthesis 阶段子失败一律隔离降级；确定性骨架（Discovery/Consolidate/Report）失败才让整个 run fail。

---

## 9. 成本控制

- reviewer 收到的是 inventory（metadata）与 target 文件清单，而不是文件内容。prompt 要求先用 metadata 筛出可疑的文件，只深读那些文件
- `max_turns`（默认 30）限制每次 reviewer 调用与 synthesis 调用的 turn 数
- 被 `.gitignore` 或 `ignore` 排除的文件不会进入 inventory（§5）
- HTML / issue 组装是纯文本，**零 LLM 成本**

---

## 10. 测试策略

测试样本：远端真实 repo **https://github.com/wei18/Sudoku**（取代自建 fixture）。

- **确定性层 → 单元测试（TDD）**：Discovery 分类、Consolidate 去重排序、HTML/issue 组装，不涉及 LLM。
- **LLM 层 → 契约测试**：验证 subagent 输出**符合 findings schema**（字段齐全、severity/confidence/ssot_direction 在合法值域），不逐字断言内容。
  - CI：用**录制假 response** 做 schema 契约测试（省钱、稳定）。
  - 真实调用 API：仅手动 / release 前 smoke。
- **端到端 smoke（手动，不在 CI 内）**：对 Sudoku repo 跑完整 workflow，确认 HTML artifact 与 issue 存在、findings 符合 schema、抓到合理数量的问题（不逐字断言）。
- **Dogfood**：`.github/workflows/self-audit.yml` 每周对本 repo 运行一次审计。

---

## 11. 范围边界（不做的事）

- 自动修复 PR（自动改 README/删孤儿文件）——没有计划；Upkeep 只输出报告
- 动态自定义 reviewer——reviewer 组合固定；以 `reviewers.<name>.paths` 与 `reviewers.<name>.rubric`（§5）调整内置的 reviewer
- PR 增量模式——每次运行都是全量扫描
- SSOT 声明文件——方向由证据推断
