# Upkeep — 设计文档

- 状态：设计定稿，待写实现计划
- 日期：2026-06-04
- 位置：独立 repo `upkeep/`，spec 于 `docs/design.md`（见 §6）
- 自我约束：**本 spec 是 SSOT，需随实现持续 up-to-date**（此工具本身即在检测 drift，spec 不得漂移）

---

## 0. 目标

一个**可复用 GitHub Workflow（`on: workflow_call`）**，任何 repo 在自己的 workflow 以 job 级 `uses: wei18/upkeep/.github/workflows/audit.yml@v1` 引用。它扫描 repo 内容，分派一组各有专业的 subagent reviewer，检查资产（code / doc / spec / 视觉图 / icon / flow 等）是否：

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

触发：`schedule`（cron 定期全量扫描）＋ `workflow_dispatch`（手动，可带范围参数）。
> 「重复文件 / 孤儿文件 / 全局 up-to-date」需要全局视角，PR 增量做不到，故以全量扫描为主。

单次 run 数据流：

```
触发 (schedule / workflow_dispatch)
  │
  ▼
[1] Discovery（确定性，非 LLM 重活）
    扫 repo → 文件清单 + 模态分类(code/doc/spec/visual/flow/icon...)
    读规范来源：CLAUDE.md、.claude/skills、.claude/workflows、
                .github/workflows、.claude/audit.yml(若有)
  │
  ▼
[2] Review（matrix：每个启用 reviewer 一个 claude-code-action step）
    GHA matrix 原生并行、失败隔离；唯一 LLM 成本集中处
    每 step 带：inventory + 负责文件子集 + 合成 rubric(内置默认 ⊕ repo 规范)
    各自输出 findings/<reviewer>.json（schema 见 §4）
  │
  ▼
[3] Synthesis（单一 claude-code-action，唯一「融会贯通」的大脑）
    读取全部 findings/*.json + inventory（精简结构化素材，不重读整个 repo）
    → 语义级跨 reviewer 关联、去重、系统性主题、优先级叙事
    → synthesis.json
  │
  ▼
[4] Consolidate（确定性）
    机械式合并 findings + synthesis、key 去重、排序(severity × confidence)
  │
  ▼
[5] Report（确定性，零 LLM 成本）
    ├─ 生成 self-contained 单文件 HTML 报告 → upload artifact
    └─ 创建/更新 tracking issue（markdown 摘要 + 链接到 HTML artifact）
```

要点：
- Discovery / Consolidate / Report 是**确定性编排骨架**；Review 与 Synthesis 是 LLM。
- **无 LLM lead**：编排＝GHA workflow（matrix）＋ Node。Review 阶段各 reviewer 完全独立（无需互通）；跨领域全局视角由 Synthesis 这个 reduce step 实现。
- findings 使用统一 schema，让 Synthesis 与 Consolidate 都能机械化处理。

---

## 2. Reviewer 团队

内置 **7 位**（6 开 1 关）：

| Reviewer | 范围 | 主要检测问题 | 默认 |
|---|---|---|---|
| `docs_staleness` | README、文档、注释、**多语 README/doc 变体** | 内容陈旧、与 code 漂移、过期链接、**多语版本与 base 不同步** | on |
| `code_hygiene` | 源代码 | 死代码、用不到的文件/函数、与 spec 不符 | on |
| `spec_flow` | spec、流程图、状态机 | flow 与实现不一致、spec 过时 | on |
| `visual_icon` | 图片、icon、设计稿 | 未使用素材、重复图、尺寸/命名不符规范 | on |
| `duplicate_orphan` | 全 repo | 重复文件、孤儿文件、无人引用资源 | on |
| `convention` | 全 repo | 违反 repo 自身 skills/workflows/CLAUDE.md 规范 | on |
| `i18n` | 本地化字符串、`.lproj` 等 | 缺翻译、未使用 key、与 base 不同步 | **off** |

第一版**不做动态自定义 reviewer**；i18n 做成内置（默认关）即可覆盖常见需求（YAGNI）。

