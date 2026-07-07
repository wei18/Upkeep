# Upkeep — 設計文件

- 狀態：已實作並釋出；已重新定位為 v2（Claude Code plugin + skill 發佈）— 本 spec 追蹤已釋出的行為
- 日期：2026-06-04（設計）；2026-06-05 釋出；v2 重新定位 2026-06-12
- 位置：獨立 repo `upkeep/`，spec 於 `docs/design.md`（見 §6）
- 自我約束：**本 spec 是 SSOT，需隨實作持續 up-to-date**（此工具本身即在抓 drift，spec 不得漂移）

---

## 0. 目標

一個**可重用 GitHub Workflow（`on: workflow_call`）**，任何 repo 在自己的 workflow 以 job-level `uses: wei18/upkeep/.github/workflows/audit.yml@v2` 引用。它掃描 repo 內容，分派一組各有專業的 subagent reviewer，檢查資料（code / doc / spec / 視覺圖 / icon / flow 等）是否：

- up-to-date（與真實程式碼/近期 commit 是否漂移）
- 符合 repo **自身**的規範
- 有無重複檔
- 有無用不到（孤兒）的資料

輸出：HTML 深度報告（artifact）＋ GitHub tracking issue（摘要入口）。

核心原則：**約定優於配置**——能從 repo 現況推斷的，絕不要求人手填；config 過舊本身就是 drift 來源，必須避免。

---

## 1. 架構與執行流程

形態：**可重用 workflow**（`.github/workflows/audit.yml`，`on: workflow_call`），內部以官方 `claude-code-action` 為 LLM 引擎。需要呼叫方提供 `CLAUDE_CODE_OAUTH_TOKEN` secret（`secrets: inherit` 或顯式傳入）。
> 為何不是 composite action：composite action 是單一 job 的 step 序列，**不能用 `strategy.matrix`**；matrix（每 reviewer 一個平行 job）只能在 workflow job 層做，故採 reusable workflow（已查 GitHub 官方文件確認）。

**編排模型：fan-out → reduce（matrix + synthesis），無 LLM lead。** 每個啟用的 reviewer 各跑一個獨立 matrix **job**（內含一個 `claude-code-action` step；`fail-fast: false` + `continue-on-error` 做失敗隔離），各自輸出結構化 findings；之後一個 synthesis job（單一 LLM）讀全部 findings 做語意級跨 reviewer 關聯。不依賴「單 run 內 spawn subagent」（該能力雖經實證可行，但 per-job 在確定性/隔離/零殘留風險上更佳）。

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
[2] Review（matrix：每個啟用 reviewer 一個 claude-code-action step）
    GHA matrix 原生平行、失敗隔離；唯一 LLM 成本集中處
    每 step 帶：inventory + 負責檔案子集 + 合成 rubric(內建預設 ⊕ repo 規範)
    各自輸出 findings/<reviewer>.json（schema 見 §4）
  │
  ▼
