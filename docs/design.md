# Repo Audit Action — 設計文件

- 狀態：設計定案，待寫實作計畫
- 日期：2026-06-04
- 位置：獨立 repo `repo-audit-action/`，spec 於 `docs/design.md`（見 §6）
- 自我約束：**本 spec 是 SSOT，需隨實作持續 up-to-date**（此工具本身即在抓 drift，spec 不得漂移）

---

## 0. 目標

一個**可重用的 GitHub Action（composite）**，任何 repo 可 `uses:` 引用。它掃描 repo 內容，分派一組各有專業的 subagent reviewer，檢查資料（code / doc / spec / 視覺圖 / icon / flow 等）是否：

- up-to-date（與真實程式碼/近期 commit 是否漂移）
- 符合 repo **自身**的規範
- 有無重複檔
- 有無用不到（孤兒）的資料

輸出：HTML 深度報告（artifact）＋ GitHub tracking issue（摘要入口）。

核心原則：**約定優於配置**——能從 repo 現況推斷的，絕不要求人手填；config 過舊本身就是 drift 來源，必須避免。

---

## 1. 架構與執行流程

形態：composite GitHub Action（`action.yml`），內部以官方 `claude-code-action` 為 LLM 引擎。需要呼叫方提供 `ANTHROPIC_API_KEY` secret。

觸發：`schedule`（cron 定期全掃）＋ `workflow_dispatch`（手動，可帶範圍參數）。
> 「重複檔 / 孤兒檔 / 全域 up-to-date」需要全域視角，PR 增量做不到，故以全掃為主。

單次 run 資料流：

```
觸發 (schedule / workflow_dispatch)
  │
  ▼
[1] Discovery（確定性，非 LLM 重活）
    掃 repo → 檔案清單 + 模態分類(code/doc/spec/visual/flow/icon...)
    讀規範來源：CLAUDE.md、.claude/skills、.claude/workflows、
                .github/workflows、.claude/audit.yml(若有)
  │
  ▼
[2] Dispatch（lead agent）
    依啟用的 reviewer 平行派發 subagent
    每位帶：負責檔案子集 + 合成 rubric(內建預設 ⊕ repo 規範)
  │
  ▼
[3] Review（N× subagent 平行，唯一 LLM 成本集中處）
    各自輸出結構化 findings（schema 見 §4）
  │
  ▼
[4] Consolidate（確定性）
    跨 reviewer 同檔問題合併、去重、排序(severity × confidence)
  │
  ▼
[5] Report（確定性，零 LLM 成本）
    ├─ 產出 self-contained 單檔 HTML 報告 → upload artifact
    └─ 建立/更新 tracking issue（markdown 摘要 + 連到 HTML artifact）
```

要點：
- Discovery / Consolidate / Report 是**確定性編排骨架**；只有 Review 是 LLM 語意判斷。
- 分派沿用 Leader/Developer 精神：lead=Leader（派活/彙整/審），reviewer=專業 Developer。
- findings 用統一 schema，讓 Consolidate 可機械化去重排序。

---

## 2. Reviewer 團隊

內建 **7 位**（6 開 1 關）：

| Reviewer | 範圍 | 主要抓的問題 | 預設 |
|---|---|---|---|
| `docs_staleness` | README、文件、註解 | 內容陳舊、與 code 漂移、過期連結 | on |
| `code_hygiene` | 原始碼 | 死碼、用不到的檔/函式、與 spec 不符 | on |
| `spec_flow` | spec、流程圖、狀態機 | flow 與實作不一致、spec 過時 | on |
| `visual_icon` | 圖片、icon、設計稿 | 未使用素材、重複圖、尺寸/命名不符規範 | on |
| `duplicate_orphan` | 全 repo | 重複檔、孤兒檔、無人引用資源 | on |
| `convention` | 全 repo | 違反 repo 自身 skills/workflows/CLAUDE.md 規範 | on |
| `i18n` | 在地化字串、`.lproj` 等 | 缺翻譯、未使用 key、與 base 不同步 | **off** |

第一版**不做動態自訂 reviewer**；i18n 做成內建（預設關）即覆蓋常見需求（YAGNI）。

### Rubric 三層合成（優先序由低到高）

```
內建預設 rubric（action 自帶，定義該專業抓什麼）
   ⊕ repo 規範自動探索（CLAUDE.md / .claude/skills / .claude/workflows
                         中與該領域相關者）
   ⊕ audit.yml 顯式指定（reviewers.<name>.rubric 指向的 repo 檔）← 最高優先
```

repo 有自己的標準時優先用 repo 的。`convention` 幾乎全靠 repo 自身規範；`visual_icon` 多靠內建預設＋repo 設計規範（若有）。

---

## 3. SSOT 處理原則（不預設誰是真實來源）

問題：spec/code 不一定是 SSOT；有時**過期的反而是 spec 本身**。預設固定方向會誤報。

原則：**reviewer 不預設 SSOT，只偵測「分歧」，方向交給證據＋分級裁決。**

1. **偵測分歧、不下定論**：報「A 說 X，B 說 Y，不一致」，非「B 過時了」。
2. **附證據訊號**：git 最後修改時間 / commit 近期度、被引用次數、引用方向。
3. **分級裁決**：
   - 證據強（如某檔半年未動、相關 code 上週大改）→ 建議裡明講方向（「README 較舊，建議更新」），仍標 `needs-confirmation`。
   - 證據弱 → 標「drift，方向待裁決」。
   - **任何情況都不自動修改**（自動修留第二階段）。
4. **SSOT 不靠宣告檔**：方向全靠推斷，避免宣告檔自己過舊。真有固定政策的 repo 才用 escape hatch 覆蓋（非必要、不鼓勵）。

---

## 4. findings schema

