# Upkeep (repo-audit-action)

Local dir is `repo-audit-action/`; the **published name is `wei18/upkeep`** — the mismatch is intentional. Full reference: `docs/en/design.md`.

## What this is

An AI repo auditor that catches drift (stale docs, spec/code mismatch, orphaned assets, convention violations). Pipeline: **discovery → parallel reviewers → synthesis → HTML report**. Two entry points, one engine:

- **CI**: reusable workflow `.github/workflows/audit.yml` (`on: workflow_call`) + composite actions under `.github/actions/`. Runs on the *caller's* checkout; Upkeep's code arrives via `uses: wei18/upkeep/.github/actions/<x>@<tag>`. Each reviewer is an independent matrix job. Upserts one tracking issue.
- **Local**: `scripts/local-audit.sh <target>` — same flow, `claude -p` subprocesses, temp-dir intermediates via `--add-dir`. Never creates issues; prints the summary instead. `skills/upkeep-audit/SKILL.md` is a thin wrapper (clones engine to `~/.cache/upkeep`, runs script, summarizes). The CI workflow does **not** route through the skill.

## Hard invariants

- **Output-only**: never edit or delete anything in the audited repo. No exceptions.
- **No presumed ground truth**: report divergence with evidence; don't assume code > docs or vice versa.
- Workflow interface (`with:` inputs, secrets, permissions) is a public contract — changes need a major version.

## Plugin / skill distribution

Three install paths, all pointing at `skills/upkeep-audit/` (do not move it):

1. Claude Code plugin: `.claude-plugin/marketplace.json` (marketplace `upkeep`) → plugin `upkeep`, single-skill layout (SKILL.md at plugin root) → invocation `/upkeep:upkeep-audit`. Keep plugin version in `skills/upkeep-audit/.claude-plugin/plugin.json` bumped on skill changes.
2. `npx skills add wei18/upkeep --skill upkeep-audit` — relies on the flat `skills/<name>/SKILL.md` layout and `name`+`description` frontmatter. Don't break either.
3. Manual copy into `~/.claude/skills/`.

## Tags & releases

- `v2` is the rolling annotated tag: after pushing a fix to main, force-move it (`git tag -fa v2 && git push -f origin v2`).
- `v1` is **frozen** (pre-plugin era). Never move it.
- Self-audit issues on the repo are upserted tracking issues, not user bug reports; close via `Closes #N` in the fix commit.

## Docs: 5-locale sync (the rule that bites)

Root `README.md` is the en base; `docs/{zh-TW,zh-CN,ja,ko}/` each mirror `README.md`, `overview.md`, `design.md`, `why-reusable-workflow.md`. **Any user-facing doc change must land in all 5, same section structure, in the same PR/commit series.**

- Code blocks, commands, flags, YAML: byte-identical across locales — never translated.
- Reuse each file's established terminology; do not retranslate retained text. Known conventions: zh-TW audit=稽核, reviewer=審查員; zh-CN reviewer=审查器; ja formal です/ます register; ko: no space between an English/code token and its particle (`plugin이`, not `plugin 이`).
- `docs/<locale>/plans/` is a verbatim archive — unlinked navigation and in-fence non-English text there are intentional, not drift.

## Working conventions

- TS source in `src/`, tests in `test/` (vitest). Run `npm test` before claiming done; TDD for behavior changes (failing test first — see `test/report.test.ts` fixture pattern).
- `dist/` is git-ignored, never committed; `npm run build` (tsc) is a type-check gate only — CI and the composite actions run `src/*.ts` directly via tsx.
- Degradation over crashing: malformed reviewer/JSON input becomes `{status: 'failed', findings: []}` via the finalize helpers in `src/report.ts` — follow that pattern for new parsers.
- Specs go in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/` (dated, kebab-case).
- Before relying on external tool behavior (plugin schema, CLI flags), verify against official docs — no trial-and-error reverse engineering.
