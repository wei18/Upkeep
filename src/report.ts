// src/report.ts
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { consolidate } from './consolidate.js';
import { finalizeReviewerOutput, finalizeSynthesis, readJsonOrNull } from './finalize.js';
import { renderHtml } from './report-html.js';
import { renderIssueMarkdown } from './report-issue.js';
import type { ReviewerName, ReviewerOutput, SynthesisOutput, Severity } from './types.js';

export function loadReviewerOutputs(findingsDir: string): ReviewerOutput[] {
  if (!existsSync(findingsDir)) return [];
  return readdirSync(findingsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      // a corrupt/invalid findings file degrades to a failed reviewer, never crashes the report
      const raw = readJsonOrNull(join(findingsDir, f));
      return finalizeReviewerOutput(raw, f.slice(0, -'.json'.length) as ReviewerName);
    });
}

export function loadSynthesis(path: string): SynthesisOutput | null {
  if (!existsSync(path)) return null;
  // a corrupt/invalid synthesis file degrades to a failed synthesis, never crashes the report
  return finalizeSynthesis(readJsonOrNull(path));
}

// CLI: report.ts <findingsDir> <synthesisJson|-> <outHtml> <outIssueMd> [inventoryJson]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [findingsDir, synPath, outHtml, outIssue, invPath] = process.argv.slice(2);
  const outputs = loadReviewerOutputs(findingsDir ?? 'findings');
  const synthesis = synPath && synPath !== '-' ? loadSynthesis(synPath) : null;
  const report = consolidate(outputs, synthesis, { generatedAtISO: new Date().toISOString() });
  let minSeverity: Severity = 'low';
  if (invPath && existsSync(invPath)) {
    minSeverity = (readJsonOrNull(invPath) as { config?: { report?: { minSeverity?: Severity } } } | null)?.config?.report?.minSeverity ?? 'low';
  }
  const runUrl = process.env.UPKEEP_RUN_URL || undefined;
  const artifactExpiresAtISO = process.env.UPKEEP_ARTIFACT_EXPIRES_AT || undefined;
  writeFileSync(outHtml ?? 'report.html', renderHtml(report));
  writeFileSync(outIssue ?? 'issue.md', renderIssueMarkdown(report, minSeverity, { runUrl, artifactExpiresAtISO, reportPath: outHtml }));
  process.stdout.write(`report: ${report.stats.total} findings, ${report.themes.length} themes, ${report.stats.failedReviewers.length} failed reviewers\n`);
}
