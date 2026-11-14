# Upkeep

Published as `wei18/upkeep`. Current behavior is specified in `docs/en/design.md`.

## What this is

An AI repo auditor that catches drift (stale docs, spec/code mismatch, orphaned assets, convention violations). Pipeline: **discovery → parallel reviewers → synthesis → HTML report**. Three entry points, one engine:

- **CI**: reusable workflow `.github/workflows/audit.yml` (`on: workflow_call`) + composite actions under `.github/actions/`. Runs on the *caller's* checkout; Upkeep's code arrives via `uses: wei18/upkeep/.github/actions/<x>@<tag>`. Each reviewer is an independent matrix job. Upserts one tracking issue.
- **Marketplace**: root `action.yml`, a composite action for the conventional `- uses: wei18/upkeep@<tag>` step syntax and a GitHub Marketplace listing. Same engine and inputs as the reusable workflow, but runs as a single job so reviewers execute sequentially instead of in parallel.
- **Local**: `scripts/local-audit.sh <target>` — same flow, `claude -p` subprocesses, temp-dir intermediates via `--add-dir`. Never creates issues; prints the summary instead. `skills/upkeep-audit/SKILL.md` is a thin wrapper (clones engine to `~/.cache/upkeep`, runs script, summarizes). The CI workflow does **not** route through the skill.

## Hard invariants

- **Output-only**: never edit or delete anything in the audited repo. No exceptions.
- **No presumed ground truth**: report divergence with evidence; don't assume code > docs or vice versa.
- Workflow interface (`with:` inputs, secrets, permissions) is a public contract — changes need a major version.

## Plugin / skill distribution

Three install paths, all pointing at `skills/upkeep-audit/`. Do not move that directory.

1. Claude Code plugin: `.claude-plugin/marketplace.json` (marketplace `upkeep`) → plugin `upkeep`, single-skill layout (SKILL.md at plugin root) → invocation `/upkeep:upkeep-audit`.
2. `npx skills add wei18/upkeep --skill upkeep-audit` — relies on the flat `skills/<name>/SKILL.md` layout and `name`+`description` frontmatter. Don't break either.
3. Manual copy into `~/.claude/skills/`.

The plugin version is stored in two files, which must hold the same value:

- `skills/upkeep-audit/.claude-plugin/plugin.json` (`version`)
- `.claude-plugin/marketplace.json` (`plugins[].version`)

## Change and release procedure

1. Work on a branch and open a PR against `main`. `main` rejects force-pushes.
2. Before pushing, run `npm run build && npm test`. CI (`.github/workflows/ci.yml`) runs the same two commands on every PR and on every push to `main`.
3. If the change touches the skill (`skills/upkeep-audit/`) or the reviewer prompts (`reviewers/`), bump the plugin version in both files listed above.
4. If the change touches a user-facing doc or a reviewer prompt, apply the two sync rules below.
5. Merge with a squash merge; it is the only merge method the repo allows. Dependabot patch and minor PRs merge themselves when build and tests pass (`.github/workflows/dependabot-auto-merge.yml`); major bumps wait for a manual merge.
6. After a merge that bumped the plugin version, tag the merge commit `v<version>` (for example `v2.1.1`) and publish a GitHub release for that tag.
7. After a merge that changes what `@v2` callers run (`src/`, `reviewers/`, `.github/actions/`, `.github/workflows/audit.yml`, `action.yml`), force-move the rolling tag on the new `main` commit: `git tag -fa v2 -m "v2 rolling release" && git push -f origin v2`. A Dependabot bump alone does not move it.

Tags:

- `v2` is the rolling annotated tag that callers pin.
- `v<version>` tags (`v2.1.0`, `v2.1.1`) each mark the commit that bumped the plugin to that version.
- `v1` is frozen. Never move it.

Self-audit issues on the repo are upserted tracking issues, not user bug reports. Close one with `Closes #N` in the fix commit.

## Docs: 5-locale sync

The English base is root `README.md` plus `docs/en/{overview,design,why-reusable-workflow}.md`. `docs/{zh-TW,zh-CN,ja,ko}/` each hold `README.md`, `overview.md`, `design.md` and `why-reusable-workflow.md`.

- A user-facing doc change lands in all 5 locales, with the same section structure, in the same PR.
- Fenced code blocks are byte-identical across locales, comments included. Never translate them. `test/locale-parity.test.ts` checks this.
- Reuse each file's established terminology; do not retranslate retained text. Known conventions: zh-TW audit=稽核, reviewer=審查員; zh-CN reviewer=审查器; ja formal です/ます register; ko: no space between an English/code token and its particle (`plugin이`, not `plugin 이`).
- `docs/archive/plans/` and `docs/superpowers/` are historical records. They are not localized and not current rules. Do not execute a plan from them.

## Reviewer prompts: en / zh-TW sync

`reviewers/en/` and `reviewers/zh-TW/` hold the same files.

- A change to one file lands in its counterpart in the same PR, line for line: same line count, same headings, lists and tables.
- The JSON field names and allowed values in the prompts come from `src/types.ts`. Do not change them in a prompt alone.
- `test/locale-parity.test.ts` checks both rules.

## Working conventions

- TS source in `src/`, tests in `test/` (vitest). TDD for behavior changes (failing test first — see `test/report.test.ts` fixture pattern).
- `dist/` is git-ignored, never committed; `npm run build` (tsc) is a type-check gate only — CI and the composite actions run `src/*.ts` directly via tsx.
- Degradation over crashing: malformed reviewer/JSON input becomes `{status: 'failed', findings: []}` via the finalize helpers in `src/finalize.ts` — follow that pattern for new parsers.
- When a change alters behavior, update `docs/en/design.md` and its four translations in the same PR.
- New specs go in `docs/superpowers/specs/`, new plans in `docs/superpowers/plans/` (dated, kebab-case). Once implemented they are historical records; `docs/en/design.md` is the current truth.
- Before relying on external tool behavior (plugin schema, CLI flags), verify against official docs — no trial-and-error reverse engineering.
- In-source comments in `src/` are English only, matching `README.md`'s en base.
