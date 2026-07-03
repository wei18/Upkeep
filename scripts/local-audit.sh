#!/usr/bin/env bash
# Run the full Upkeep audit pipeline locally against a target repo.
# Mirrors .github/workflows/audit.yml: discovery -> parallel reviewers -> synthesis -> report.
# All intermediates go to a temp work dir; the target repo is never written to.
set -euo pipefail

usage() {
  echo "usage: $0 <target-repo> [--model M] [--rubric-lang L] [--max-turns N] [--out FILE] [--keep-work]" >&2
  exit 2
}

TARGET="${1:-}"
[ -n "$TARGET" ] && [ -d "$TARGET" ] || usage
shift

MODEL="claude-opus-4-8"
RUBRIC_LANG="en"
MAX_TURNS="30"
OUT="$PWD/upkeep-report.html"
KEEP_WORK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --model)       MODEL="$2"; shift 2 ;;
    --rubric-lang) RUBRIC_LANG="$2"; shift 2 ;;
    --max-turns)   MAX_TURNS="$2"; shift 2 ;;
    --out)         OUT="$2"; shift 2 ;;
    --keep-work)   KEEP_WORK=1; shift ;;
    *) usage ;;
  esac
done

TARGET="$(cd "$TARGET" && pwd)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"

command -v claude >/dev/null 2>&1 || { echo "error: claude CLI not found — install it and log in (Pro/Max)" >&2; exit 1; }
[ -x "$TSX" ] || { echo "error: missing dependencies — run 'npm ci' in $ROOT first" >&2; exit 1; }

WORK="$(mktemp -d)"
[ "$KEEP_WORK" -eq 1 ] || trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/prompts" "$WORK/findings"
echo "upkeep: target=$TARGET work=$WORK model=$MODEL rubric_lang=$RUBRIC_LANG max_turns=$MAX_TURNS"

# --- output-only guard: snapshot the target before reviewers touch it ---
TARGET_IS_GIT=0
if git -C "$TARGET" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  TARGET_IS_GIT=1
  PRE_STATUS="$(git -C "$TARGET" status --porcelain)"
else
  echo "upkeep: warning: output-only guarantee cannot be verified (target is not a git repository)"
fi

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

# guarantee a findings file per reviewer even if a background job died early
for r in $REVIEWERS; do
  [ -f "$WORK/findings/$r.json" ] || "$TSX" "$ROOT/src/finalize.ts" reviewer "$r" "$WORK/findings/$r.json"
done

# --- synthesis ---
"$TSX" "$ROOT/src/synthesis-prompt-cli.ts" "$WORK/prompts/synthesis.txt" "$RUBRIC_LANG"
SYN_STRAY="$TARGET/synthesis.json"; SYN_PRE=0
[ -e "$SYN_STRAY" ] && SYN_PRE=1
(cd "$TARGET" && claude -p "Read the file $WORK/prompts/synthesis.txt and follow its instructions exactly.
The inventory is at $WORK/inventory.json and the findings are under $WORK/findings/ (absolute paths).
Write your output to $WORK/synthesis.json (absolute path) — do NOT write into the repository." \
  --allowedTools "Read,Write,Glob,Grep" --add-dir "$WORK" \
  --max-turns "$MAX_TURNS" --model "$MODEL") || true
if [ "$SYN_PRE" -eq 0 ] && [ -e "$SYN_STRAY" ]; then
  [ -e "$WORK/synthesis.json" ] || mv "$SYN_STRAY" "$WORK/synthesis.json"
  rm -f "$SYN_STRAY"
fi
"$TSX" "$ROOT/src/finalize.ts" synthesis "$WORK/synthesis.json"

# --- output-only guard: verify the target is unchanged ---
if [ "$TARGET_IS_GIT" -eq 1 ]; then
  POST_STATUS="$(git -C "$TARGET" status --porcelain)"
  if [ "$PRE_STATUS" != "$POST_STATUS" ]; then
    echo "error: output-only guarantee violated — the target repo was modified during the audit:" >&2
    diff <(printf '%s\n' "$PRE_STATUS") <(printf '%s\n' "$POST_STATUS") >&2 || true
    echo "error: inspect and restore the target repo with git (e.g. 'git -C $TARGET status', 'git -C $TARGET checkout -- .')" >&2
    exit 1
  fi
fi

# --- report ---
"$TSX" "$ROOT/src/report.ts" "$WORK/findings" "$WORK/synthesis.json" "$OUT" "$WORK/issue.md" "$WORK/inventory.json"
echo
echo "upkeep: report written to $OUT"
echo
cat "$WORK/issue.md"
if [ "$KEEP_WORK" -eq 1 ]; then
  echo "upkeep: work dir kept at $WORK"
fi
