# Local Audit Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anyone run the full Upkeep audit pipeline locally — via a Claude Code skill or a plain shell script — by passing the target repo path.

**Architecture:** A deterministic bash orchestrator (`scripts/local-audit.sh`) reuses the existing TS CLIs (`discovery.ts`, `matrix.ts`, `prompt-bundle.ts`, `finalize.ts`, `report.ts`) and runs each reviewer as a parallel headless `claude -p` subprocess. All intermediates live in a `mktemp` dir granted via `--add-dir`; nothing is written into the target repo. `skills/upkeep-audit/SKILL.md` is a thin wrapper: cache clone in `~/.cache/upkeep`, run script, summarize.

**Tech Stack:** bash, Node 20 + tsx (existing), `claude` CLI headless mode.

**Spec:** `docs/superpowers/specs/2026-06-10-local-audit-skill-design.md`

---

### Task 1: `scripts/local-audit.sh`

**Files:**
- Create: `scripts/local-audit.sh` (executable)

Verified CLI signatures this script relies on (do not change them):
- `src/discovery.ts <repoRoot> [outFile]`
- `src/matrix.ts <repoRoot> [outFile]` — prints `reviewers=<json-array>` to stdout when no outFile
- `src/prompt-bundle.ts <reviewer> <inventoryJson> <outFile> [rubricLang=en]`
- `src/finalize.ts reviewer <name> <path>` / `src/finalize.ts synthesis <path>` — writes a `failed` fallback when output missing/invalid
- `src/synthesis-prompt-cli.ts <outFile> [rubricLang=en]`
- `src/report.ts <findingsDir> <synthesisJson|-> <outHtml> <outIssueMd> [inventoryJson]` — `UPKEEP_RUN_URL` env is optional

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Run the full Upkeep audit pipeline locally against a target repo.
# Mirrors .github/workflows/audit.yml: discovery -> parallel reviewers -> synthesis -> report.
# All intermediates go to a temp work dir; the target repo is never written to.
set -euo pipefail

usage() {
  echo "usage: $0 <target-repo> [--model M] [--rubric-lang L] [--max-turns N] [--out FILE]" >&2
  exit 2
}

TARGET="${1:-}"
[ -n "$TARGET" ] && [ -d "$TARGET" ] || usage
shift

MODEL="claude-opus-4-8"
RUBRIC_LANG="en"
MAX_TURNS="30"
OUT="$PWD/upkeep-report.html"
while [ $# -gt 0 ]; do
  case "$1" in
    --model)       MODEL="$2"; shift 2 ;;
    --rubric-lang) RUBRIC_LANG="$2"; shift 2 ;;
    --max-turns)   MAX_TURNS="$2"; shift 2 ;;
    --out)         OUT="$2"; shift 2 ;;
    *) usage ;;
  esac
done

TARGET="$(cd "$TARGET" && pwd)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"

command -v claude >/dev/null 2>&1 || { echo "error: claude CLI not found — install it and log in (Pro/Max)" >&2; exit 1; }
[ -x "$TSX" ] || { echo "error: missing dependencies — run 'npm ci' in $ROOT first" >&2; exit 1; }

WORK="$(mktemp -d)"
mkdir -p "$WORK/prompts" "$WORK/findings"
echo "upkeep: target=$TARGET work=$WORK model=$MODEL rubric_lang=$RUBRIC_LANG max_turns=$MAX_TURNS"

