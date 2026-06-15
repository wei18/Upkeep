# Upkeep 運作原理

## 問題背景

Repo 會隨時間累積偏差。函式重構了，但文件區塊仍停留在舊版本。規格說明描述的行為在三個 sprint 前就已修改。翻譯版的 README 落後英文原版一個版本。圖示檔案換了，但舊檔案還留在 commit 紀錄裡。這些問題不會導致 CI 失敗——它們只是悄悄侵蝕所有書面內容的可信度。

定期的人工審查能發現其中一部分，但這需要同時在腦海中保有每一份 artifact 的完整脈絡。這正是一組專責 AI 審查員最擅長處理的事。

## Pipeline 架構：展開 → 彙整 → 報告

Upkeep 有兩個共用同一引擎的進入點：CI 用的可重用 `workflow_call` workflow，以及在本機執行的 Claude Code skill / plugin（或純腳本）。兩者的 pipeline 都是相同的五個階段：Discovery、Consolidate 與 Report 為確定性（無 LLM）；平行的 reviewers 與 Synthesis 才是 LLM 驅動的階段。

**1. 探索（Discovery）**

探索步驟走訪整個 repository，產生結構化的檔案清單：原始碼、文件、規格說明、架構圖、圖片、圖示、locale 檔案，以及慣例文件（CLAUDE.md、`.claude/skills`、workflow 定義）。此清單是所有審查員共用的輸入資料。

**2. 並行審查員（fan-out）**

每個已啟用的審查員以隔離方式執行——在 CI 中是獨立的 matrix job，在本機則是平行的 `claude -p` 子行程。它們並行運行且具容錯性——單一審查員失敗不會阻擋其他審查員繼續執行。每個審查員接收檔案清單與其專責範疇，並將發現寫入結構化輸出。

**3. 彙整（Synthesis）**

單一彙整步驟讀取所有審查員的發現，識別跨審查員的共同主題——例如某個目錄集中出現慣例偏差，或多個審查員基於不同原因獨立標記同一份檔案。彙整步驟在各審查員的詳細結果之上，產生一份執行摘要。

**4. 整併（Consolidate）**

確定性步驟將多個審查員對同一檔案提出的重複發現合併，保留嚴重度最高的代表項，聯集其 reviewers 與相關檔案，並依嚴重度排序。不涉及 LLM。

**5. 報告（Report）**

確定性報告步驟將所有內容渲染為自包含的 HTML 檔案（無任何外部相依）。在 CI 中，它還會 upsert 單一 GitHub 追蹤 issue，並在每次執行時重複使用，讓你的 issue tracker 保持整潔；在本機執行時，它改為將摘要印到終端機／chat，完全不碰 GitHub。

## 審查員

| 審查員 | 檢查項目 |
|---|---|
| `docs_staleness` | 已脫離所描述程式碼的文件；與基礎語言版本不同步的多語言 README 與翻譯文件 |
| `code_hygiene` | 死碼路徑、未使用的 export、長期留存的 commented-out 區塊 |
| `spec_flow` | 內容不再符合實際實作的規格說明、架構圖與流程圖 |
| `visual_icon` | 過時、不一致，或與現行 UI / 品牌形象不符的圖片與圖示 |
| `duplicate_orphan` | 重複檔案（不同名稱或路徑下內容相同或近乎相同）及已提交但從未被引用的孤立資源 |
| `convention` | 偏離 repo 自身宣告慣例的情況——CLAUDE.md 規則、`.claude/skills` 模式，以及 workflow 標準 |
| `i18n` | 各 locale / 翻譯檔案之間的一致性（預設關閉；透過 `.claude/audit.yml` 選擇啟用） |

## 不預設真實來源

當兩份 artifact 產生分歧——例如規格說明描述行為 X，但程式碼實作了行為 Y——Upkeep 不會自動判定其中一方過時。任何一份都可能是舊的那個。Upkeep 改為以佐證資料回報此分歧：每份檔案的 git 更新時間、在其他檔案中找到的交叉引用，以及任何明確的版本標記。由人來決定如何修正。

## 僅回報，絕不修改

Upkeep 對你的 repository 內容沒有寫入權限。它只讀取檔案，並建立或更新單一 GitHub issue。它絕不會修改、重新命名或刪除你 repo 中的任何檔案。

## 輸出

**HTML 報告** — 在 CI 中，每次執行時以 `report-html` workflow artifact 形式上傳；在本機則寫入你指定的路徑（預設 `./upkeep-report.html`）。完全自包含，無需伺服器即可在本機開啟。包含執行摘要、各審查員的發現，以及每項發現所引用的佐證資料。

**GitHub 追蹤 issue**（僅限 CI）— 首次執行時建立，後續每次執行時更新（upsert）。預設標記為 `audit`。提供持久且可連結的 repo 健康狀況紀錄，不會以重複 issue 污染你的 issue tracker。在本機執行時略過此步驟，改為印出摘要。
