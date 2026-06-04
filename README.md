# upkeep

可重用的 GitHub Workflow（`on: workflow_call`）。掃描 repo，分派一組各有專業的 subagent reviewer，檢查 code / 文件 / spec / 視覺圖 / icon / flow 等是否 up-to-date、符合 repo 自身規範、有無重複檔與孤兒檔，產出 HTML 報告（artifact）＋ tracking issue。設計細節見 [`docs/design.md`](docs/design.md)。

## 用法

在你的 repo 建立 `.github/workflows/audit.yml`：

```yaml
name: repo audit
on:
  schedule:
    - cron: '0 3 * * 1'   # 每週一 03:00 UTC 全掃
  workflow_dispatch:       # 也可手動觸發

jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@v1
    with:
      model: claude-opus-4-8     # 可選
      issue_label: audit         # 可選；預設 audit
    secrets:
      anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

需求：
- repo secret `ANTHROPIC_API_KEY`。
- 預設權限已含 `contents: read` + `issues: write`（workflow 自帶）。

產出：
- 一個帶標籤 `audit` 的 tracking issue（每次 run upsert 同一個）。
- 一份 self-contained HTML 報告，存在該次 workflow run 的 artifacts（`report-html`）。

可選設定檔 `.claude/audit.yml`（全可選）見 [`docs/design.md`](docs/design.md) §5。
