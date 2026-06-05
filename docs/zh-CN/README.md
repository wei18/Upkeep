# Upkeep

[English](../../README.md) · [繁體中文](../zh-TW/README.md) · **简体中文** · [日本語](../ja/README.md) · [한국어](../ko/README.md)

一个可复用的 GitHub Actions workflow，持续检查仓库中的文档、规范与资源是否与代码保持一致，在偏差积累成问题之前将其捕获。

## 功能说明

- 扫描仓库，并行调度一组**各司其职的 AI 审查器**（由 Anthropic 的 `claude-code-action` 驱动）。
- 检测脱离代码的陈旧文档、不再符合实现的规范、重复或孤立文件、约定违规，以及未同步的翻译文档。
- **以证据呈现偏差** — 不预设某一产物一定是权威来源。
- **从不编辑或删除任何内容** — 仅输出报告。
- 生成独立的 **HTML 报告**（workflow artifact）和**持久化 GitHub 跟踪 issue**（upsert 方式，不重复创建）。

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
    secrets:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

**前置条件**

- 仓库中需配置名为 `CLAUDE_CODE_OAUTH_TOKEN` 的 secret——在本地执行 `claude setup-token` 生成（需 Claude Pro/Max 订阅，用量计入订阅额度）。如需按量付费，可将 workflow input 改为 `anthropic_api_key`。
- 需包含上述 `permissions` 块（`contents: read` + `issues: write`）。

**输出**

- 一个标记为 `audit` 的 GitHub issue — 每次运行时更新同一个 issue（upsert），不重复创建。
- 一个独立 HTML 报告，作为 `report-html` workflow artifact 上传。

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

所有配置均为可选项 — 除上述调用 workflow 外，无需任何额外设置。如需启用或调整审查器，可创建 `.claude/audit.yml`；完整 schema 及选项说明见 [`docs/design.md`](design.md)。

## 文档

- [`docs/overview.md`](overview.md) — 流水线工作原理
- [`docs/design.md`](design.md) — 完整设计参考
- [`docs/why-reusable-workflow.md`](../en/why-reusable-workflow.md) — 为何是 reusable workflow 而非 `- uses:` step action
