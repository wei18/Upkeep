# Upkeep — Pluggable multi-vendor reviewer engine

Date: 2026-07-04
Issue: #5 (draft proposal by repo owner; §What already agreed, this is the detailed design)

## §Status

**Approved (2026-07-04).** The repo owner adjudicated all four Open Decisions, taking the
recommended option in each case (see §Open decisions — resolved). Implementation may proceed
per the phase split, gated on the Phase 1 prerequisites in "What I did not verify".

## §What (condensed from issue #5)

The reviewer/synthesis engine is hardwired to `anthropics/claude-code-action@v1`, one global `model`,
one `CLAUDE_CODE_OAUTH_TOKEN`. Make it **pluggable**:

1. **Multi-vendor** — reviewers/synthesis can run on agents other than Claude.
2. **Per-reviewer agent assignment** — each reviewer (and synthesis) can point at a different
   agent/model, forming a heterogeneous crew.

Two hard requirements, non-negotiable:

- **Backward compatible** — default stays Claude; every existing caller config and `.claude/audit.yml`
  keeps working byte-for-byte unchanged.
- **Deterministic skeleton untouched** — discovery / consolidate / report and the finalize fallback
  (`src/`) are engine-agnostic already and do not move.

Integration is via an **agent abstraction** with two paths: curated **built-in adapters** (Claude,
Gemini, …) and a **generic `command` escape hatch** for any action/CLI honoring the I/O contract.

## §Prerequisites

Each external dependency is flagged `Verified ✓` (with source) or `Unconfirmed ?`.

- **Claude Code Action baseline** — `anthropics/claude-code-action@v1`: `prompt` (string or file),
  `claude_args` raw-flag passthrough (`--allowedTools`, `--max-turns`, `--model`), auth via
  `claude_code_oauth_token` or `anthropic_api_key`. **Verified ✓** (claude-code-action README/usage.md,
  vendor-research §4). This is the shape the first adapter is refactored out of.
- **Gemini adapter** — `google-github-actions/run-gemini-cli`, official, **beta** ("available to
  everyone worldwide"). Headless via `-p`/non-TTY stdin. Named-tool allow/deny (`coreTools`/
  `excludeTools` in settings.json) and `maxSessionTurns` turn cap — both map cleanly onto the current
  reviewer contract. Auth via Gemini API key. **Verified ✓** (vendor-research §2). Confidence on exact
  settings.json schema for `coreTools`: 中高 — fields + precedence confirmed, full schema not fetched.
- **Codex adapter** (candidate, likely deferred) — `openai/codex-action@v1`, official, v1-tagged
  (formal GA declaration not found, 信心 中). `prompt`/`prompt-file` in, `output-file` out. Permission
  is a **coarse sandbox mode** (`read-only`/`workspace-write`), **not** a named-tool allowlist, and
  **no turn cap exists**. **Verified ✓** (vendor-research §1, §5). Implication: does not fit the typed
  `max_turns`/`allowed_tools` fields — must be modeled as a distinct capability profile.
- **Lowest-common-denominator finding** — only Claude and Gemini expose "named-tool allowlist + turn
  cap". Codex/Copilot/OpenHands offer only sandbox/approval boundaries with no turn cap. **Verified ✓**
  (vendor-research §5). Design consequence: capability fields must be **per-adapter optional**, never
  assumed universal; the generic raw-args/command escape hatch is the safe minimum, precedented by
  claude-code-action's own v0→v1 collapse into `claude_args`.
- **GitHub Actions `uses:` cannot be expression-interpolated** — a composite action cannot select its
  sub-action via `${{ }}`; adapter branching in CI must therefore be **multiple `if:`-gated steps**,
  one literal `uses:` per built-in adapter, plus one `run:` step for the generic command. **Unconfirmed ?**
  — strong prior (this is my understanding of documented GHA behavior) but I did not fetch the official
  page this session. **Blocks Phase 1 start until confirmed** (it decides the composite-action shape).
- **Reusable-workflow additive secrets** — adding new `required: false` secrets and optional inputs to
  `workflow_call` is backward compatible for existing callers. **Unconfirmed ?** — widely true in
  practice; verify against GitHub reusable-workflow docs before relying on it for the v2-additive claim.

## §How

### 1. Uniform I/O contract (the linchpin)

An **agent** is a pure mapping: `(prompt_file, output_file, capability_params, secrets) → an invocation
that reads the prompt, works read-only over the target repo, and writes conforming JSON to output_file`.

