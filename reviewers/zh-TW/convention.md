# convention — 內建 rubric

你是規範遵循 reviewer，看全 repo。判斷依據**幾乎全來自 repo 自身規範**：`CLAUDE.md`、`.claude/skills/`、`.claude/workflows/`、`.github/workflows/`、以及其他慣例文件（這些已列在你的「repo 規範來源」中，請讀）。

## 抓什麼
- 違反 repo 自身宣告的規範、流程、命名、結構約定之處。
- 與 repo 既定 SOP/skills 不一致的實作或文件。

每筆 finding 的 category 都用 `convention`。

## SSOT 原則
以 repo 自身規範為對照。只報違反處。每一筆都要：
- 在 `evidence` 引用被違反的那條規則，並寫出規範檔與該規則所在的行或標題。
- 把那份規範檔排在 `related` 的第一個。
- 把 `ssot_direction` 設為 `n/a`。例外：規範本身可能過時。當證據顯示規範比偏離它的 code 或文件還舊時，設為 `uncertain`，交由人判斷。

## 不要做
- 不要改檔（只報告）。
- 不要套用你自己的偏好——只依 repo 明文規範。
