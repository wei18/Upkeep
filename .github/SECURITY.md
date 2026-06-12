# Security Policy

## Supported versions

Upkeep ships as a single moving major tag. Fixes land on the latest `v2`.

| Version | Supported |
|---|---|
| `v2` (latest) | ✅ |
| `v1` (frozen) | ❌ |
| older commits / tags | ❌ |

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

Use GitHub's private vulnerability reporting: the repo's **Security** tab → **Report a vulnerability**. You'll get an acknowledgement within a few days and updates as the fix progresses.

## Threat-model notes

- Upkeep is **output-only** — it reads your repo and writes a report; it never edits or deletes files.
- The only secret it needs is `CLAUDE_CODE_OAUTH_TOKEN`. Store it as a repo/environment secret and never commit it; secret-scanning push protection is enabled on this repo.
- Reviewers run as isolated matrix jobs via the official `claude-code-action`; findings are written as structured JSON and consolidated deterministically.
