# Upkeep

[English](../../README.md) · **繁體中文** · [简体中文](../zh-CN/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md)

一個可重用的 GitHub Actions workflow，讓你的 repo 文件、規格說明與資源保持正確——在累積的偏差造成問題之前即時發現。

## 功能概述

- 掃描 repository，並行派遣一組**專責 AI 審查員**（由 Anthropic 的 `claude-code-action` 驅動）。
- 偵測已脫離程式碼的過時文件、不再符合實作的規格說明、重複或孤立的檔案、慣例違規，以及未同步更新的翻譯文件。
- **以具體證據回報差異**——不預設任何一份 artifact 永遠是真實來源。
- **絕不修改或刪除任何檔案**——僅輸出報告。
- 產生自包含的 **HTML 報告**（workflow artifact）與**持久 GitHub 追蹤 issue**（每次執行更新同一筆，不重複建立）。

## 使用方式

在你的 repo 中建立 `.github/workflows/audit.yml`：

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

**前置需求**

- 一個名為 `CLAUDE_CODE_OAUTH_TOKEN` 的 repo secret——請在本機執行 `claude setup-token` 產生（需 Claude Pro/Max 訂閱，用量計入訂閱配額）。若要改用按量計費，可將 workflow input 換成 `anthropic_api_key`。
- 如上所示的 `permissions` 區塊（`contents: read` + `issues: write` + `id-token: write`）。

**輸出**

- 一個標記為 `audit` 的 GitHub issue——每次執行更新同一筆（upsert），不重複建立。
- 一份自包含的 HTML 報告，以 `report-html` workflow artifact 形式上傳。

## 審查員

| 名稱 | 預設 | 檢查項目 |
|---|---|---|
| `docs_staleness` | 開啟 | 已脫離程式碼的文件；未與基礎語言版本同步的多語言 README 與翻譯文件 |
| `code_hygiene` | 開啟 | 死碼、未使用的 export、長期留存的 commented-out 區塊 |
| `spec_flow` | 開啟 | 不再符合實作的規格說明、架構圖與流程圖 |
| `visual_icon` | 開啟 | 過時或不一致的圖片與圖示 |
| `duplicate_orphan` | 開啟 | 重複檔案及已提交但從未被引用的孤立資源 |
| `convention` | 開啟 | 違反 repo 自身慣例（CLAUDE.md、`.claude/skills`、workflow 定義） |
| `i18n` | **關閉** | 各 locale 檔案之間的 i18n 一致性 |

## 設定

設定刻意分為兩個獨立面向：

- **Workflow 輸入參數**（上方呼叫端的 `with:` 區塊）控制*引擎怎麼跑*：`model`、`max_turns`、`issue_label`、`rubric_lang`。
- **`.claude/audit.yml`**（提交在被稽核的 repo 內）控制*要稽核什麼*：啟用哪些審查員、per-reviewer rubric 覆寫、`report.minSeverity`。審查員的開關放在這裡——而非 workflow 輸入參數——因為它是該 repo 自己、應隨 repo 演進的政策。

所有設定皆為選填。例如要啟用預設關閉的 `i18n` 審查員：

```yaml
# .claude/audit.yml
reviewers:
  i18n:
    enabled: true
```

完整 schema 與選項說明見 [`docs/design.md`](design.md)。

## 文件

- [`docs/overview.md`](overview.md) — pipeline 運作原理
- [`docs/design.md`](design.md) — 完整設計參考
- [`docs/why-reusable-workflow.md`](../en/why-reusable-workflow.md) — 為何是 reusable workflow 而非 `- uses:` step action