### Rubric 三层合成（优先级由低到高）

```
内置默认 rubric（action 自带，定义该专业检测什么）
   ⊕ repo 规范自动发现（CLAUDE.md / .claude/skills / .claude/workflows
                         中与该领域相关者）
   ⊕ audit.yml 显式指定（reviewers.<name>.rubric 指向的 repo 文件）← 最高优先
```

repo 有自己的标准时优先使用 repo 的。`convention` 几乎全靠 repo 自身规范；`visual_icon` 多靠内置默认＋repo 设计规范（若有）。

### 2.1 多语文档同步检测（multilingual doc-set）

由 `docs_staleness` 负责（非 `i18n`——`i18n` 管 code 层本地化字符串如 `.lproj`/`Localizable.strings`；文档翻译漂移属 doc 范畴）。

- **目录约定**：多语文档放在 `docs/<locale>/<name>.md`（如 `docs/zh-TW/overview.md`）。唯一例外是 repo 根的 `README.md`＝**英文 base**（GitHub 惯例），其各语译本在 `docs/<locale>/README.md`。
- **base 语言**：`en`（根 `README.md` 与 `docs/en/*` 为权威来源）。
- **支持语言（最多 6）**：`en`(base)、`zh-TW`、`zh-CN`、`ja`、`ko`（预留第 6）。
- **检测**：以 base（`docs/en/<name>.md`，README 则为根 `README.md`）为对照，对每个 `docs/<locale>/<name>.md` 报告「落后/缺漏/过时」。沿用 §3 原则——附证据（git 近期度：base 改了但某语译本没跟进），不预设「翻译一定是该更新的那方」，但 base 较新时通常倾向翻译落后。
- **分组**：reviewer 由「同名文件跨 `docs/<locale>/` 子目录」分组（README 另把根 `README.md` 与 `docs/<locale>/README.md` 视为同组）。
- **Dogfood**：本 repo 自身全套用户文档（README、overview、design、plans）均多语化于 `docs/<locale>/`，同时作为此能力的真实测试样本（见 §10）。

---

## 3. SSOT 处理原则（不预设谁是真实来源）

问题：spec/code 不一定是 SSOT；有时**过期的反而是 spec 本身**。默认固定方向会产生误报。

原则：**reviewer 不预设 SSOT，只检测「分歧」，方向交给证据＋分级裁决。**

1. **检测分歧、不下定论**：报「A 说 X，B 说 Y，不一致」，而非「B 过时了」。
2. **附证据信号**：git 最后修改时间 / commit 近期度、被引用次数、引用方向。
3. **分级裁决**：
   - 证据强（如某文件半年未动、相关 code 上周大改）→ 建议里明确方向（「README 较旧，建议更新」），仍标 `needs-confirmation`。
   - 证据弱 → 标「drift，方向待裁决」。
   - **任何情况都不自动修改**（自动修复留第二阶段）。
4. **SSOT 不靠声明文件**：方向全靠推断，避免声明文件自身过旧。真有固定策略的 repo 才用 escape hatch 覆盖（非必要、不鼓励）。

---

## 4. findings schema

每位 reviewer 对每个问题输出：

```jsonc
{
  "file": "path/to/file",          // 主体文件（跨文件问题放主文件，related 补充）
  "related": ["path/..."],          // 关联文件（可为空）
  "reviewer": "docs_staleness",
  "category": "staleness | duplicate | orphan | convention | inconsistency | ...",
  "problem": "人类可读的问题描述",
  "evidence": "支撑证据（git 时间、引用关系、具体不符之处）",
  "suggestion": "建议修改方案（分级裁决下可能含方向）",
  "severity": "high | medium | low",
  "confidence": "high | medium | low",
  "ssot_direction": "stale_a | stale_b | uncertain | n/a",
  "status": "ok"                    // reviewer 级别：ok | failed
}
```