The contract's safety net **already exists and is vendor-neutral**: `src/finalize.ts:7-17` coerces any
missing/invalid output into `{status:'failed', findings:[]}` (reviewer) or the failed synthesis shape.
So the output boundary is adapter-agnostic today — an adapter that produces garbage or nothing degrades
gracefully, no new code needed. This is the load-bearing reason the abstraction is cheap.

Capability params (all optional, adapter declares which it honors):
- `model` — every adapter.
- `max_turns` — Claude, Gemini only. Codex/generic: ignored.
- `allowed_tools` — Claude (`--allowedTools`), Gemini (`coreTools`). Codex: mapped to sandbox mode
  `read-only`. Generic: caller's responsibility.

### 2. Config schema — agents registry (`.claude/audit.yml`)

Additive to the existing `AuditConfig` (`src/types.ts:29-34`). New optional top-level `agents` map and
per-reviewer `agent` selector; existing files with neither behave exactly as today.

```yaml
version: 1
agents:                       # OPTIONAL. Absent → implicit { default: {type: claude} }
  default:                    # id "default" is the fallback for any unset reviewer
    type: claude              # built-in adapter id: claude | gemini | (codex) | command
    model: claude-opus-4-8    # optional; falls back to the workflow `model` input
    max_turns: 30             # optional; falls back to the workflow `max_turns` input
  fast:
    type: gemini
    model: gemini-2.5-flash
    max_turns: 20
  byoa:                       # generic escape hatch
    type: command
    command: "my-agent --prompt {prompt} --out {output} --repo {target}"
reviewers:
  docs_staleness: { agent: fast }   # per-reviewer selector; unset → "default"
  spec_flow:      { agent: default }
synthesis:
  agent: default              # synthesis may pick its own agent (Open Decision 4)
```

Default behavior (no `agents:` block): a single implicit `default` agent of `type: claude` sourcing
`model`/`max_turns` from the workflow inputs — **identical to current runtime**. Resolution logic
(`reviewer → agent id → {type, params}`, with `default` fallback) is deterministic and lives in `src/`,
unit-testable with no LLM. Extends `mergeConfig` (`src/config.ts:16-35`) and the `AuditConfig`/
`ReviewerConfig` types (`src/types.ts:23-34`).

`{prompt}`/`{output}`/`{target}` are the only placeholder tokens for `type: command`.

### 3. Composite reviewer action — branch by agent type

`.github/actions/reviewer/action.yml`: the single `anthropics/claude-code-action@v1` step
(action.yml:44-52) becomes one of several mutually-exclusive, `if:`-gated steps. New composite input
`agent_type` (default `claude`) + `agent_command`/model/turns passthrough. Sketch:

- keep prompt-build step (`prompt-bundle.ts`, action.yml:36-43), now also emitting the tool-whitelist
  paragraph per adapter (see §5).
- `- uses: anthropics/claude-code-action@v1` gated `if: inputs.agent_type == 'claude'` — the existing
  step verbatim.
- `- uses: google-github-actions/run-gemini-cli@...` gated `if: inputs.agent_type == 'gemini'`.
- `- name: generic agent` `run: <inputs.agent_command with tokens substituted>` gated
  `if: inputs.agent_type == 'command'`.
- finalize step (action.yml:53-59) and upload (60-65) unchanged — the vendor-neutral tail.

`audit.yml` (workflow) `review` job (audit.yml:36-52) resolves each matrix reviewer's agent from config
(via a new discovery/matrix output field) and forwards `agent_type`/params. Synthesis action mirrors
this (synthesis/action.yml:43-51 → the same `if:`-gated set). The deterministic discovery/report jobs
are untouched.

### 4. Per-agent secrets

`audit.yml` `secrets:` block (audit.yml:17-19) gains optional per-vendor secrets, **additively**:

```yaml
secrets:
  claude_code_oauth_token: { required: true }   # unchanged
  openai_api_key:          { required: false }   # new, optional
  gemini_api_key:          { required: false }   # new, optional
```

All are forwarded to the reviewer/synthesis composite actions; the active adapter step consumes only
the one it needs. Because they are `required: false`, existing callers passing only
`claude_code_oauth_token` are unaffected. (Adding optional secrets is the additive path — confirm the
Prerequisite flag first.)

### 5. Prompt-template tool-whitelist parameterization

