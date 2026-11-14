# Upkeep — 設計文件

- 狀態：已釋出。本 spec 描述目前的行為。
- 位置：repo `wei18/upkeep`。英文 base：`docs/en/design.md`；各語譯本：`docs/<locale>/design.md`（見 §6）
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

觸發：可重用 workflow 只宣告 `on: workflow_call`，因此觸發條件由呼叫方的 workflow 決定——通常是 `schedule`（cron 定期全掃）加 `workflow_dispatch`（手動執行）。此 workflow 沒有範圍相關的 input：每次執行都是全掃。
> 「重複檔 / 孤兒檔 / 全域 up-to-date」需要全域視角，PR 增量做不到，故以全掃為主。

單次 run 資料流：

```
Caller's trigger (schedule / workflow_dispatch)
  │
  ▼
[1] Discovery (deterministic, non-LLM heavy lifting)
    Scan repo → file inventory + modality classification (code/doc/spec/visual/flow/icon...)
    Read convention sources: CLAUDE.md, .claude/skills, .claude/workflows,
                .github/workflows, .claude/audit.yml (if present)
  │
  ▼
[2] Review (matrix: one claude-code-action step per enabled reviewer)
    GHA matrix gives native parallelism + fault isolation; the only concentrated LLM cost
    Each step carries: inventory + its file subset + composed rubric (built-in default ⊕ repo conventions)
    Each emits findings/<reviewer>.json (schema in §4)
  │
  ▼
[3] Synthesis (single claude-code-action, the only "connect-the-dots" brain)
    Reads all findings/*.json + inventory (compact structured material, no re-reading the whole repo)
    → semantic cross-reviewer correlation, dedup, systemic themes, prioritized narrative
    → synthesis.json
  │
  ▼
[4] Consolidate (deterministic)
    Mechanically merge findings + synthesis, dedup by key, sort (severity × confidence)
  │
  ▼
[5] Report (deterministic, zero LLM cost)
    ├─ Produce a self-contained single-file HTML report → upload artifact
    └─ Create/update tracking issue (markdown summary + link to HTML artifact)
```

要點：
- Discovery / Consolidate / Report 是**確定性編排骨架**；Review 與 Synthesis 是 LLM。
- **無 LLM lead**：編排＝GHA workflow（matrix）＋ Node。Review 階段各 reviewer 完全獨立（不需互通）；跨領域綜觀由 Synthesis 這個 reduce step 達成。
- findings 用統一 schema，讓 Synthesis 與 Consolidate 都能機械化處理。

### 本機執行（skill / 腳本）

同一套 pipeline 可透過 `scripts/local-audit.sh <target>` 在本機執行：discovery → 平行 `claude -p` reviewer 子程序 → synthesis → report。所有中間產物（inventory、prompts、findings、synthesis）都放在 `mktemp` 工作目錄，透過 `--add-dir` 授權給 Claude——不會寫入目標 repo。本機執行產出同一份 self-contained HTML 報告；不會 upsert GitHub issue，而是把 issue markdown 印出作為終端機摘要。`skills/upkeep-audit/SKILL.md` 是包裝此腳本的 Claude Code 薄包裝：維護 `~/.cache/upkeep` 的 clone、執行稽核、在對話中摘要 findings。此 skill 以三種方式發佈，皆指向同一個目錄：作為 Claude Code plugin（repo 根目錄的 `.claude-plugin/marketplace.json` 將 `skills/upkeep-audit/` 列為名為 `upkeep` 的 single-skill plugin，透過 `/plugin install upkeep@upkeep` 安裝）、透過 `npx skills add wei18/upkeep --skill upkeep-audit`（vercel-labs/skills 扁平佈局），或手動複製到 `~/.claude/skills/`。發佈僅是打包層面——CI workflow 仍是直接的 pipeline 入口，不會繞經此 skill。

### Marketplace Composite Action

