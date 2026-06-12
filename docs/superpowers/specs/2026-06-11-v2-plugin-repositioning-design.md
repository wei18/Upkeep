# Upkeep v2 — Skill 主角化與 Plugin 發行設計

日期：2026-06-11
狀態：Implemented（2026-06-12 已發版：v2 tag + plugin 上線，後續隨 skill 變更滾版）

## 目標

提升專案人氣：把 Upkeep 從「GitHub Actions reusable workflow」重新定位為「Claude Code plugin（內含 audit skill）」，GitHub Actions 降為自動化排程的進階用法。以 v2 作為此次重定位的行銷版本號。

## 決策摘要

| 決策點 | 結論 |
|---|---|
| 定位 | Skill 變主角；GHA 降為「Automate it in CI」章節 |
| 安裝體驗 | 升級為 Claude Code plugin（marketplace + plugin manifest） |
| 版本策略 | v2 純加法：workflow 介面零更動 |
| v1 tag | **凍結**於切版 commit，不再 force-move；之後修正只滾 v2 |

## 1. Plugin 基礎設施

前置檢核（已查官方文件 code.claude.com/docs）：

- [x] Verified ✓ — `.claude-plugin/marketplace.json` 放 repo 根目錄；`plugins[].source` 支援相對路徑，repo 可同時為 marketplace 與 plugin 來源。
- [x] Verified ✓ — `/plugin marketplace add <owner>/<repo>` 支援 GitHub 簡寫；安裝為 `/plugin install <plugin>@<marketplace>`。
- [x] Verified ✓ — 單一 skill 的 plugin 可將 `SKILL.md` 直接放 plugin 根目錄（免 `skills/` 子層）。
- [x] Verified ✓ — `npx skills`（vercel-labs/skills）掃描 `skills/<name>/SKILL.md` 平鋪結構，frontmatter 需 `name` + `description`；本 repo 現有 `skills/upkeep-audit/SKILL.md` 已完全相容，零改動。skill 目錄內多出的 `.claude-plugin/` 子目錄只會被一併複製，無干擾。

新增檔案：

```
.claude-plugin/marketplace.json   # marketplace 名稱：upkeep
skills/upkeep-audit/.claude-plugin/plugin.json   # plugin 名稱：upkeep，含 version
```

- `marketplace.json`：`name: "upkeep"`，單一 plugin entry，`source: "./skills/upkeep-audit"`。
- `plugin.json`：`name: "upkeep"`（skill 呼叫名為 `/upkeep:upkeep-audit`）、`description`、`version`（發佈起點 2.0.0，之後隨 skill 變更遞增，不回寫本 spec）、`author`、`repository`。
- 既有 `skills/upkeep-audit/SKILL.md` 不搬移、行為不變（首次使用仍 clone 至 `~/.cache/upkeep` 並 `npm ci`）。
- 發佈前以 `claude plugin validate` 與 `claude --plugin-dir` 本地驗證。

使用者安裝（README 主打）：

```
# Claude Code（plugin，主推）
/plugin marketplace add wei18/upkeep
/plugin install upkeep@upkeep

# 任何支援 skills 的 agent（Cursor、Copilot 等 70+，次推）
npx skills add wei18/upkeep --skill upkeep-audit
```

## 2. README 重構（en 先行，zh-TW / zh-CN / ja / ko 同步）

新結構：

```
Banner（標語不變）
→ 一句能力定位：an AI audit crew for your repo, as a Claude Code plugin
→ Install（plugin 兩行為主、npx skills 一行為輔）+ 第一次使用範例（"Run an upkeep audit on /path/to/repo"）
→ What it does（現有內容微調）
→ How it compares（保留）
→ Run as plain script（原 Run locally 的 script 段落；手動 copy skill 改為 fallback 一句帶過）
→ Automate it in CI（原 Usage 章節整段搬移，範例改 @v2）
   ※ 架構不變：GHA workflow 直接跑 pipeline，不經過 skill。skill 與 workflow
     是同一引擎的兩個平行入口，「主角化」僅是 README 敘事與安裝順序的改變。
     文案可寫「the same audit crew, on a schedule」。
→ Reviewers / Configuration / Docs（保留）
```

文案原則：

- 開場以「你會得到什麼能力」敘事，不以基礎設施開場。
- 「No separate API bill」賣點保留且前移（plugin 情境同樣適用：登入的 claude CLI 即可）。
- 各 locale 遵循既有用語慣例（zh-TW 稽核、ko 助詞規則等，見 locale-doc-conventions）。

## 3. v2 發版流程

1. Plugin 基礎設施 + README（5 locale）+ design docs 同步，全部進 main。
2. 打 annotated tag `v2` + GitHub Release，notes 主打「Now a Claude Code plugin」。
3. `v1` 自此凍結；README 加一句 migration note（`@v1` → `@v2` 改一字元即可，介面相同）。
4. 後續修正僅 force-move `v2`。

## 4. 範圍外（後續任務）

- 提交 awesome-claude-skills / awesome-claude-code 等清單、社群發文（Threads）。
- 提交 Anthropic community marketplace（`anthropics/claude-plugins-community` 審核流程）。

## 驗收標準

- [x] 乾淨環境執行兩行安裝指令後，`/upkeep:upkeep-audit` 可被呼叫並完成一次本地 audit。
- [x] `npx skills add wei18/upkeep --skill upkeep-audit` 可發現並安裝該 skill。
- [x] `claude plugin validate` 通過。
- [x] 5 個 locale README 結構一致，皆以 plugin 安裝開場。
- [x] `gh workflow` 視角：既有 `@v1` 呼叫者行為不變；`@v2` 可用且內容相同。
- [x] design docs（5 locale）反映 plugin 發行架構。