`reviewers/en/_reviewer-prompt.md:17-18` hardcodes "You have only these tools: `Read`, `Write`, `Glob`,
`Grep`." Replace with a `{{TOOLS}}` placeholder filled by `src/prompt-bundle.ts` from the resolved
adapter's capability profile:
- Claude/Gemini → the named-tool sentence (tool names per vendor).
- Codex/sandbox adapters → "you run in a read-only sandbox; write only the output file."

This paragraph is duplicated across 5 locales (`reviewers/<locale>/_reviewer-prompt.md`) — the template
edit is a **5-locale doc-sync change** (per CLAUDE.md docs rule) and lands in the same commit series.

### 6. Local engine (`scripts/local-audit.sh`)

Mirror the CI branch in bash. The two `claude -p` blocks (local-audit.sh:65-69 reviewer, :90-94
synthesis) become a `run_agent` dispatch function selecting by resolved `type`: `claude` → current
`claude -p …` invocation; `gemini` → `gemini -p …`; `command` → the user template with token
substitution. The output-only guard (local-audit.sh:44-51, 101-110) and finalize calls (:75, :99) are
adapter-independent and stay. Agent resolution reuses the same `src/` logic the CI path uses (parse
`.claude/audit.yml`), so local and CI cannot drift.

### 7. Testing strategy

- **Contract lock** — extend `test/workflow-structure.test.ts`: assert new secrets/inputs are
  `required: false`, `claude_code_oauth_token` still `required: true`, Claude still the default agent.
- **Config parsing** — unit-test `agents` registry + `reviewers.<n>.agent` merge in `src/config.ts`,
  including the "no agents block → implicit claude default" path.
- **Agent resolution** — deterministic `reviewer → {type, params}` resolver: default fallback, unknown
  agent id → error or fallback, capability-param passthrough. No LLM needed.
- **Degradation** — keep finalize fallback tests as the vendor-neutral guarantee (any adapter failing →
  `failed`).
- Prompt-bundle `{{TOOLS}}` substitution per adapter profile.

## §Compatibility & versioning

The workflow interface (`with:` inputs, secrets, permissions) is a public contract; only genuinely
breaking changes force a major tag. Per-change ruling:

| Change | Additive (stays v2)? | Rationale |
|---|---|---|
| New `required: false` secrets (`gemini_api_key`, …) | **Yes** | Existing callers unaffected (pending Prerequisite confirm) |
| New optional composite inputs (`agent_type`, `agent_command`) with `claude` default | **Yes** | Default reproduces current behavior |
| `.claude/audit.yml` `agents` + `reviewers.<n>.agent` | **Yes** | Repo-side config read by `src/`, not the workflow contract; absent → current behavior |
| Prompt-template `{{TOOLS}}` parameterization | **Yes** | Output identical for the Claude default |
| Gemini / generic `command` adapters | **Yes** | Purely opt-in |
| Making `claude_code_oauth_token` `required: false` | **No → v3** | Loosening a `required: true` secret changes the locked contract (`workflow-structure.test.ts`) |
| Renaming `CLAUDE_CODE_OAUTH_TOKEN` / `.claude/audit.yml` path (removing the old name) | **No → v3** | Removal breaks callers. Doing it as an *alias* (keep old, add neutral) is additive → v2 |
| Removing/renaming `model` or `max_turns` inputs | **No → v3** | Breaks callers |

**Recommendation:** ship Phases 1–2 entirely additive under the rolling **v2** tag. Reserve **v3** only
for eventual *removal* of legacy names. If neutral naming is wanted sooner, add it as an **alias**
(neutral secret/path accepted alongside the Claude-branded one) — that is additive and stays in v2; v3
later just drops the deprecated alias.

### Phase split (Karpathy-minimal; each phase independently shippable, Claude stays default)

- **Phase 1 — abstraction only, zero behavior change.** Introduce the uniform contract, refactor the
  existing Claude path into the first built-in adapter (`type: claude`), add the `command` escape hatch,
  and the config resolver. No new vendor. Proves the seam with the Claude default byte-identical.
  *Gated on confirming the `uses:`-branching Prerequisite.*
- **Phase 2 — Gemini adapter + per-reviewer selection.** Add the `gemini` built-in (clean allowlist +
  turn-cap fit), per-agent secrets plumbing, `reviewers.<n>.agent`/`synthesis.agent` wiring, 5-locale
  `{{TOOLS}}` template edit.
- **Phase 3 — Codex + naming (deferred / separate decision).** Codex needs a distinct sandbox-mode
  capability profile (no turn cap); naming neutralization as alias. Out of the first cut unless the user
  prioritizes it.

