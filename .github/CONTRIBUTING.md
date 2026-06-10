# Contributing to Upkeep

Thanks for your interest! Upkeep is a reusable GitHub Actions workflow that audits a repo for doc/spec/asset drift using a team of AI reviewers.

## Local development

```bash
npm ci
npm test       # vitest (unit + contract)
npm run build  # tsc — run this too; vitest does not type-check
```

## Conventions

- **The spec is the SSOT.** `docs/en/design.md` is authoritative; keep code and spec in sync — this tool exists to catch drift, so the spec must not drift.
- **Docs are multilingual and stay in lockstep.** User docs live under `docs/<locale>/` (en, zh-TW, zh-CN, ja, ko). A change to one locale's README/overview/design/why-reusable-workflow must be propagated to all five.
- **Reviewer rubrics** live under `reviewers/<locale>/`, selected by the `rubric_lang` input.
- **Working specs/plans** live under `docs/superpowers/` (en-only design-process artifacts; intentionally outside the locale lockstep and unlinked from user-facing navigation).
- **TDD** — write a failing test first, and cover known edge cases (especially for any heuristic).
- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`).

## The dogfood self-audit

Upkeep audits itself on a schedule (`.github/workflows/self-audit.yml`) and upserts a tracking issue. If your change touches docs, specs, or assets, expect the next audit to check it.

## Pull requests

Keep changes surgical and tests green (`npm test` + `npm run build`). When you change behavior, update the relevant section of `docs/en/design.md` in the same PR.