第三種整合形態把同一套引擎包成 repo 根目錄的一個 composite action（`action.yml`），提供慣用的 `- uses: wei18/upkeep@v2` step 語法，並可上架 [GitHub Marketplace](https://github.com/marketplace)。因為 composite action 是單一 job、不能用 `strategy.matrix`，它的 `discovery` → `reviewer`（×7）→ `synthesis` → `report` 各 step 會依序執行而非並行——同一套引擎、同樣的輸入，只是在啟用較多 reviewer 的 repo 上會較慢。為何上方的 reusable workflow 仍是主要路徑，見 `docs/zh-TW/why-reusable-workflow.md`。這裡的發佈同樣僅是打包層面，與 skill 相同：`action.yml` 呼叫的是 reusable workflow 所用的同一批 `.github/actions/<x>@v2` 子 action。

---

## 2. Reviewer 團隊

內建 **7 位**（6 開 1 關）：

| Reviewer | 範圍 | 主要抓的問題 | 預設 |
|---|---|---|---|
| `docs_staleness` | README、文件、註解、**多語 README/doc 變體** | 內容陳舊、與 code 漂移、過期連結、**多語版本與 base 不同步** | on |
| `code_hygiene` | 原始碼 | 死碼、用不到的檔/函式、與 spec 不符、明顯壞味道 | on |
| `spec_flow` | spec、流程圖、狀態機 | flow 與實作不一致、spec 過時 | on |
| `visual_icon` | 圖片、icon、設計稿 | 未使用素材、重複圖、尺寸/命名不符規範 | on |
| `duplicate_orphan` | 全 repo | 重複檔、孤兒檔、無人引用資源 | on |
| `convention` | 全 repo | 違反 repo 自身 skills/workflows/CLAUDE.md 規範 | on |
| `i18n` | 在地化字串、`.lproj` 等 | 缺翻譯、未使用 key、與 base 不同步 | **off** |

不支援動態自訂 reviewer（§11）。內建的 `i18n` reviewer（預設關閉）已覆蓋常見需求。

### Rubric 三層合成（優先序由低到高）

```
Built-in default rubric (shipped with the action; defines what this specialty looks for)
   ⊕ repo-convention auto-discovery (the domain-relevant parts of
                         CLAUDE.md / .claude/skills / .claude/workflows)
   ⊕ audit.yml explicit override (the repo file pointed to by reviewers.<name>.rubric) ← highest priority
```

repo 有自己的標準時優先用 repo 的。`convention` 幾乎全靠 repo 自身規範；`visual_icon` 多靠內建預設＋repo 設計規範（若有）。

**Reviewer rubric 語言（`rubric_lang`）**：內建 rubric 依語系分置於 `reviewers/<locale>/`，共有兩套：`en` 與 `zh-TW`。`rubric_lang` 這個 workflow input（預設 `en`）決定 reviewer 與 synthesis 使用哪一套。填入其他值時找不到對應的 prompt 檔，所有 reviewer 與 synthesis step 都會失敗。

### 2.1 多語文件同步偵測（multilingual doc-set）

由 `docs_staleness` 負責（非 `i18n`——`i18n` 管 code 層在地化字串如 `.lproj`/`Localizable.strings`；文件翻譯漂移屬 doc 範疇）。

- **目錄約定**：多語文件放在 `docs/<locale>/<name>.md`（如 `docs/zh-TW/overview.md`）。唯一例外是 repo 根的 `README.md`＝**英文 base**（GitHub 慣例），其各語譯本在 `docs/<locale>/README.md`。
- **base 語言**：`en`（根 `README.md` 與 `docs/en/*` 為權威來源）。
- **支援語言（最多 6）**：`en`(base)、`zh-TW`、`zh-CN`、`ja`、`ko`（預留第 6）。
- **偵測**：以 base（`docs/en/<name>.md`，README 則為根 `README.md`）為對照，對每個 `docs/<locale>/<name>.md` 報「落後/缺漏/過時」。沿用 §3 原則——附證據（git 近期度：base 改了但某語譯本沒跟），不預設「翻譯一定是該更新的那方」，但 base 較新時通常傾向翻譯落後。
- **分組**：reviewer 由「同名檔跨 `docs/<locale>/` 子目錄」分組（README 另把根 `README.md` 與 `docs/<locale>/README.md` 視為同組）。
- **Dogfood**：本 repo 自身全套使用者文件（README、overview、design、why-reusable-workflow）皆多語化於 `docs/<locale>/`，同時作為此能力的真實測試樣本（見 §10）。

---

## 3. SSOT 處理原則（不預設誰是真實來源）

問題：spec/code 不一定是 SSOT；有時**過期的反而是 spec 本身**。預設固定方向會誤報。

原則：**reviewer 不預設 SSOT，只偵測「分歧」，方向交給證據＋分級裁決。**

1. **偵測分歧、不下定論**：報「A 說 X，B 說 Y，不一致」，非「B 過時了」。
2. **附證據訊號**：git 最後修改時間 / commit 近期度、被引用次數、引用方向。
3. **分級裁決**：
   - 證據強（如某檔半年未動、相關 code 上週大改）→ 將 `ssot_direction` 設為 `stale_a` 或 `stale_b`（§4），並在建議裡明講方向（「README 較舊，建議更新」）。仍需人工確認。
   - 證據弱 → 將 `ssot_direction` 設為 `uncertain`，並在建議裡說明方向需由人判斷。
   - **任何情況都不自動修改**（自動修不在範圍內，見 §11）。
4. **SSOT 不靠宣告檔**：方向全靠推斷，避免宣告檔自己過舊。真有固定政策的 repo 可以把政策寫進覆蓋用的 rubric（`reviewers.<name>.rubric`，§5）；非必要、不鼓勵。

---

## 4. findings schema

每位 reviewer 寫出一份 `findings/<reviewer>.json`，每個問題一筆記錄：

```json
{
  "reviewer": "docs_staleness",
  "status": "ok",
  "findings": [
    {
      "file": "path/to/file",
      "related": ["path/to/other-file"],
      "reviewer": "docs_staleness",
      "category": "staleness",
      "problem": "...",
      "evidence": "...",
      "suggestion": "...",
      "severity": "medium",
      "confidence": "high",
      "ssot_direction": "stale_a"
    }
  ]
}
```

- `status`：`ok` 或 `failed`。失敗的 reviewer 寫出 `status: "failed"` 與 `findings: []`；不影響其他 reviewer。
- `file`：主體檔。跨檔問題放在主體檔，其餘的檔列在 `related`。
- `related`：其他相關的檔，可為空。比對的另一方排在第一個。
- `category`：`staleness`、`duplicate`、`orphan`、`convention`、`inconsistency`、`i18n_sync`、`other` 其中之一。
- `problem`：人類可讀的問題描述。
- `evidence`：支撐證據（git 時間、引用關係、具體不符之處）。
- `suggestion`：建議修法；在分級裁決下可指出方向（§3）。
- `severity`、`confidence`：各為 `low`、`medium`、`high` 其中之一。
- `ssot_direction`：以下四個值之一。
  - `stale_a`：`file` 是過時的一方。
  - `stale_b`：`related` 的第一個檔是過時的一方。
  - `uncertain`：兩方不一致，但證據無法判斷哪一方過時。
  - `n/a`：此問題沒有可比對的兩方。

`category`、`severity`、`confidence` 各值的判斷標準只定義在一處：reviewer prompt（`reviewers/<locale>/_reviewer-prompt.md`）。`src/findings.ts` 會依合法值驗證每份檔案；驗證失敗的檔案會被換成 `failed` 結果。

**Consolidate 去重/排序（確定性）**：以 `file` + `category` 為鍵合併跨 reviewer 重複——同鍵取「代表 finding」= severity×confidence 最高者（平手以 reviewer 列舉序為穩定 tiebreak），`reviewers[]` 為該鍵所有回報者的聯集、`related[]` 取聯集。排序鍵 = severity desc → confidence desc → file asc。

### 4.1 synthesis 輸出

Synthesis step 讀全部 `findings/*.json` + inventory，輸出 `synthesis.json`。**以 file 路徑引用 findings（不用整數索引——對 LLM 較穩定、人類可讀）**：

```json
{
  "themes": [
    {
      "title": "...",
      "narrative": "...",
      "related_files": ["path/a", "path/b"],
      "priority": "high"
    }
  ],
  "semantic_duplicates": [["reviewer|file|category", "reviewer|file|category"]],
  "executive_summary": "...",
  "status": "ok"
}
```

- `themes`：跨 reviewer 的系統性主題。`title` 簡述系統性問題；`narrative` 說明為何這些 finding 指向同一根因；`related_files` 列出此主題涵蓋的檔路徑；`priority` 為 `low`、`medium` 或 `high`。
- `semantic_duplicates`：描述同一問題的 finding 鍵群，每個鍵的格式為 `reviewer|file|category`。Consolidate 會把每一群合併成一筆 finding。
- `executive_summary`：整體健康度的一段話摘要。
- `status`：`ok` 或 `failed`。synthesis 失敗時寫出 `themes: []`。

Report 同時用 raw findings 與 synthesis；synthesis 失敗或不存在時降級為只呈現 raw findings（無 themes/exec summary）。

---

## 5. 設定檔 `.claude/audit.yml`（全可選，不存在也能完整運作）

`scan` 與 `ssot` **不放進設定**（會自己過舊）；改為自動推斷。

```yaml
# .claude/audit.yml
version: 1
ignore:
  - "docs/*/plans/**"
reviewers:
  visual_icon: { enabled: false }
  i18n:        { enabled: true }
  docs_staleness:
    paths: ["README.md", "docs/**"]
    rubric: "docs/audit-rubric.md"
report:
  min_severity: "low"
```

所有鍵皆為可選：

- `version`：設定 schema 版本；目前為 `1`。
- `ignore`：glob 路徑。符合的檔會從 inventory 中排除，任何 reviewer 都看不到。預設：無。
- `reviewers.<name>.enabled`：開啟或關閉某位 reviewer。預設：除 `i18n` 外全部開啟。未列出的 reviewer 維持預設；未知的名稱會被忽略。
- `reviewers.<name>.paths`：glob 路徑。設定後，該 reviewer 的 target 檔改為 inventory 中符合的檔，不再依檔案類型選取（§2 表格的「範圍」欄）。
- `reviewers.<name>.rubric`：rubric 檔相對於 repo 根的路徑。reviewer 會把它當作最高優先的 rubric 層（§2）。
- `report.min_severity`：`low`、`medium` 或 `high`。低於此值的 finding 不進 tracking issue；HTML 報告仍保留全部 finding。預設：`low`。也接受 camelCase 寫法 `minSeverity`。

Glob 語法：`*` 比對單一路徑區段內的字元，`**` 可跨區段，`?` 比對一個字元。

issue 的 label 不是設定鍵，請用 `issue_label` 這個 workflow input 設定（預設 `audit`）。

### 自動推斷（不需設定）

- **掃描範圍**：`git ls-files --cached --others --exclude-standard` 列出的所有檔（已追蹤與未追蹤的檔，遵守 `.gitignore`），再扣除 `ignore` 的 glob。lockfile 的檔案類別為 `other`，因此只有看全 repo 的 reviewer（`duplicate_orphan`、`convention`）會收到。超過 100KB 的文字檔只會被標記，不會被跳過（§7）。
- **SSOT 方向**：全靠證據推斷（§3），無宣告檔。

---

## 6. Repo 落點（已定）

Upkeep 以 `uses:` 被引用，故獨立成 repo：`wei18/upkeep`（`uses: wei18/upkeep@v2`）。

結構：

```
upkeep/
├── action.yml                        # composite action (Marketplace listing): `uses: wei18/upkeep@v2`, sequential reviewer steps
├── .github/
│   ├── workflows/audit.yml          # reusable workflow (on: workflow_call): jobs/matrix orchestration
│   └── actions/                     # composite sub-actions (used by the workflow's jobs; carry Upkeep's own code)
│       ├── discovery/  reviewer/  synthesis/  report/
├── .claude-plugin/marketplace.json  # plugin marketplace catalog (plugin name: upkeep, source: ./skills/upkeep-audit)
├── README.md                        # English base usage (job-level uses: example, secret/permissions) + language switcher
├── docs/
│   ├── en/      overview.md  design.md  why-reusable-workflow.md   (no README: the root README.md is the en base)
│   ├── zh-TW/   README.md  overview.md  design.md  why-reusable-workflow.md
│   ├── zh-CN/ … ja/ … ko/   (same set as zh-TW)
│   ├── archive/plans/               # original implementation plans: historical record, not localized
│   └── superpowers/                 # design-process specs and plans: historical record, not localized
├── reviewers/<locale>/              # 7 built-in rubrics + _reviewer-prompt + _synthesis-prompt, per locale (en, zh-TW); picked by rubric_lang
├── skills/upkeep-audit/             # Claude Code skill: thin local-run wrapper (clones to ~/.cache/upkeep)
│   └── .claude-plugin/plugin.json   # plugin manifest (single-skill layout; SKILL.md at plugin root)
├── scripts/local-audit.sh           # local pipeline orchestrator (same flow as CI; temp-dir intermediates)
├── src/                             # deterministic TS: discovery/consolidate/report/matrix/prompt-bundle, etc.
└── test/                            # unit + contract tests (§10)
```

> 封存說明：`docs/archive/plans/` 與 `docs/superpowers/` 是 Upkeep 建置過程的歷史記錄。它們不做多語化、不被任何導覽索引連入，也不是現行規則——現行規則以本 spec 為準。`.claude/audit.yml` 把這兩個 `plans/` 目錄排除在自我稽核之外。

> 子 action 機制：reusable workflow 的 job 跑在**呼叫方**的 checkout；Upkeep 自身程式碼（src/、reviewers/）透過 `uses: wei18/upkeep/.github/actions/<x>@v2` 帶入（GitHub 自動抓 Upkeep repo）。每個 reviewer 是獨立 matrix job 跑一個 plain `claude-code-action` prompt（寫 `findings/<reviewer>.json`），**不需 in-run subagent**，故 `--agents`/`Agent` passthrough 風險消失。

---

## 7. 模態分流

Discovery 為每個檔指定一個 `modality`。100KB 上限只管 reviewer 當文字讀的檔，不套用到圖片。

| `modality` | 適用對象 | reviewer 如何處理 |
|---|---|---|
| `raster_image` | `.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.bmp`、`.tiff`、`.heic`、`.ico`、`.icns` | 無 byte 上限。依 metadata 判斷；只有下方列出的唯一情況才當圖片開啟 |
| `vector_diagram` | `.svg`、`.mmd`、`.dot`、`.puml`、`.plantuml` | 當**原始碼文字**讀（語意可 diff）。超過 100KB 時，inventory 會設 `oversizedText: true` |
| `binary` | 前 8000 bytes 內含 NUL byte 的其他檔 | 只依 metadata 判斷（`hash`、`sizeBytes`、`referencedBy`） |
| `text` | 其餘所有檔 | 當文字讀。超過 100KB 時，inventory 會設 `oversizedText: true` |

`oversizedText` 只是 inventory 裡的一個旗標：不會有任何檔因為大小而被截斷、分塊、摘要或丟棄。reviewer prompt 會要求 reviewer 分段讀取被標記的檔。

visual reviewer 多數工作不需「看」圖：
- 重複圖 → 檔案 hash（完全相同）
- 孤兒圖 → 引用關係圖
- 命名/尺寸規範 → metadata
- **只有「圖內容是否符合設計/spec」才需要開圖**；rubric 限制只開少數可疑素材

---

## 8. 韌性 / 降級

| 失敗情境 | 處置 |
|---|---|
| 某 reviewer 掛掉、超時或寫出不合法的輸出 | 該 reviewer 的結果變為 `status:"failed"`、`findings:[]`（matrix `fail-fast: false`）；其餘 reviewer 照常；報告與 issue 以「未完整執行」警告列出失敗的 reviewer |
| Synthesis step 失敗 | 降級：Report 只呈現 raw findings（不含跨領域主題/敘事），不讓整個 run fail |
| 全部 reviewer 失敗 | run 仍會完成：照常產出報告與 issue，內容沒有 finding，「未完整執行」警告會列出每一位 reviewer |
| Discovery 掃到 0 檔 | 正常結束，留 log，非錯誤 |

原則：Review/Synthesis 階段子失敗一律隔離降級；確定性骨架（Discovery/Consolidate/Report）失敗才讓整個 run fail。

---

## 9. 成本控制

- reviewer 收到的是 inventory（metadata）與 target 檔清單，而不是檔案內容。prompt 要求先用 metadata 篩出可疑的檔，只深讀那些檔
- `max_turns`（預設 30）限制每次 reviewer 呼叫與 synthesis 呼叫的 turn 數
- 被 `.gitignore` 或 `ignore` 排除的檔不會進入 inventory（§5）
- HTML / issue 組裝是純文字，**零 LLM 成本**

---

## 10. 測試策略

測試樣本：遠端真實 repo **https://github.com/wei18/Sudoku**（取代自建 fixture）。

- **確定性層 → 單元測試（TDD）**：Discovery 分類、Consolidate 去重排序、HTML/issue 組裝，不碰 LLM。
- **LLM 層 → 契約測試**：驗證 subagent 輸出**符合 findings schema**（欄位齊全、severity/confidence/ssot_direction 在合法值域），不逐字斷言內容。
  - CI：用**錄製假 response** 做 schema 契約測（省錢、穩定）。
  - 真打 API：僅手動 / release 前 smoke。
- **端到端 smoke（手動，不在 CI 內）**：對 Sudoku repo 跑完整 workflow，確認 HTML artifact 與 issue 存在、findings 合 schema、抓到合理數量的問題（不逐字斷言）。
- **Dogfood**：`.github/workflows/self-audit.yml` 每週對本 repo 執行一次稽核。

---

## 11. 範圍邊界（不做的事）

- 自動修 PR（自動改 README/刪孤兒檔）——沒有計畫；Upkeep 只輸出報告
- 動態自訂 reviewer——reviewer 組合固定；以 `reviewers.<name>.paths` 與 `reviewers.<name>.rubric`（§5）調整內建的 reviewer
- PR 增量模式——每次執行都是全掃
- SSOT 宣告檔——方向由證據推斷
