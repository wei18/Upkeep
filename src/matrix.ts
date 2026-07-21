// src/matrix.ts
import { writeFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import type { AuditConfig, ReviewerName } from './types.js';

export function enabledReviewers(config: AuditConfig): ReviewerName[] {
  return (Object.keys(config.reviewers) as ReviewerName[]).filter((r) => config.reviewers[r].enabled);
}

// CLI: matrix.ts <repoRoot> [outFile]
// Prints `reviewers=<json-array>` (no outFile -> stdout; with one -> appends, for >> $GITHUB_OUTPUT)
if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const line = `reviewers=${JSON.stringify(enabledReviewers(loadConfig(repoRoot)))}\n`;
  const outFile = process.argv[3];
  if (outFile) writeFileSync(outFile, line, { flag: 'a' });
  else process.stdout.write(line);
}
