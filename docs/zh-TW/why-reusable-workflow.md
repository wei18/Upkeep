# 為何 Upkeep 是 reusable workflow（而非 step action）

多數 GitHub Actions 是以 **step** 形式使用：

```yaml
steps:
  - uses: actions/checkout@v4
```

Upkeep 則是以 **job** 形式使用，指向一個 workflow 檔：

```yaml
jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@v2
```

第二種寫法相較於常見的 `- uses: owner/action@v1` 顯得陌生，會被問為什麼。它其實是 **reusable workflow**（`on: workflow_call`）標準、官方文件記載的語法——見 [GitHub: Reuse workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)。以下說明 Upkeep 為何這樣設計。

## 原因：平行、失敗隔離的 reviewer 需要 `strategy.matrix`

Upkeep 會分派一組 reviewer。我們希望每位 reviewer：

- **平行**執行——一次完整稽核不該花掉單一 reviewer 牆鐘時間的六倍；以及
- **失敗隔離**——某位 reviewer 失敗（逾時、API 抽風）不能中斷其他人。

「把同一單元平行、獨立地跑很多次」對應的原生 GitHub 機制就是 `strategy.matrix`。**matrix 是 job 層級的功能**：只有 *workflow* 能宣告 job 與 matrix，*action* 不能。要把 reviewer 扇出（fan out）到多個平行、隔離的 matrix job，Upkeep 必須是 reusable workflow。

## 為何不乾脆做成 action？

action 有兩種，兩種都無法表達這種扇出：

- **JavaScript / Docker action**——單一進入點（例如 `main: dist/index.js`）。它無法 `uses:` 另一個 action，因此無法把 LLM 工作委派給 [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)，得自己呼叫 Claude；而且它仍無法平行跑 job。
- **Composite action**——以 **一個** job 內的一連串 *step* 執行。它*可以* `uses:` 其他 action（故能呼叫 `claude-code-action`），但沒有 matrix，reviewer 會在單一 job 內**循序**執行。

所以 composite action（`- uses: wei18/upkeep@v2`）*是*做得到的——代價是 reviewer 變循序。Upkeep 刻意選擇 reusable workflow 形式，以保持 reviewer 平行且各自隔離。對排程稽核而言，較慢的循序路徑其實可接受；但我們偏好平行與乾淨的失敗隔離。

## 你實際放棄的是什麼

只有呼叫端語法。用 `jobs.<id>.uses: owner/repo/.github/workflows/file.yml@ref` 取代 `- uses: owner/action@ref`。其餘一切都跟 action 一樣：用 `with:` 傳 inputs、用 `secrets:` 傳 secrets、用 `@v1` 釘版本。