## §Out of scope

- Auto-selecting the "best" agent per task (issue #5 out-of-scope).
- Streaming / interactive agents (issue #5 out-of-scope).
- Removing legacy Claude-branded names (deferred to a possible v3; alias is the v2-safe alternative).
- Aider / Copilot CLI / OpenHands built-in adapters — reachable today via the generic `command` hatch;
  no curated adapter until demand + verified headless docs (vendor-research §3 flags their docs gaps).

## §Acceptance checklist (mechanical)

- [ ] `.claude/audit.yml` with no `agents:` block produces byte-identical runtime to today (Claude
      default, workflow `model`/`max_turns`).
- [ ] `agents` registry + `reviewers.<n>.agent` parse and resolve; unset reviewer → `default` agent.
- [ ] `test/workflow-structure.test.ts` asserts: `claude_code_oauth_token` still `required: true`; new
      secrets/inputs `required: false`; Claude default preserved.
- [ ] Composite reviewer/synthesis actions branch by `agent_type` via `if:`-gated steps; Claude step
      unchanged from action.yml:44-52 / synthesis/action.yml:43-51.
- [ ] `scripts/local-audit.sh` dispatches by resolved agent type; output-only guard and finalize calls
      intact.
- [ ] `{{TOOLS}}` paragraph parameterized in all 5 locale reviewer prompts, same section structure.
- [ ] Every changed code point in §How maps to a concrete `file:line` (it does — see §How).
- [ ] `npm test` green.

## §Open decisions — resolved (adjudicated by repo owner, 2026-07-04)

All four decisions below were resolved to option (a), the recommended choice in each:
version strategy = all-additive under v2; naming neutralization deferred; first-ship
adapters = Claude + Gemini; `synthesis.agent` allowed with `default` fallback.
The original options are retained for the record.

1. **Version strategy.**
   - (a) *All-additive under v2, defer removals to v3* — **recommended**. Lowest risk, ships now.
   - (b) Cut v3 immediately and do naming neutralization as a rename in the same major.
   - (c) v2-additive now + alias naming now (also v2), v3 only to drop aliases later.
   → Recommend (a); adopt (c)'s alias if neutral naming is wanted before v3.

2. **`.claude/audit.yml` path + `CLAUDE_CODE_OAUTH_TOKEN` neutralization — do it, and when?**
   - (a) *Don't touch now* — **recommended for first cut**; naming is cosmetic, back-compat matters more.
   - (b) Add neutral aliases now (additive, v2), keep Claude names working.
   - (c) Rename outright (v3).
   → Recommend (a), revisit as (b) once a second vendor actually ships.

3. **Built-in adapter first-ship list.**
   - (a) *Claude + Gemini only* — **recommended**. Both fit the allowlist+turn-cap contract cleanly;
     Codex reachable via `command` hatch meanwhile.
   - (b) Claude + Gemini + Codex — Codex needs a separate sandbox-mode profile and has no turn cap
     (extra design surface for the first cut).
   - (c) Claude only + generic `command` — most minimal; defers all vendor adapters.
   → Recommend (a).

4. **May synthesis pick a different agent than reviewers?**
   - (a) *Yes, `synthesis.agent`, default = `default` agent* — **recommended**. Cheap, symmetric with
     reviewers, enables "cheap reviewers + strong synthesizer".
   - (b) No — synthesis always uses the `default` agent (less config surface).
   → Recommend (a).

## What I did not verify (+ confidence)

- **`uses:` cannot be expression-interpolated in composite actions** — strong prior but not re-fetched
  from GHA docs this session. 信心：中高. This gates the Phase 1 composite shape — confirm first.
- **Adding `required: false` secrets/inputs to `workflow_call` is fully back-compat** — practice says
  yes, not doc-verified this session. 信心：中高.
- **Gemini `run-gemini-cli` exact input names / how `coreTools`+`maxSessionTurns` are passed from the
  action** (vs. a settings.json file) — not fetched; the *capability existence* is verified, the exact
  wiring is not. 信心：中. Affects Phase 2 step authoring only.
- **Codex `openai/codex-action@v1` GA status** — v1-tagged, no explicit GA declaration. 信心：中. Only
  matters if Open Decision 3 picks (b).
- **5-locale reviewer-prompt line offsets** other than en — I confirmed en `:17-18`; assumed the four
  translated files mirror the same paragraph (per the repo's own 5-locale sync rule). 信心：中高.
