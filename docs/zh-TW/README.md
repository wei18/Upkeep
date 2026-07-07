<p align="center">
  <img src="../assets/banner.svg" alt="Upkeep — your AI writes fast, Upkeep keeps it honest" width="100%">
</p>

# Upkeep

[English](../../README.md) · **繁體中文** · [简体中文](../zh-CN/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md)

**為你的 repo 配備的 AI 稽核團隊，以 skill 形式安裝。** Upkeep 並行派遣專責 AI 審查員來抓出漂移——過時的文件、不再符合程式碼的規格、孤立的資源、被打破的慣例——並在問題累積之前附證據回報。

> 💳 **不會多一筆 API 帳單。** Upkeep 跑在你現有的 **Claude Pro/Max 訂閱**——本機用你已登入的 `claude` CLI，CI 則透過 `claude setup-token` 的 OAuth。不需要 Anthropic API key、沒有按 token 計費。而且它**只輸出、不動手**：報告偏差時附證據與嚴重度，但絕不修改或刪除你的檔案。

## 安裝

**Claude Code** — 以 plugin 安裝：

```
/plugin marketplace add wei18/upkeep
/plugin install upkeep@upkeep
```

**其他 agent**（Cursor、Copilot，以及 [skills](https://github.com/vercel-labs/skills) 支援的 70+ 種 agent）：

```bash
npx skills add wei18/upkeep --skill upkeep-audit
```

**需求**：已登入的 `claude` CLI（Pro/Max）、Node 20+、git——無論哪種安裝方式，引擎都在你的機器上執行。

接著在任何 session 說：

> Run an upkeep audit on /path/to/repo

skill 首次執行時會自動把 Upkeep 引擎 clone 到 `~/.cache/upkeep` 並安裝相依套件。你會在對話中收到依嚴重度分組的發現，外加一份自包含的 HTML 報告。

## 功能概述

- 掃描 repository，並行派遣一組**專責 AI 審查員**。
- 偵測已脫離程式碼的過時文件、不再符合實作的規格說明、重複或孤立的檔案、慣例違規，以及未同步更新的翻譯文件。
- **以具體證據回報差異**——不預設任何一份 artifact 永遠是真實來源。
- **絕不修改或刪除任何檔案**——僅輸出報告。
- 產生自包含的 **HTML 報告**——在 CI 執行時，另有**持久 GitHub 追蹤 issue**（每次執行更新同一筆，不重複建立）。

## 與其他工具的差異

Upkeep 不是 linter、也不是 PR bot——它是**跨整個 repo 的語意級漂移稽核器**。不同工具、不同分工：

| | **Upkeep** | Danger | Copilot / Cursor PR review |
|---|---|---|---|
| 看的範圍 | **整個 repo**——文件、規格、資源、慣例 | 單一 PR 的 diff | 單一 PR 的 diff |
| 抓什麼 | **語意級漂移**（README 說 X、code 做 Y） | **你自己手寫**的規則違反 | diff 裡的程式碼問題 |
| 依據 | 你 repo **自己的**慣例 | 你的自訂規則 | 一般程式知識 |
| 頻率 | 排程或隨選，全 repo | 每個 PR | 每個 PR |
| 會改你的 code 嗎？ | **絕不**——只輸出 | 不會 | 會建議修改 |
| 成本 | 你的 **Claude Pro/Max** 訂閱 | 免費（邏輯要自己寫） | Copilot/Cursor 訂閱 |

## 以純腳本執行

完全不用 agent？同一套 pipeline 也能以獨立腳本執行：

```bash
git clone --depth 1 https://github.com/wei18/upkeep ~/.cache/upkeep
cd ~/.cache/upkeep && npm ci
./scripts/local-audit.sh /path/to/repo --out ~/upkeep-report.html
```

| 參數 | 預設值 | 對應 CI input |
|---|---|---|
| `--model` | `claude-opus-4-8` | `model` |
| `--rubric-lang` | `en` | `rubric_lang` |
| `--max-turns` | `30` | `max_turns` |
| `--out` | `./upkeep-report.html` | report artifact |

**需求**：已登入的 `claude` CLI（Pro/Max 訂閱；不需要 `setup-token`，也不需要 GitHub 存取權）、Node 20+、git。

**輸出**：同一份自包含的 HTML 報告（預設為 `upkeep-report.html`）加上終端機摘要。本機執行不會建立 GitHub issue。

偏好手動安裝 skill？把 [`skills/upkeep-audit/`](../../skills/upkeep-audit/) 複製到 `~/.claude/skills/`。

## 在 CI 自動化

同一組稽核團隊，按排程執行。在你的 repo 中建立 `.github/workflows/audit.yml`：

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

**前置需求**

- 一個名為 `CLAUDE_CODE_OAUTH_TOKEN` 的 repo secret——請在本機執行 `claude setup-token` 產生（需 Claude Pro/Max 訂閱，用量計入訂閱配額）。
- 如上所示的 `permissions` 區塊（`contents: read` + `issues: write` + `id-token: write`）。

**輸出**

- 一個標記為 `audit` 的 GitHub issue——每次執行更新同一筆（upsert），不重複建立。
- 一份自包含的 HTML 報告，以 `report-html` workflow artifact 形式上傳。追蹤 issue 會直接連到它；否則可在該次 run 的 **Artifacts**（Actions → 那次 run）找到，或用 `gh run download <run-id> -n report-html` 下載。GitHub 的 artifact 是可下載的 zip，並依你 repo 的保留設定過期。

> 還在用 `@v1`？它仍可運作但已凍結——把 tag 換成 `@v2` 即可。介面完全相同。

### 或作為 Marketplace action

偏好熟悉的 `- uses:` step 語法，或想讓 Upkeep 出現在
[GitHub Marketplace](https://github.com/marketplace)？改用 **Upkeep Audit**
action——同一套引擎、同樣的輸入參數，但審查員會依序執行，而非並行（原因見
[`docs/why-reusable-workflow.md`](why-reusable-workflow.md)，說明為何上方的
reusable workflow 才是主要路徑）：

```yaml
name: repo audit
on:
  schedule:
    - cron: '0 3 * * 1'   # weekly, Monday 03:00 UTC
  workflow_dispatch:

permissions:
  contents: read
  issues: write
  id-token: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: wei18/upkeep@v2
        with:
          model: claude-opus-4-8               # optional
          issue_label: audit                    # optional; default: audit
          rubric_lang: en                       # optional; reviewer language: en | zh-TW
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

與上方相同的需求：一個名為 `CLAUDE_CODE_OAUTH_TOKEN` 的 repo secret（由
`claude setup-token` 產生）以及 `permissions` 區塊，現在放在 job 本身上，
因為 step action 無法自行宣告 permissions。

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

- **Workflow 輸入參數**（上方呼叫端的 `with:` 區塊；本機則為對應的腳本參數）控制*引擎怎麼跑*：`model`、`max_turns`、`issue_label`、`rubric_lang`。
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
- [`docs/why-reusable-workflow.md`](why-reusable-workflow.md) — 為何 CI 層是 reusable workflow 而非 `- uses:` step action
