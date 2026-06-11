<p align="center">
  <img src="../assets/banner.svg" alt="Upkeep — your AI writes fast, Upkeep keeps it honest" width="100%">
</p>

# Upkeep

[English](../../README.md) · [繁體中文](../zh-TW/README.md) · **简体中文** · [日本語](../ja/README.md) · [한국어](../ko/README.md)

**为你的仓库配备的 AI 审计团队，以 skill 形式安装。** Upkeep 并行调度各司其职的 AI 审查器来捕获漂移——陈旧文档、不再符合代码的规范、孤立资源、被打破的约定——并在偏差积累之前附证据报告。

> 💳 **不会多一笔 API 账单。** Upkeep 跑在你现有的 **Claude Pro/Max 订阅**——本地用你已登录的 `claude` CLI，CI 则通过 `claude setup-token` 的 OAuth。不需要 Anthropic API key、没有按 token 计费。而且它**只输出、不动手**：报告偏差时附证据与严重度，但绝不修改或删除你的文件。

## 安装

**Claude Code** — 以 plugin 安装：

```
/plugin marketplace add wei18/upkeep
/plugin install upkeep@upkeep
```

**其他 agent**（Cursor、Copilot，以及 [skills](https://github.com/vercel-labs/skills) 支持的 70+ 种 agent）：

```bash
npx skills add wei18/upkeep --skill upkeep-audit
```

**要求**：已登录的 `claude` CLI（Pro/Max）、Node 20+、git——无论哪种安装方式，引擎都在你的机器上运行。

然后在任何 session 里说：

> Run an upkeep audit on /path/to/repo

skill 首次执行时会自动把 Upkeep 引擎 clone 到 `~/.cache/upkeep` 并安装依赖。你会在对话中收到按严重度分组的发现，外加一份独立的 HTML 报告。

## 功能说明

- 扫描仓库，并行调度一组**各司其职的 AI 审查器**。
- 检测脱离代码的陈旧文档、不再符合实现的规范、重复或孤立文件、约定违规，以及未同步的翻译文档。
- **以证据呈现偏差** — 不预设某一产物一定是权威来源。
- **从不编辑或删除任何内容** — 仅输出报告。
- 生成独立的 **HTML 报告**——在 CI 中运行时，另有**持久化 GitHub 跟踪 issue**（upsert 方式，不重复创建）。

## 与其他工具的差异

Upkeep 不是 linter，也不是 PR bot——它是**跨整个仓库的语义级漂移审查器**。不同工具、不同分工：

| | **Upkeep** | Danger | Copilot / Cursor PR review |
|---|---|---|---|
| 检查范围 | **整个仓库**——文档、规范、资源、约定 | 单个 PR 的 diff | 单个 PR 的 diff |
| 发现什么 | **语义级漂移**（README 说 X、代码做 Y） | **你自己手写**的规则违反 | diff 里的代码问题 |
| 依据 | 你仓库**自己的**约定 | 你的自定义规则 | 通用代码知识 |
| 频率 | 定时或按需，全仓库 | 每个 PR | 每个 PR |
| 会改你的代码吗？ | **绝不**——只输出 | 不会 | 会建议修改 |
| 成本 | 你的 **Claude Pro/Max** 订阅 | 免费（逻辑要自己写） | Copilot/Cursor 订阅 |

## 以纯脚本运行

完全不用 agent？同一套 pipeline 也能以独立脚本运行：

```bash
git clone --depth 1 https://github.com/wei18/upkeep ~/.cache/upkeep
cd ~/.cache/upkeep && npm ci
./scripts/local-audit.sh /path/to/repo --out ~/upkeep-report.html
```

| 参数 | 默认值 | 对应 CI input |
|---|---|---|
| `--model` | `claude-opus-4-8` | `model` |
| `--rubric-lang` | `en` | `rubric_lang` |
| `--max-turns` | `30` | `max_turns` |
| `--out` | `./upkeep-report.html` | report artifact |

**要求**：已登录的 `claude` CLI（Pro/Max 订阅；不需要 `setup-token`，也不需要 GitHub 访问权限）、Node 20+、git。

**输出**：同一份独立的 HTML 报告（默认为 `upkeep-report.html`）加上终端摘要。本地执行不会创建 GitHub issue。

偏好手动安装 skill？把 [`skills/upkeep-audit/`](../../skills/upkeep-audit/) 复制到 `~/.claude/skills/`。

## 在 CI 中自动化

同一组审计团队，按计划运行。在仓库中创建 `.github/workflows/audit.yml`：

```yaml
name: repo audit
on:
  schedule:
    - cron: '0 3 * * 1'   # weekly, Monday 03:00 UTC
  workflow_dispatch:        # also run manually

permissions:
  contents: read
  issues: write
  id-token: write

jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@v2
    with:
      model: claude-opus-4-8     # optional
      issue_label: audit         # optional; default: audit
      rubric_lang: en            # optional; reviewer language: en | zh-TW
    secrets:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

**前置条件**

- 仓库中需配置名为 `CLAUDE_CODE_OAUTH_TOKEN` 的 secret——在本地执行 `claude setup-token` 生成（需 Claude Pro/Max 订阅，用量计入订阅额度）。
- 需包含上述 `permissions` 块（`contents: read` + `issues: write` + `id-token: write`）。

**输出**

- 一个标记为 `audit` 的 GitHub issue — 每次运行时更新同一个 issue（upsert），不重复创建。
- 一个独立 HTML 报告，作为 `report-html` workflow artifact 上传。跟踪 issue 会直接链接到它；否则可在该次 run 的 **Artifacts**（Actions → 那次 run）找到，或用 `gh run download <run-id> -n report-html` 下载。GitHub 的 artifact 是可下载的 zip，并按你仓库的保留设置过期。

> 还在用 `@v1`？它仍可运行但已冻结——把 tag 换成 `@v2` 即可。接口完全相同。

## 审查器

| 名称 | 默认状态 | 检查内容 |
|---|---|---|
| `docs_staleness` | 启用 | 脱离代码的文档；与英文原版不同步的多语言 README 及翻译文档 |
| `code_hygiene` | 启用 | 死代码、未使用的导出、永久残留的注释代码块 |
| `spec_flow` | 启用 | 不再符合实现的规范、架构图和流程图 |
| `visual_icon` | 启用 | 过时或不匹配的图片与图标 |
| `duplicate_orphan` | 启用 | 重复文件及已提交但从未被引用的孤立资源 |
| `convention` | 启用 | 违反仓库自身约定（CLAUDE.md、`.claude/skills`、workflow 定义） |
| `i18n` | **禁用** | 各语言文件间的国际化一致性 |

## 配置

配置刻意分为两个独立的层面：

- **Workflow 输入参数**（上方调用端的 `with:` 块；本地则为对应的脚本参数）控制*引擎如何运行*：`model`、`max_turns`、`issue_label`、`rubric_lang`。
- **`.claude/audit.yml`**（提交在被审计的 repo 内）控制*审计什么*：启用哪些审查器、per-reviewer rubric 覆写、`report.minSeverity`。审查器的开关放在这里——而非 workflow 输入参数——因为它是该 repo 自身、应随 repo 演进的策略。

所有配置均为可选项。例如要启用默认关闭的 `i18n` 审查器：

```yaml
# .claude/audit.yml
reviewers:
  i18n:
    enabled: true
```

完整 schema 及选项说明见 [`docs/design.md`](design.md)。

## 文档

- [`docs/overview.md`](overview.md) — 流水线工作原理
- [`docs/design.md`](design.md) — 完整设计参考
- [`docs/why-reusable-workflow.md`](why-reusable-workflow.md) — 为何 CI 层是 reusable workflow 而非 `- uses:` step action