每位 reviewer 對每個問題輸出：

```jsonc
{
  "file": "path/to/file",          // 主體檔（跨檔問題放主檔，related 補充）
  "related": ["path/..."],          // 關聯檔（可空）
  "reviewer": "docs_staleness",
  "category": "staleness | duplicate | orphan | convention | inconsistency | ...",
  "problem": "人類可讀的問題描述",
  "evidence": "支撐證據（git 時間、引用關係、具體不符之處）",
  "suggestion": "建議修法（分級裁決下可能含方向）",
  "severity": "high | medium | low",
  "confidence": "high | medium | low",
  "ssot_direction": "stale_a | stale_b | uncertain | n/a",
  "status": "ok"                    // reviewer 層級：ok | failed
}
```

Consolidate 以 `file` + `category` 為鍵合併跨 reviewer 重複；排序鍵 = severity × confidence。

---

## 5. 設定檔 `.claude/audit.yml`（全可選，不存在也能完整運作）

`scan` 與 `ssot` **不放進設定**（會自己過舊）；改為自動推斷。

```yaml
# .claude/audit.yml —— 全可選；通常不需要此檔
version: 1
reviewers:               # 只列「要關掉/調範圍/開 i18n」的，其餘照預設
  visual_icon: { enabled: false }
  i18n:        { enabled: true }
report:
  issue_label: "audit"   # 預設即 "audit"，要改才寫
  min_severity: "low"    # 低於此不進 issue（仍進 HTML 完整報告）
```

### 自動推斷（不需設定）

- **掃描範圍**：遵守 repo `.gitignore`；自動跳過 binary / lockfile / build 產物；文字檔內建 100KB 上限（見 §7 模態分流）。
- **SSOT 方向**：全靠證據推斷（§3），無宣告檔。

---

## 6. Repo 落點（已定）

此 action 發佈成可被 `uses:` 引用者，故獨立成 repo：`/Users/zw/GitHub/Wei18/repo-audit-action/`（已 `git init`）。

預期結構：

```
repo-audit-action/
├── action.yml                       # composite action 進入點
├── README.md                        # 用法（uses: 範例、需要的 secret/權限）
├── docs/design.md                   # 本 spec（living document）
├── reviewers/                       # 7 位內建 reviewer 的預設 rubric
├── scripts/                         # Discovery / Consolidate / Report 確定性骨架
└── test/                            # 單元 + 契約 + e2e（樣本見 §10）
```

---

## 7. 模態分流（取代「一條 byte 上限打天下」）

100KB 上限只該管「當文字塞進 LLM 的檔」，不該套到圖。

| 檔案型態 | 處理 | 100KB byte 上限 |
|---|---|---|
| 文字類（code/doc/spec/`.md`） | 當文字讀；超限→**分塊或先摘要再點名深讀**，不靜默丟 | 套用（超限→分塊） |
| 向量/文字型流程圖（`.svg`/`.mmd`/`.dot`/`.puml`） | 當**原始碼文字**讀（語意可 diff） | 套用（通常很小） |
| 點陣圖（png/jpg/webp…） | byte 大小無關；用**尺寸/百萬像素預算**，送 vision 前先 downscale | **不套用** |

關鍵：visual reviewer 多數工作不需「看」圖——
- 重複圖 → 檔案 hash（精確/感知）
- 孤兒圖 → 引用關係圖
- 命名/尺寸規範 → metadata
- **只有「圖內容是否符合設計/spec」才送 vision（先 downscale）**

唯一會被跳過的是無法處理的超大不明 binary，且報告明列 `未檢視：超大 binary`，不靜默吞。

---

## 8. 韌性 / 降級

| 失敗情境 | 處置 |
|---|---|
| 某 reviewer subagent 掛掉/超時 | 標 `status: failed`，其餘照常產出；報告與 issue 明列「本次缺 X」 |
| Anthropic API 暫時錯誤 | 該 subagent retry（指數退避，上限 2 次）；仍失敗才降級 |
| 全部 reviewer 失敗 | workflow fail，不建空 issue |
| Discovery 掃到 0 檔 | 正常結束，留 log，非錯誤 |

原則：Review 階段子失敗一律隔離；確定性骨架失敗才讓整個 run fail。

---

## 9. 成本控制

- 100KB／檔上限 + 跳過 binary/lockfile/build（§5、§7）
- **分層送讀**：先送清單＋摘要，由 reviewer 點名深讀，不無腦全文塞入
- `max_files_per_reviewer` 安全閥（預設 300）；超過時 lead 依「近期 commit 觸及 + 高引用度」取前 N，報告註明「已截斷」
- HTML / issue 組裝是純文字，**零 LLM 成本**

---

## 10. 測試策略

測試樣本：遠端真實 repo **https://github.com/wei18/Sudoku**（取代自建 fixture）。

- **確定性層 → 單元測試（TDD）**：Discovery 分類、Consolidate 去重排序、HTML/issue 組裝，不碰 LLM。
- **LLM 層 → 契約測試**：驗證 subagent 輸出**符合 findings schema**（欄位齊全、severity/confidence/ssot_direction 在合法值域），不逐字斷言內容。
  - CI：用**錄製假 response** 做 schema 契約測（省錢、穩定）。
  - 真打 API：僅手動 / release 前 smoke。
- **端到端 smoke**：對 Sudoku repo 跑完整 action，斷言產出 HTML/issue 存在、findings 合 schema、抓到合理數量問題（不逐字斷言）。

---

## 11. 範圍邊界（第一版不做）

- 自動修 PR（自動改 README/刪孤兒檔）——留第二版
- 動態自訂 reviewer——i18n 內建已覆蓋
- PR 增量模式——以全掃為主
- SSOT 宣告檔——改為純推斷