每个 reviewer step 输出一份 `findings/<reviewer>.json`：`{ reviewer, status: "ok"|"failed", findings: Finding[] }`（单个 reviewer 失败时 `status:"failed"`、`findings:[]`，不影响其他）。

**Consolidate 去重/排序（确定性）**：以 `file` + `category` 为键合并跨 reviewer 重复——同键取「代表 finding」= severity×confidence 最高者（平手以 reviewer 枚举顺序为稳定 tiebreak），`reviewers[]` 为该键所有上报者的并集、`related[]` 取并集。排序键 = severity desc → confidence desc → file asc。

### 4.1 synthesis 输出

Synthesis step 读取全部 `findings/*.json` + inventory，输出 `synthesis.json`。**以 file 路径引用 findings（不用整数索引——对 LLM 更稳定、人类可读）**：

```jsonc
{
  "themes": [                         // 跨 reviewer 的系统性主题
    {
      "title": "简述系统性问题",
      "narrative": "为何这些 finding 指向同一根因",
      "related_files": ["path/a", "path/b"],  // 此主题涵盖的文件路径
      "priority": "high | medium | low"
    }
  ],
  "semantic_duplicates": [[ "reviewer|file|category", "reviewer|file|category" ]], // 语义重复的 finding 键组
  "executive_summary": "整体健康度的一段话摘要",
  "status": "ok"                      // synthesis 失败→report 仍输出 raw findings
}
```

Report 同时使用 raw findings 与 synthesis；synthesis 失败或不存在时降级为只呈现 raw findings（无 themes/exec summary）。

---

## 5. 配置文件 `.claude/audit.yml`（全部可选，不存在也能完整运行）

`scan` 与 `ssot` **不放入配置**（会自行过旧）；改为自动推断。

```yaml
# .claude/audit.yml —— 全部可选；通常不需要此文件
version: 1
reviewers:               # 只列「要关掉/调范围/开 i18n」的，其余按默认
  visual_icon: { enabled: false }
  i18n:        { enabled: true }
report:
  issue_label: "audit"   # 默认即 "audit"，需修改才写
  min_severity: "low"    # 低于此不进 issue（仍进 HTML 完整报告）
```

### 自动推断（无需配置）

- **扫描范围**：遵守 repo `.gitignore`；自动跳过 binary / lockfile / 构建产物；文本文件内置 100KB 上限（见 §7 模态分流）。
- **SSOT 方向**：全靠证据推断（§3），无声明文件。

---

## 6. Repo 落点（已定）

此 action 发布成可被 `uses:` 引用者，故独立成 repo。本地目录 `/Users/zw/GitHub/Wei18/repo-audit-action/`（已 `git init`）；**发布/包名为 `Upkeep`**（`uses: wei18/upkeep@v1`）——本地文件夹名与发布名不同是刻意保留。

预期结构：

```
repo-audit-action/                   # 本地目录（发布名 Upkeep）
├── .github/
│   ├── workflows/audit.yml          # 可复用 workflow（on: workflow_call）：jobs/matrix 编排
│   └── actions/                     # composite 子 action（被 workflow 的 job uses，自带 Upkeep 代码）
│       ├── discovery/  reviewer/  synthesis/  report/
├── README.md                        # 英文 base 用法（job 级 uses: 示例、secret/权限）+ 语言切换列
├── docs/
│   ├── en/      README 无（根即 en）；overview.md  design.md  why-reusable-workflow.md  plans/
│   ├── zh-TW/   README.md  overview.md  design.md  plans/
│   ├── zh-CN/ … ja/ … ko/   （同上各语一套）
│   └── （多语用户文档一律 docs/<locale>/；root README.md 为 en base）
├── reviewers/                       # 7 位内置 reviewer rubric + _reviewer-prompt + _synthesis-prompt
├── src/                             # discovery/consolidate/report/matrix/prompt-bundle 等确定性 TS
└── test/                            # 单元 + 契约 + e2e（样本见 §10）
```

