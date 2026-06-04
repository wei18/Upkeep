# e2e 程序（對 wei18/Sudoku）

前置：upkeep 已 push 到 `wei18/upkeep`（分支或 tag）；`wei18/Sudoku` 有 repo secret `ANTHROPIC_API_KEY`。

## 1. 暫時把子 action / workflow 的 ref 指向 dev 分支
本機在 upkeep：把 `.github/workflows/audit.yml` 內四個 `@v1` 暫改為 `@<dev-branch>`，push 該分支。
（release 時改回 `@v1` 並打 tag。）

## 2. 在 Sudoku 加一個觸發 workflow
於 `wei18/Sudoku` 建 `.github/workflows/audit.yml`：
```yaml
on: { workflow_dispatch: {} }
jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@<dev-branch>
    secrets:
      anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```
push 後在 Actions 頁 `Run workflow`。

## 3. 驗收檢查點
- [ ] `discovery` job 綠：artifacts 有 `inventory`；其 `reviewers` 輸出為 6 個（i18n 預設關）。
- [ ] `review` matrix 跑出 6 個 job（`fail-fast:false`）；各自上傳 `findings-<reviewer>`。
- [ ] artifact 路徑（已按 GHA v4 語意接線；此處為確認）：reviewer 上傳的 artifact 內含 `findings/<r>.json`；synthesis/report download 到 **workspace root**（`path: ${{ inputs.target }}` = `.`）+ `merge-multiple`，重建為 `./findings/<r>.json`，正是 `report.ts` 讀的位置；inventory 同理寫在 workspace。確認 run log 中 findings/inventory 落點正確、`report` 抓到非空 findings。
- [ ] 每份 findings 通過 `validateReviewerOutput`（finalize 已保證；抽查一份 LLM 真實輸出格式正確）。
- [ ] `synthesis` job 即使某 reviewer 失敗仍跑（`if: always()`）；產出 `synthesis`。
- [ ] `report` job 產出 `report-html` artifact，且在 Sudoku 開出一個帶 `audit` 標籤的 issue；再跑一次確認是 edit 同一個 issue（upsert，靠 `ISSUE_MARKER`）而非開新 issue。
- [ ] HTML 下載可離線開、severity 篩選可用、無外部資源。

## 4. 觀察與調參
- token 成本：看各 reviewer job 用量；必要時調 `max_turns` 或 reviewer 範圍。
- 若 claude-code-action 沒寫出 findings：檢查 prompt 是否成功讀到 `reviewer-prompt.txt`、`--allowedTools` 是否含 `Write`。

## 5. 記錄結果
把首次 e2e 的 run URL、發現的調整項記在本檔末，作為 release 前依據。