# --- discovery ---
"$TSX" "$ROOT/src/discovery.ts" "$TARGET" "$WORK/inventory.json"
RAW="$("$TSX" "$ROOT/src/matrix.ts" "$TARGET")"
REVIEWERS="$(node -e 'console.log(JSON.parse(process.argv[1]).join(" "))' "${RAW#reviewers=}")"
echo "upkeep: reviewers: $REVIEWERS"

# --- reviewers (parallel, mirrors the CI matrix) ---
run_reviewer() {
  local r="$1"
  local stray="$TARGET/findings/$r.json" pre=0
  [ -e "$stray" ] && pre=1
  "$TSX" "$ROOT/src/prompt-bundle.ts" "$r" "$WORK/inventory.json" "$WORK/prompts/$r.txt" "$RUBRIC_LANG"
  (cd "$TARGET" && claude -p "Read the file $WORK/prompts/$r.txt and follow its instructions exactly.
The inventory is at $WORK/inventory.json (absolute path).
Write your output to $WORK/findings/$r.json (absolute path) — do NOT create a findings/ directory inside the repository." \
    --allowedTools "Read,Write,Glob,Grep" --add-dir "$WORK" \
    --max-turns "$MAX_TURNS" --model "$MODEL") || true
  # pollution guard: if the model wrote into the target repo anyway, move it out
  if [ "$pre" -eq 0 ] && [ -e "$stray" ]; then
    [ -e "$WORK/findings/$r.json" ] || mv "$stray" "$WORK/findings/$r.json"
    rm -f "$stray"; rmdir "$TARGET/findings" 2>/dev/null || true
  fi
  "$TSX" "$ROOT/src/finalize.ts" reviewer "$r" "$WORK/findings/$r.json"
}

for r in $REVIEWERS; do run_reviewer "$r" & done
wait || true

# --- synthesis ---
"$TSX" "$ROOT/src/synthesis-prompt-cli.ts" "$WORK/prompts/synthesis.txt" "$RUBRIC_LANG"
(cd "$TARGET" && claude -p "Read the file $WORK/prompts/synthesis.txt and follow its instructions exactly.
The inventory is at $WORK/inventory.json and the findings are under $WORK/findings/ (absolute paths).
Write your output to $WORK/synthesis.json (absolute path) — do NOT write into the repository." \
  --allowedTools "Read,Write,Glob,Grep" --add-dir "$WORK" \
  --max-turns "$MAX_TURNS" --model "$MODEL") || true
"$TSX" "$ROOT/src/finalize.ts" synthesis "$WORK/synthesis.json"

# --- report ---
"$TSX" "$ROOT/src/report.ts" "$WORK/findings" "$WORK/synthesis.json" "$OUT" "$WORK/issue.md" "$WORK/inventory.json"
echo
echo "upkeep: report written to $OUT"
echo
cat "$WORK/issue.md"
```

- [ ] **Step 2: Make it executable and syntax-check**

Run: `chmod +x scripts/local-audit.sh && bash -n scripts/local-audit.sh && echo OK`
Expected: `OK`

- [ ] **Step 3: Smoke-test with a stubbed `claude`** (verifies plumbing without burning subscription quota)

```bash
FIX="$(mktemp -d)"
git -C "$FIX" init -q
echo "# demo" > "$FIX/README.md"
git -C "$FIX" add . && git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm init

STUB="$(mktemp -d)"
cat > "$STUB/claude" <<'EOF'
#!/usr/bin/env bash
# stub: find the absolute output path named in the prompt and write a minimal valid output
prompt="$2"
out="$(printf '%s\n' "$prompt" | grep -oE '/[^[:space:]]+\.json' | tail -1)"
if [[ "$out" == */synthesis.json ]]; then
  echo '{"themes":[]}' > "$out"
else
  r="$(basename "$out" .json)"
  printf '{"reviewer":"%s","status":"ok","findings":[]}\n' "$r" > "$out"
fi
EOF
chmod +x "$STUB/claude"

PATH="$STUB:$PATH" ./scripts/local-audit.sh "$FIX" --out "$STUB/report.html"
ls -la "$STUB/report.html" && git -C "$FIX" status --porcelain
```

Expected: script prints `report: ... findings`, `$STUB/report.html` exists, and `git status --porcelain` in the fixture is **empty** (no pollution). The stub synthesis JSON may be rejected by `finalize.ts` and replaced with the `failed` fallback — that is acceptable; the pipeline must still complete.

- [ ] **Step 4: Commit**

```bash
git add scripts/local-audit.sh
git commit -m "feat: add local-audit.sh to run the audit pipeline locally"
```

---

### Task 2: `skills/upkeep-audit/SKILL.md`

**Files:**
- Create: `skills/upkeep-audit/SKILL.md`

- [ ] **Step 1: Write the skill**

```markdown
---
name: upkeep-audit
description: Run the Upkeep repo audit locally against any repository path. Use when asked to audit a repo, check docs/spec/asset drift, or run upkeep without GitHub Actions.
---

# Upkeep Local Audit

Run the full Upkeep audit pipeline (discovery → parallel reviewers → synthesis → HTML report) against a local repository. Output-only: the target repo is never modified.

## Steps

1. **Ensure the Upkeep checkout** at `~/.cache/upkeep`:
   - Missing: `git clone --depth 1 https://github.com/wei18/upkeep ~/.cache/upkeep`
   - Present: `git -C ~/.cache/upkeep pull --ff-only`
   - Then `(cd ~/.cache/upkeep && npm ci)` after a fresh clone or whenever the pull changed `package-lock.json` (when unsure, run it — it is idempotent).
2. **Run the audit** (takes several minutes; reviewers run as parallel `claude -p` subprocesses — run it in the background and report progress):
   ```bash
   ~/.cache/upkeep/scripts/local-audit.sh <target-path> [--model M] [--rubric-lang L] [--max-turns N] [--out FILE]
   ```
   Pass flags only when the user asked for them. Defaults match the CI inputs (`claude-opus-4-8`, `en`, `30`); the report defaults to `./upkeep-report.html` in the current working directory.
3. **Summarize**: the script prints the report markdown at the end. Present the findings grouped by severity (high → medium → low), each with its file path and a one-line problem statement, then give the absolute path of the generated `report.html`. If any reviewers failed, name them.

## Requirements (tell the user what is missing instead of failing silently)

- `claude` CLI installed and logged in (Claude Pro/Max subscription).
- Node 20+, git.
```

- [ ] **Step 2: Verify frontmatter parses** (quick sanity: first line `---`, has `name:` and `description:`)

Run: `head -4 skills/upkeep-audit/SKILL.md`
Expected: the frontmatter block above.

- [ ] **Step 3: Commit**

```bash
git add skills/upkeep-audit/SKILL.md
git commit -m "feat: add upkeep-audit Claude Code skill for local runs"
```

---

### Task 3: README.md (en) — `## Run locally` section

**Files:**
- Modify: `README.md` (insert between the end of `## Usage` — after the Outputs bullet list, line ~70 — and `## Reviewers` at line 71)

- [ ] **Step 1: Insert the section**

````markdown
## Run locally

The same audit pipeline also runs on your machine — no GitHub Actions, no secrets, no GitHub permissions.

**Via Claude Code skill** — copy [`skills/upkeep-audit/`](skills/upkeep-audit/) into `~/.claude/skills/`, then ask in any Claude Code session:

> Run an upkeep audit on /path/to/repo

On first use the skill clones Upkeep into `~/.cache/upkeep` and installs dependencies automatically.

**Via plain script** (no Claude Code session needed):

```bash
git clone --depth 1 https://github.com/wei18/upkeep ~/.cache/upkeep
cd ~/.cache/upkeep && npm ci
./scripts/local-audit.sh /path/to/repo --out ~/upkeep-report.html
```

| Flag | Default | CI equivalent |
|---|---|---|
| `--model` | `claude-opus-4-8` | `model` |
| `--rubric-lang` | `en` | `rubric_lang` |
| `--max-turns` | `30` | `max_turns` |
| `--out` | `./upkeep-report.html` | report artifact |

**Requirements:** a logged-in `claude` CLI (Pro/Max; no `setup-token` and no GitHub access needed), Node 20+, git.

**Output:** the same self-contained `report.html` plus a terminal summary. Local runs never create GitHub issues.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document local run (skill + script) in README"
```

---

### Task 4: Locale READMEs — sync `Run locally`

**Files:**
- Modify: `docs/zh-TW/README.md`, `docs/zh-CN/README.md`, `docs/ja/README.md`, `docs/ko/README.md` — same insertion point in each (between the Usage section's Outputs list and the Reviewers heading at line ~71; all four files share the en structure)

Note: the skill link is relative — from `docs/<locale>/README.md` it is `../../skills/upkeep-audit/`. The code block and flag table are identical in all locales (only the table header row is translated).

- [ ] **Step 1: zh-TW (`docs/zh-TW/README.md`, before `## 審查員`)**

````markdown
## 本機執行

同一套審查 pipeline 也能直接在你的電腦上跑——不需要 GitHub Actions、secrets 或任何 GitHub 權限。

**透過 Claude Code skill** — 把 [`skills/upkeep-audit/`](../../skills/upkeep-audit/) 複製到 `~/.claude/skills/`，然後在任何 Claude Code session 說：

> 用 upkeep 檢查 /path/to/repo

skill 首次執行時會自動把 Upkeep clone 到 `~/.cache/upkeep` 並安裝依賴。

**直接跑腳本**（不需要 Claude Code session）：

```bash
git clone --depth 1 https://github.com/wei18/upkeep ~/.cache/upkeep
cd ~/.cache/upkeep && npm ci
./scripts/local-audit.sh /path/to/repo --out ~/upkeep-report.html
```

| 參數 | 預設值 | 對應 CI input |
|---|---|---|
| `--model` | `claude-opus-4-8` | `model` |
| `--rubric-lang` | `en` | `rubric_lang` |
| `--max-turns` | `30` | `max_turns` |
| `--out` | `./upkeep-report.html` | report artifact |

**需求**：已登入的 `claude` CLI（Pro/Max 訂閱；不需要 `setup-token`，也不需要 GitHub 存取權）、Node 20+、git。

**輸出**：同一份自包含的 `report.html` 加上終端機摘要。本機執行不會建立 GitHub issue。
````

- [ ] **Step 2: zh-CN (`docs/zh-CN/README.md`, before `## 审查器`)**

````markdown
## 本地执行

同一套审查 pipeline 也能直接在你的电脑上跑——不需要 GitHub Actions、secrets 或任何 GitHub 权限。

**通过 Claude Code skill** — 把 [`skills/upkeep-audit/`](../../skills/upkeep-audit/) 复制到 `~/.claude/skills/`，然后在任何 Claude Code session 里说：

> 用 upkeep 检查 /path/to/repo

skill 首次执行时会自动把 Upkeep clone 到 `~/.cache/upkeep` 并安装依赖。

**直接跑脚本**（不需要 Claude Code session）：

```bash
git clone --depth 1 https://github.com/wei18/upkeep ~/.cache/upkeep
cd ~/.cache/upkeep && npm ci
./scripts/local-audit.sh /path/to/repo --out ~/upkeep-report.html
```

| 参数 | 默认值 | 对应 CI input |
|---|---|---|
| `--model` | `claude-opus-4-8` | `model` |
| `--rubric-lang` | `en` | `rubric_lang` |
| `--max-turns` | `30` | `max_turns` |
| `--out` | `./upkeep-report.html` | report artifact |

**要求**：已登录的 `claude` CLI（Pro/Max 订阅；不需要 `setup-token`，也不需要 GitHub 访问权限）、Node 20+、git。

**输出**：同一份自包含的 `report.html` 加上终端摘要。本地执行不会创建 GitHub issue。
````

- [ ] **Step 3: ja (`docs/ja/README.md`, before `## レビュアー`)**

````markdown
## ローカル実行

同じ監査パイプラインはあなたのマシン上でも実行できます — GitHub Actions も secrets も GitHub 権限も不要です。

**Claude Code skill で実行** — [`skills/upkeep-audit/`](../../skills/upkeep-audit/) を `~/.claude/skills/` にコピーし、任意の Claude Code セッションでこう頼みます：

> upkeep で /path/to/repo を監査して

初回実行時、skill は Upkeep を `~/.cache/upkeep` に自動で clone し、依存関係をインストールします。

**スクリプトを直接実行**（Claude Code セッション不要）：

```bash
git clone --depth 1 https://github.com/wei18/upkeep ~/.cache/upkeep
cd ~/.cache/upkeep && npm ci
./scripts/local-audit.sh /path/to/repo --out ~/upkeep-report.html
```

| フラグ | デフォルト | 対応する CI input |
|---|---|---|
| `--model` | `claude-opus-4-8` | `model` |
| `--rubric-lang` | `en` | `rubric_lang` |
| `--max-turns` | `30` | `max_turns` |
| `--out` | `./upkeep-report.html` | report artifact |

**要件**：ログイン済みの `claude` CLI（Pro/Max サブスクリプション。`setup-token` も GitHub アクセスも不要）、Node 20+、git。

**出力**：同じ自己完結型の `report.html` とターミナルサマリー。ローカル実行では GitHub issue は作成されません。
````

- [ ] **Step 4: ko (`docs/ko/README.md`, before `## 리뷰어`)**

````markdown
## 로컬 실행

동일한 감사 파이프라인을 당신의 머신에서도 실행할 수 있습니다 — GitHub Actions, secrets, GitHub 권한이 모두 필요 없습니다.

**Claude Code skill 로 실행** — [`skills/upkeep-audit/`](../../skills/upkeep-audit/) 를 `~/.claude/skills/` 에 복사한 뒤, 아무 Claude Code 세션에서 이렇게 요청하세요:

> upkeep 으로 /path/to/repo 를 감사해 줘

첫 실행 시 skill 이 Upkeep 을 `~/.cache/upkeep` 에 자동으로 clone 하고 의존성을 설치합니다.

**스크립트 직접 실행** (Claude Code 세션 불필요):

```bash
git clone --depth 1 https://github.com/wei18/upkeep ~/.cache/upkeep
cd ~/.cache/upkeep && npm ci
./scripts/local-audit.sh /path/to/repo --out ~/upkeep-report.html
```

| 플래그 | 기본값 | 대응 CI input |
|---|---|---|
| `--model` | `claude-opus-4-8` | `model` |
| `--rubric-lang` | `en` | `rubric_lang` |
| `--max-turns` | `30` | `max_turns` |
| `--out` | `./upkeep-report.html` | report artifact |

**요구 사항**: 로그인된 `claude` CLI (Pro/Max 구독; `setup-token` 도 GitHub 접근 권한도 필요 없음), Node 20+, git.

**출력**: 동일한 자체 완결형 `report.html` 과 터미널 요약. 로컬 실행은 GitHub issue 를 만들지 않습니다.
````

- [ ] **Step 5: Verify lockstep** (all five READMEs now have the section)

Run: `grep -l "upkeep-report.html" README.md docs/*/README.md | wc -l`
Expected: `5`

- [ ] **Step 6: Commit**

```bash
git add docs/zh-TW/README.md docs/zh-CN/README.md docs/ja/README.md docs/ko/README.md
git commit -m "docs: sync Run locally section across locale READMEs"
```

---

### Task 5: `docs/en/design.md` — local execution subsection + §6 diagram

**Files:**
- Modify: `docs/en/design.md` — (a) add a subsection at the end of §1 (immediately before `## 2. Reviewer Team`, line ~75); (b) §6 directory diagram (line ~225): insert two lines after the `reviewers/<locale>/` line, before `src/`

- [ ] **Step 1: Add the §1 subsection**

```markdown
### Local Execution (skill / script)

The same pipeline runs locally via `scripts/local-audit.sh <target>`: discovery → parallel `claude -p` reviewer subprocesses → synthesis → report. All intermediates (inventory, prompts, findings, synthesis) live in a `mktemp` work dir granted to Claude via `--add-dir` — nothing is written into the target repo. Local runs produce the same self-contained `report.html`; instead of upserting a GitHub issue, the issue markdown is printed as the terminal summary. `skills/upkeep-audit/SKILL.md` is a thin Claude Code wrapper around the script: it maintains a clone in `~/.cache/upkeep`, runs the audit, and summarizes findings in chat.
```

- [ ] **Step 2: Add the two diagram lines** (after the `reviewers/<locale>/` line)

```
├── skills/upkeep-audit/             # Claude Code skill: thin local-run wrapper (clones to ~/.cache/upkeep)
├── scripts/local-audit.sh           # local pipeline orchestrator (same flow as CI; temp-dir intermediates)
```

- [ ] **Step 3: Commit**

```bash
git add docs/en/design.md
git commit -m "docs: spec local execution mode in design.md (en)"
```

---

### Task 6: Locale design.md — sync local execution

**Files:**
- Modify: `docs/zh-TW/design.md`, `docs/zh-CN/design.md`, `docs/ja/design.md`, `docs/ko/design.md` — same two edits as Task 5: subsection at end of §1 (before §2), two diagram lines in §6 after the `reviewers/<locale>/` line. Match each file's existing heading numbering/style.

- [ ] **Step 1: zh-TW subsection**

```markdown
### 本機執行（skill / 腳本）

同一套 pipeline 可透過 `scripts/local-audit.sh <target>` 在本機執行：discovery → 平行 `claude -p` reviewer 子程序 → synthesis → report。所有中間產物（inventory、prompts、findings、synthesis）都放在 `mktemp` 工作目錄，透過 `--add-dir` 授權給 Claude——不會寫入目標 repo。本機執行產出同一份自包含的 `report.html`；不會 upsert GitHub issue，而是把 issue markdown 印出作為終端機摘要。`skills/upkeep-audit/SKILL.md` 是包裝此腳本的 Claude Code 薄包裝：維護 `~/.cache/upkeep` 的 clone、執行審查、在對話中摘要 findings。
```

zh-TW diagram lines:

```
├── skills/upkeep-audit/             # Claude Code skill：本機執行薄包裝（clone 到 ~/.cache/upkeep）
├── scripts/local-audit.sh           # 本機 pipeline 協調器（與 CI 同流程；中間產物放暫存目錄）
```

- [ ] **Step 2: zh-CN subsection**

```markdown
### 本地执行（skill / 脚本）

同一套 pipeline 可通过 `scripts/local-audit.sh <target>` 在本地执行：discovery → 并行 `claude -p` reviewer 子进程 → synthesis → report。所有中间产物（inventory、prompts、findings、synthesis）都放在 `mktemp` 工作目录，通过 `--add-dir` 授权给 Claude——不会写入目标 repo。本地执行产出同一份自包含的 `report.html`；不会 upsert GitHub issue，而是把 issue markdown 打印出来作为终端摘要。`skills/upkeep-audit/SKILL.md` 是包装此脚本的 Claude Code 薄包装：维护 `~/.cache/upkeep` 的 clone、执行审查、在对话中总结 findings。
```

zh-CN diagram lines:

```
├── skills/upkeep-audit/             # Claude Code skill：本地执行薄包装（clone 到 ~/.cache/upkeep）
├── scripts/local-audit.sh           # 本地 pipeline 协调器（与 CI 同流程；中间产物放临时目录）
```

- [ ] **Step 3: ja subsection**

```markdown
### ローカル実行（skill / スクリプト）

同じパイプラインは `scripts/local-audit.sh <target>` でローカルでも実行できる：discovery → 並列の `claude -p` レビュアーサブプロセス → synthesis → report。中間生成物（inventory、prompts、findings、synthesis）はすべて `mktemp` の作業ディレクトリに置かれ、`--add-dir` で Claude に許可される——対象リポジトリには何も書き込まない。ローカル実行でも同じ自己完結型の `report.html` を生成する。GitHub issue の upsert は行わず、issue の markdown をターミナルサマリーとして出力する。`skills/upkeep-audit/SKILL.md` はこのスクリプトの薄い Claude Code ラッパーで、`~/.cache/upkeep` のクローンを維持し、監査を実行し、findings をチャットで要約する。
```

ja diagram lines:

```
├── skills/upkeep-audit/             # Claude Code skill：ローカル実行の薄いラッパー（~/.cache/upkeep に clone）
├── scripts/local-audit.sh           # ローカル pipeline オーケストレーター（CI と同じフロー；中間生成物は一時ディレクトリ）
```

- [ ] **Step 4: ko subsection**

```markdown
### 로컬 실행 (skill / 스크립트)

동일한 파이프라인을 `scripts/local-audit.sh <target>` 로 로컬에서 실행할 수 있다: discovery → 병렬 `claude -p` 리뷰어 서브프로세스 → synthesis → report. 모든 중간 산출물(inventory, prompts, findings, synthesis)은 `mktemp` 작업 디렉터리에 두고 `--add-dir` 로 Claude 에 권한을 부여한다 — 대상 저장소에는 아무것도 쓰지 않는다. 로컬 실행도 동일한 자체 완결형 `report.html` 을 생성하며, GitHub issue 를 upsert 하는 대신 issue markdown 을 터미널 요약으로 출력한다. `skills/upkeep-audit/SKILL.md` 는 이 스크립트의 얇은 Claude Code 래퍼로, `~/.cache/upkeep` 클론을 유지하고 감사를 실행한 뒤 findings 를 채팅으로 요약한다.
```

ko diagram lines:

```
├── skills/upkeep-audit/             # Claude Code skill: 로컬 실행용 얇은 래퍼 (~/.cache/upkeep 에 clone)
├── scripts/local-audit.sh           # 로컬 pipeline 오케스트레이터 (CI 와 동일한 플로우; 중간 산출물은 임시 디렉터리)
```

- [ ] **Step 5: Verify lockstep**

Run: `grep -l "local-audit.sh" docs/*/design.md | wc -l`
Expected: `5`

- [ ] **Step 6: Commit**

```bash
git add docs/zh-TW/design.md docs/zh-CN/design.md docs/ja/design.md docs/ko/design.md
git commit -m "docs: sync local execution section across locale design docs"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all existing tests pass (this change adds no TS code; `workflow-structure.test.ts` and asset tests must remain green).

- [ ] **Step 2: Re-run the stubbed smoke test from Task 1 Step 3**

Expected: report generated, fixture repo untouched.

- [ ] **Step 3 (optional, costs subscription quota): one real run**

Run: `./scripts/local-audit.sh <some small local repo> --max-turns 15`
Expected: real findings in `upkeep-report.html`; terminal summary printed.
