# upkeep

可重用的 GitHub Action（composite）。掃描 repo，分派一組各有專業的 subagent reviewer，檢查 code / 文件 / spec / 視覺圖 / icon / flow 等是否 up-to-date、符合 repo 自身規範、有無重複檔與孤兒檔，產出 HTML 報告（artifact）＋ tracking issue。

> **狀態：設計階段，尚未實作。** 設計細節見 [`docs/design.md`](docs/design.md)。

## 預期用法（實作後）

```yaml
# 呼叫方 repo 的 .github/workflows/audit.yml
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: wei18/upkeep@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

設定（全可選）見 spec §5：`.claude/audit.yml`。
