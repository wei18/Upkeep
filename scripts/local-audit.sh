#!/usr/bin/env bash
# Run the full Upkeep audit pipeline locally against a target repo.
# Mirrors .github/workflows/audit.yml: discovery -> parallel reviewers -> synthesis -> report.
# All intermediates go to a temp work dir; the target repo is never written to.
set -euo pipefail

usage() {
  echo "usage: $0 <target-repo> [--model M] [--rubric-lang L] [--max-turns N] [--out FILE] [--keep-work] [--allow-command-agents]" >&2
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
ALLOW_COMMAND_AGENTS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --model)       MODEL="$2"; shift 2 ;;
    --rubric-lang) RUBRIC_LANG="$2"; shift 2 ;;
    --max-turns)   MAX_TURNS="$2"; shift 2 ;;
    --out)         OUT="$2"; shift 2 ;;
    --keep-work)   KEEP_WORK=1; shift ;;
    --allow-command-agents) ALLOW_COMMAND_AGENTS=1; shift ;;
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

# --- agent dispatch: resolve each reviewer/synthesis to an agent via src/agent-resolver.ts
# (same config resolution the CI composite actions use, so local and CI cannot drift), then
# run it. `claude` reproduces today's invocation byte-for-byte when no `agents:` block is
# configured (model/max_turns fall back to $MODEL/$MAX_TURNS); `command` is the generic
# escape hatch with {prompt}/{output}/{target} token substitution.
resolve_agent() {
  "$TSX" "$ROOT/src/agent-resolver.ts" "$TARGET" "$1"
}

run_claude_agent() {
  local instruction="$1" model="$2" max_turns="$3"
  (cd "$TARGET" && claude -p "$instruction" \
    --allowedTools "Read,Write,Glob,Grep" --add-dir "$WORK" \
    --max-turns "$max_turns" --model "$model") || true
}

# run_agent <resolved-json> <instruction> <prompt_file> <output_file>
run_agent() {
  local resolved="$1" instruction="$2" prompt_file="$3" output_file="$4"
  local type model max_turns cmd warning agent_id
  type="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).type)' "$resolved")"
  model="$(node -e 'const a=JSON.parse(process.argv[1]); process.stdout.write(a.model ?? process.argv[2])' "$resolved" "$MODEL")"
  max_turns="$(node -e 'const a=JSON.parse(process.argv[1]); process.stdout.write(String(a.max_turns ?? process.argv[2]))' "$resolved" "$MAX_TURNS")"
  warning="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).warning || "")' "$resolved")"
  [ -n "$warning" ] && echo "upkeep: warning: $warning" >&2
  case "$type" in
    claude)
      run_claude_agent "$instruction" "$model" "$max_turns"
      ;;
    command)
      # security: `.claude/audit.yml` is read from the *target* repo being audited — a hostile
      # target could declare a `command` agent to run arbitrary code on the auditor's machine.
      # Require an explicit opt-in flag before eval'ing anything the target repo configured.
      if [ "$ALLOW_COMMAND_AGENTS" -ne 1 ]; then
        agent_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).id)' "$resolved")"
        echo "upkeep: warning: target config requests a command agent (id=\"$agent_id\") but --allow-command-agents was not passed; refusing to eval untrusted commands from the target repo and falling back to claude default. Pass --allow-command-agents to explicitly allow this." >&2
        run_claude_agent "$instruction" "$model" "$max_turns"
        return 0
      fi
      cmd="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).command || "")' "$resolved")"
      if [ -z "$cmd" ]; then
        echo "upkeep: warning: agent type 'command' has no command template, skipping" >&2
        return 0
      fi
      cmd="${cmd//\{prompt\}/$prompt_file}"
      cmd="${cmd//\{output\}/$output_file}"
      cmd="${cmd//\{target\}/$TARGET}"
      (cd "$TARGET" && eval "$cmd") || true
      ;;
    *)
      echo "upkeep: warning: unknown agent type '$type', skipping" >&2
      ;;
  esac
}

# --- reviewers (parallel, mirrors the CI matrix) ---
run_reviewer() {
  local r="$1"
  local stray="$TARGET/findings/$r.json" pre=0
  [ -e "$stray" ] && pre=1
  "$TSX" "$ROOT/src/prompt-bundle.ts" "$r" "$WORK/inventory.json" "$WORK/prompts/$r.txt" "$RUBRIC_LANG"
  local resolved; resolved="$(resolve_agent "$r")"
  run_agent "$resolved" "Read the file $WORK/prompts/$r.txt and follow its instructions exactly.
The inventory is at $WORK/inventory.json (absolute path).
Write your output to $WORK/findings/$r.json (absolute path) — do NOT create a findings/ directory inside the repository." \
    "$WORK/prompts/$r.txt" "$WORK/findings/$r.json"
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
SYN_RESOLVED="$(resolve_agent --synthesis)"
run_agent "$SYN_RESOLVED" "Read the file $WORK/prompts/synthesis.txt and follow its instructions exactly.
The inventory is at $WORK/inventory.json and the findings are under $WORK/findings/ (absolute paths).
Write your output to $WORK/synthesis.json (absolute path) — do NOT write into the repository." \
  "$WORK/prompts/synthesis.txt" "$WORK/synthesis.json"
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
