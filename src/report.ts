// src/report.ts
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { consolidate } from './consolidate.js';
import { renderHtml } from './report-html.js';
import { renderIssueMarkdown } from './report-issue.js';
import type { ReviewerOutput, SynthesisOutput, Severity } from './types.js';

export function loadReviewerOutputs(findingsDir: string): ReviewerOutput[] {
  if (!existsSync(findingsDir)) return [];
  return readdirSync(findingsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(findingsDir, f), 'utf8')) as ReviewerOutput);
}

export function loadSynthesis(path: string): SynthesisOutput | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as SynthesisOutput) : null;
}

// CLI: report.ts <findingsDir> <synthesisJson|-> <outHtml> <outIssueMd> [inventoryJson]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [findingsDir, synPath, outHtml, outIssue, invPath] = process.argv.slice(2);
  const outputs = loadReviewerOutputs(findingsDir ?? 'findings');
  const synthesis = synPath && synPath !== '-' ? loadSynthesis(synPath) : null;
  const report = consolidate(outputs, synthesis, { generatedAtISO: new Date().toISOString() });
  let minSeverity: Severity = 'low';
  if (invPath && existsSync(invPath)) {
    try { minSeverity = JSON.parse(readFileSync(invPath, 'utf8'))?.config?.report?.minSeverity ?? 'low'; } catch { /* keep default */ }
  }
  const runUrl = process.env.UPKEEP_RUN_URL || undefined;
  const artifactExpiresAtISO = process.env.UPKEEP_ARTIFACT_EXPIRES_AT || undefined;
  writeFileSync(outHtml ?? 'report.html', renderHtml(report));
  writeFileSync(outIssue ?? 'issue.md', renderIssueMarkdown(report, minSeverity, { runUrl, artifactExpiresAtISO }));
  process.stdout.write(`report: ${report.stats.total} findings, ${report.themes.length} themes, ${report.stats.failedReviewers.length} failed reviewers\n`);
}