> 子 action 机制：reusable workflow 的 job 跑在**调用方**的 checkout；Upkeep 自身代码（src/、reviewers/）通过 `uses: wei18/upkeep/.github/actions/<x>@v1` 引入（GitHub 自动拉取 Upkeep repo）。每个 reviewer 是独立 matrix job 跑一个 plain `claude-code-action` prompt（写入 `findings/<reviewer>.json`），**无需 in-run subagent**，故 `--agents`/`Agent` passthrough 风险消失。

---

## 7. 模态分流（取代「一条 byte 上限打天下」）

100KB 上限只该管「当文本塞进 LLM 的文件」，不该套到图片。

| 文件类型 | 处理方式 | 100KB byte 上限 |
|---|---|---|
| 文本类（code/doc/spec/`.md`） | 当文本读取；超限→**分块或先摘要再点名深读**，不静默丢弃 | 套用（超限→分块） |
| 向量/文本型流程图（`.svg`/`.mmd`/`.dot`/`.puml`） | 当**源码文本**读取（语义可 diff） | 套用（通常很小） |
| 位图（png/jpg/webp…） | byte 大小无关；用**尺寸/百万像素预算**，送 vision 前先 downscale | **不套用** |

关键：visual reviewer 多数工作不需「看」图——
- 重复图 → 文件 hash（精确/感知）
- 孤儿图 → 引用关系图
- 命名/尺寸规范 → metadata
- **只有「图内容是否符合设计/spec」才送 vision（先 downscale）**

唯一会被跳过的是无法处理的超大未知 binary，且报告明确列出 `未检视：超大 binary`，不静默吞掉。

---

## 8. 韧性 / 降级

| 失败场景 | 处置方式 |
|---|---|
| 某 reviewer matrix step 挂掉/超时 | 该 step 输出 `status:"failed"`、`findings:[]`（matrix `fail-fast: false`）；其余 step 照常；报告与 issue 明确列出「本次缺 X」 |
| Anthropic API 临时错误 | 该 step 重试（指数退避，上限 2 次）；仍失败才降级 |
| Synthesis step 失败 | 降级：Report 只呈现 raw findings（不含跨领域主题/叙事），不让整个 run 失败 |
| 全部 reviewer 失败 | workflow fail，不创建空 issue |
| Discovery 扫到 0 个文件 | 正常结束，留 log，非错误 |

原则：Review/Synthesis 阶段子失败一律隔离降级；确定性骨架（Discovery/Consolidate/Report）失败才让整个 run fail。

---

## 9. 成本控制

- 100KB／文件上限 + 跳过 binary/lockfile/构建产物（§5、§7）
- **分层送读**：先送清单＋摘要，由 reviewer 点名深读，不无脑全文塞入
- `max_files_per_reviewer` 安全阀（默认 300）；超过时按「近期 commit 触及 + 高引用度」取前 N，报告注明「已截断」
- HTML / issue 组装是纯文本，**零 LLM 成本**

---

## 10. 测试策略

测试样本：远端真实 repo **https://github.com/wei18/Sudoku**（取代自建 fixture）。

- **确定性层 → 单元测试（TDD）**：Discovery 分类、Consolidate 去重排序、HTML/issue 组装，不涉及 LLM。
- **LLM 层 → 契约测试**：验证 subagent 输出**符合 findings schema**（字段齐全、severity/confidence/ssot_direction 在合法值域），不逐字断言内容。
  - CI：用**录制假 response** 做 schema 契约测试（省钱、稳定）。
  - 真实调用 API：仅手动 / release 前 smoke。
- **端到端 smoke**：对 Sudoku repo 跑完整 action，断言产出 HTML/issue 存在、findings 符合 schema、抓到合理数量问题（不逐字断言）。

---

## 11. 范围边界（第一版不做）

- 自动修复 PR（自动改 README/删孤儿文件）——留第二版
- 动态自定义 reviewer——i18n 内置已覆盖
- PR 增量模式——以全量扫描为主
- SSOT 声明文件——改为纯推断
