<p align="center">
  <img src="../assets/banner.svg" alt="Upkeep — your AI writes fast, Upkeep keeps it honest" width="100%">
</p>

# Upkeep

[English](../../README.md) · [繁體中文](../zh-TW/README.md) · **简体中文** · [日本語](../ja/README.md) · [한국어](../ko/README.md)

一个可复用的 GitHub Actions workflow，持续检查仓库中的文档、规范与资源是否与代码保持一致，在偏差积累成问题之前将其捕获。

> 💳 **不会多一笔 API 账单。** Upkeep 跑在你现有的 **Claude Pro/Max 订阅**（通过 `claude setup-token` 的 OAuth）——不需要 Anthropic API key、没有按 token 计费。而且它**只输出、不动手**：报告偏差时附证据与严重度，但绝不修改或删除你的文件。

## 功能说明

- 扫描仓库，并行调度一组**各司其职的 AI 审查器**（由 Anthropic 的 `claude-code-action` 驱动）。
- 检测脱离代码的陈旧文档、不再符合实现的规范、重复或孤立文件、约定违规，以及未同步的翻译文档。
- **以证据呈现偏差** — 不预设某一产物一定是权威来源。
- **从不编辑或删除任何内容** — 仅输出报告。
- 生成独立的 **HTML 报告**（workflow artifact）和**持久化 GitHub 跟踪 issue**（upsert 方式，不重复创建）。

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

## 使用方式

在仓库中创建 `.github/workflows/audit.yml`：

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
    uses: wei18/upkeep/.github/workflows/audit.yml@v1
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

- **Workflow 输入参数**（上方调用端的 `with:` 块）控制*引擎如何运行*：`model`、`max_turns`、`issue_label`、`rubric_lang`。
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
- [`docs/why-reusable-workflow.md`](why-reusable-workflow.md) — 为何是 reusable workflow 而非 `- uses:` step action
