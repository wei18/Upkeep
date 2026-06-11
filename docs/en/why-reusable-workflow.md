# Why Upkeep is a reusable workflow (not a step action)

Most GitHub Actions are consumed as a **step**:

```yaml
steps:
  - uses: actions/checkout@v4
```

Upkeep is consumed as a **job**, pointing at a workflow file:

```yaml
jobs:
  audit:
    uses: wei18/upkeep/.github/workflows/audit.yml@v2
```

That second form looks unfamiliar next to the usual `- uses: owner/action@v1`, and people reasonably ask why. It is the standard, documented syntax for a **reusable workflow** (`on: workflow_call`) — see [GitHub: Reuse workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows). Here is why Upkeep is built that way.

## The reason: parallel, fault-isolated reviewers need `strategy.matrix`

Upkeep dispatches a team of reviewers. We want each reviewer to:

- run **in parallel** — a full audit should not take six times one reviewer's wall-clock; and
- be **fault-isolated** — one reviewer failing (timeout, API hiccup) must not abort the others.

The native GitHub primitive for "run the same unit many times, in parallel, independently" is `strategy.matrix`. **Matrix is a job-level feature**: only a *workflow* can declare jobs and a matrix. An *action* cannot. To fan the reviewers out across parallel, isolated matrix jobs, Upkeep must be a reusable workflow.

## Why not just ship an action?

There are two kinds of action, and neither can express that fan-out:

- **JavaScript / Docker action** — a single entrypoint (e.g. `main: dist/index.js`). It cannot `uses:` another action, so it could not delegate the LLM work to [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action); it would have to call Claude itself. And it still could not run jobs in parallel.
- **Composite action** — runs as a sequence of *steps* inside **one** job. It *can* `uses:` other actions (so it could call `claude-code-action`), but with no matrix the reviewers would run **sequentially**, in a single job.

So a composite action (`- uses: wei18/upkeep@v2`) *is* possible — at the cost of sequential reviewers. Upkeep deliberately chose the reusable-workflow form to keep reviewers parallel and independently isolated. For a scheduled audit, the slower sequential path would be acceptable; we preferred parallelism and clean failure isolation.

## What you actually give up

Only the call-site syntax. `jobs.<id>.uses: owner/repo/.github/workflows/file.yml@ref` instead of `- uses: owner/action@ref`. Everything else behaves like an action: inputs via `with:`, secrets via `secrets:`, version pinning with `@v1`.