[3] Synthesis（單一 claude-code-action，唯一「融會貫通」的腦）
    讀 全部 findings/*.json + inventory（精簡結構化素材，不重讀整 repo）
    → 語意級跨 reviewer 關聯、去重、系統性主題、優先級敘事
    → synthesis.json
  │
  ▼
[4] Consolidate（確定性）
    機械式合併 findings + synthesis、key 去重、排序(severity × confidence)
  │
  ▼
[5] Report（確定性，零 LLM 成本）
    ├─ 產出 self-contained 單檔 HTML 報告 → upload artifact
    └─ 建立/更新 tracking issue（markdown 摘要 + 連到 HTML artifact）
```

要點：
- Discovery / Consolidate / Report 是**確定性編排骨架**；Review 與 Synthesis 是 LLM。
- **無 LLM lead**：編排＝GHA workflow（matrix）＋ Node。Review 階段各 reviewer 完全獨立（不需互通）；跨領域綜觀由 Synthesis 這個 reduce step 達成。
- findings 用統一 schema，讓 Synthesis 與 Consolidate 都能機械化處理。

### 本機執行（skill / 腳本）

同一套 pipeline 可透過 `scripts/local-audit.sh <target>` 在本機執行：discovery → 平行 `claude -p` reviewer 子程序 → synthesis → report。所有中間產物（inventory、prompts、findings、synthesis）都放在 `mktemp` 工作目錄，透過 `--add-dir` 授權給 Claude——不會寫入目標 repo。本機執行產出同一份 self-contained HTML 報告；不會 upsert GitHub issue，而是把 issue markdown 印出作為終端機摘要。`skills/upkeep-audit/SKILL.md` 是包裝此腳本的 Claude Code 薄包裝：維護 `~/.cache/upkeep` 的 clone、執行稽核、在對話中摘要 findings。此 skill 以三種方式發佈，皆指向同一個目錄：作為 Claude Code plugin（repo 根目錄的 `.claude-plugin/marketplace.json` 將 `skills/upkeep-audit/` 列為名為 `upkeep` 的 single-skill plugin，透過 `/plugin install upkeep@upkeep` 安裝）、透過 `npx skills add wei18/upkeep --skill upkeep-audit`（vercel-labs/skills 扁平佈局），或手動複製到 `~/.claude/skills/`。發佈僅是打包層面——CI workflow 仍是直接的 pipeline 入口，不會繞經此 skill。

### Marketplace Composite Action

第三種整合形態把同一套引擎包成 repo 根目錄的一個 composite action（`action.yml`），提供慣用的 `- uses: wei18/upkeep@v2` step 語法，並可上架 [GitHub Marketplace](https://github.com/marketplace)。因為 composite action 是單一 job、不能用 `strategy.matrix`，它的 `discovery` → `reviewer`（×7）→ `synthesis` → `report` 各 step 會依序執行而非並行——同一套引擎、同樣的輸入，只是在啟用較多 reviewer 的 repo 上會較慢。為何上方的 reusable workflow 仍是主要路徑，見 `docs/why-reusable-workflow.md`。這裡的發佈同樣僅是打包層面，與 skill 相同：`action.yml` 呼叫的是 reusable workflow 所用的同一批 `.github/actions/<x>@v2` 子 action。

---

## 2. Reviewer 團隊

內建 **7 位**（6 開 1 關）：

| Reviewer | 範圍 | 主要抓的問題 | 預設 |
|---|---|---|---|
| `docs_staleness` | README、文件、註解、**多語 README/doc 變體** | 內容陳舊、與 code 漂移、過期連結、**多語版本與 base 不同步** | on |
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

**Reviewer rubric 語言（`rubric_lang`）**：內建 rubric 依語系分置於 `reviewers/<locale>/`（例如 `reviewers/en/`、`reviewers/zh-TW/`）。`rubric_lang` 這個 workflow input（預設 `en`）決定 reviewer 與 synthesis 使用哪一套。

### 2.1 多語文件同步偵測（multilingual doc-set）

由 `docs_staleness` 負責（非 `i18n`——`i18n` 管 code 層在地化字串如 `.lproj`/`Localizable.strings`；文件翻譯漂移屬 doc 範疇）。

- **目錄約定**：多語文件放在 `docs/<locale>/<name>.md`（如 `docs/zh-TW/overview.md`）。唯一例外是 repo 根的 `README.md`＝**英文 base**（GitHub 慣例），其各語譯本在 `docs/<locale>/README.md`。
- **base 語言**：`en`（根 `README.md` 與 `docs/en/*` 為權威來源）。
- **支援語言（最多 6）**：`en`(base)、`zh-TW`、`zh-CN`、`ja`、`ko`（預留第 6）。
- **偵測**：以 base（`docs/en/<name>.md`，README 則為根 `README.md`）為對照，對每個 `docs/<locale>/<name>.md` 報「落後/缺漏/過時」。沿用 §3 原則——附證據（git 近期度：base 改了但某語譯本沒跟），不預設「翻譯一定是該更新的那方」，但 base 較新時通常傾向翻譯落後。
- **分組**：reviewer 由「同名檔跨 `docs/<locale>/` 子目錄」分組（README 另把根 `README.md` 與 `docs/<locale>/README.md` 視為同組）。
- **Dogfood**：本 repo 自身全套使用者文件（README、overview、design、why-reusable-workflow、plans）皆多語化於 `docs/<locale>/`，同時作為此能力的真實測試樣本（見 §10）。

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

每個 reviewer step 輸出一份 `findings/<reviewer>.json`：`{ reviewer, status: "ok"|"failed", findings: Finding[] }`（單一 reviewer 失敗時 `status:"failed"`、`findings:[]`，不影響其他）。

**Consolidate 去重/排序（確定性）**：以 `file` + `category` 為鍵合併跨 reviewer 重複——同鍵取「代表 finding」= severity×confidence 最高者（平手以 reviewer 列舉序為穩定 tiebreak），`reviewers[]` 為該鍵所有回報者的聯集、`related[]` 取聯集。排序鍵 = severity desc → confidence desc → file asc。

### 4.1 synthesis 輸出

Synthesis step 讀全部 `findings/*.json` + inventory，輸出 `synthesis.json`。**以 file 路徑引用 findings（不用整數索引——對 LLM 較穩定、人類可讀）**：

```jsonc
{
  "themes": [                         // 跨 reviewer 的系統性主題
    {
      "title": "簡述系統性問題",
      "narrative": "為何這些 finding 指向同一根因",
      "related_files": ["path/a", "path/b"],  // 此主題涵蓋的檔路徑
      "priority": "high | medium | low"
    }
  ],
  "semantic_duplicates": [[ "reviewer|file|category", "reviewer|file|category" ]], // 語意重複的 finding 鍵群
  "executive_summary": "整體健康度的一段話摘要",
  "status": "ok"                      // synthesis 失敗→report 仍出 raw findings
}
```

Report 同時用 raw findings 與 synthesis；synthesis 失敗或不存在時降級為只呈現 raw findings（無 themes/exec summary）。

---

## 5. 設定檔 `.claude/audit.yml`（全可選，不存在也能完整運作）

`scan` 與 `ssot` **不放進設定**（會自己過舊）；改為自動推斷。

```yaml
# .claude/audit.yml —— 全可選；通常不需要此檔
version: 1
ignore:                  # 可選：從整個稽核中排除的 glob 路徑（所有 reviewer）
  - "docs/*/plans/**"    # 例如不想被稽核的封存設計記錄
reviewers:               # 只列「要關掉/調範圍/開 i18n」的，其餘照預設
  visual_icon: { enabled: false }
  i18n:        { enabled: true }
report:
  issue_label: "audit"   # 預設即 "audit"，要改才寫
  min_severity: "low"    # 低於此不進 issue（仍進 HTML 完整報告）
```

> 設定鍵以 `snake_case` 顯示（`issue_label`、`min_severity`）；`snake_case` 與內部 `camelCase`（`issueLabel`、`minSeverity`）皆可接受。

### 自動推斷（不需設定）

- **掃描範圍**：遵守 repo `.gitignore`；自動跳過 binary / lockfile / build 產物；文字檔內建 100KB 上限（見 §7 模態分流）。
- **SSOT 方向**：全靠證據推斷（§3），無宣告檔。

---

## 6. Repo 落點（已定）

此 action 發佈成可被 `uses:` 引用者，故獨立成 repo。本地目錄 `/Users/zw/GitHub/Wei18/repo-audit-action/`（已 `git init`）；**發佈/套件名為 `Upkeep`**（`uses: wei18/upkeep@v2`）——本地資料夾名與發佈名不同是刻意保留。

預期結構：

```
repo-audit-action/                   # 本地目錄（發佈名 Upkeep）
├── action.yml                        # composite action（Marketplace 上架用）：`uses: wei18/upkeep@v2`，reviewer step 依序執行
├── .github/
│   ├── workflows/audit.yml          # 可重用 workflow（on: workflow_call）：jobs/matrix 編排
│   └── actions/                     # composite 子 action（被 workflow 的 job uses，自帶 Upkeep 程式碼）
│       ├── discovery/  reviewer/  synthesis/  report/
├── .claude-plugin/marketplace.json  # plugin marketplace 清單（plugin 名稱：upkeep，source：./skills/upkeep-audit）
├── README.md                        # 英文 base 用法（job-level uses: 範例、secret/權限）+ 語言切換列
├── docs/
│   ├── en/      README 無（根即 en）；overview.md  design.md  why-reusable-workflow.md  plans/
│   ├── zh-TW/   README.md  overview.md  design.md  why-reusable-workflow.md  plans/
│   ├── zh-CN/ … ja/ … ko/   （同上各語一套）
│   └── （多語使用者文件一律 docs/<locale>/；root README.md 為 en base）
├── reviewers/<locale>/              # 7 位內建 rubric + _reviewer-prompt + _synthesis-prompt，依語系分置（en、zh-TW）；由 rubric_lang 選擇
├── skills/upkeep-audit/             # Claude Code skill：本機執行薄包裝（clone 到 ~/.cache/upkeep）
│   └── .claude-plugin/plugin.json   # plugin manifest（single-skill 佈局；SKILL.md 位於 plugin 根目錄）
├── scripts/local-audit.sh           # 本機 pipeline 協調器（與 CI 同流程；中間產物放暫存目錄）
├── src/                             # discovery/consolidate/report/matrix/prompt-bundle 等確定性 TS
└── test/                            # 單元 + 契約 + e2e（樣本見 §10）
```

> 封存說明：`docs/<locale>/plans/` 子樹是原始逐步實作計畫的刻意**封存**（每語一套）。它刻意不被任何導覽索引連入，且其 fenced 區塊（程式碼與嵌入的文件範本）一律保留 zh-TW 源的**逐字**內容——因此這些檔案的空 `referencedBy` 與 fence 內的非英文內容皆為預期，並非漂移。

> 子 action 機制：reusable workflow 的 job 跑在**呼叫方**的 checkout；Upkeep 自身程式碼（src/、reviewers/）透過 `uses: wei18/upkeep/.github/actions/<x>@v2` 帶入（GitHub 自動抓 Upkeep repo）。每個 reviewer 是獨立 matrix job 跑一個 plain `claude-code-action` prompt（寫 `findings/<reviewer>.json`），**不需 in-run subagent**，故 `--agents`/`Agent` passthrough 風險消失。

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
| 某 reviewer matrix step 掛掉/超時 | 該 step 輸出 `status:"failed"`、`findings:[]`（matrix `fail-fast: false`）；其餘 step 照常；報告與 issue 明列「本次缺 X」 |
| Anthropic API 暫時錯誤 | 該 step retry（指數退避，上限 2 次）；仍失敗才降級 |
| Synthesis step 失敗 | 降級：Report 只呈現 raw findings（不含跨領域主題/敘事），不讓整個 run fail |
| 全部 reviewer 失敗 | workflow fail，不建空 issue |
| Discovery 掃到 0 檔 | 正常結束，留 log，非錯誤 |

原則：Review/Synthesis 階段子失敗一律隔離降級；確定性骨架（Discovery/Consolidate/Report）失敗才讓整個 run fail。

---

## 9. 成本控制

- 100KB／檔上限 + 跳過 binary/lockfile/build（§5、§7）
- **分層送讀**：先送清單＋摘要，由 reviewer 點名深讀，不無腦全文塞入
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
