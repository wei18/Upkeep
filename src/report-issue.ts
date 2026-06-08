// src/report-issue.ts
import type { ConsolidatedReport, Severity } from './types.js';
import { SEVERITY_RANK } from './types.js';

export const ISSUE_MARKER = '<!-- upkeep:report -->';

export interface IssueRenderOpts {
  runUrl?: string;              // direct link to the workflow run hosting the report-html artifact
  artifactExpiresAtISO?: string; // artifact expiry (per the repo's gh retention setting)
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function footer(report: ConsolidatedReport, opts: IssueRenderOpts): string {
  if (!opts.runUrl) return '_Full interactive report: see the workflow run HTML artifact._';
  let line = `_Full interactive HTML report: [open this run](${opts.runUrl}) → download the \`report-html\` artifact`;
  if (opts.artifactExpiresAtISO) {
    const days = Math.round(
      (new Date(opts.artifactExpiresAtISO).getTime() - new Date(report.generatedAtISO).getTime()) / 86_400_000,
    );
    if (Number.isFinite(days) && days > 0) line += ` (expires ${opts.artifactExpiresAtISO.slice(0, 10)}, ~${days}d)`;
  }
  return `${line}._`;
}

export function renderIssueMarkdown(
  report: ConsolidatedReport,
  minSeverity: Severity = 'low',
  opts: IssueRenderOpts = {},
): string {
  // Findings below minSeverity stay out of the issue (the HTML report keeps everything).
  const findings = report.findings.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[minSeverity]);
  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) bySeverity[f.severity]++;
  const s = { ...report.stats, total: findings.length, bySeverity };
  const L: string[] = [];
  L.push(ISSUE_MARKER);
  L.push('# 🔍 Upkeep Report');
  L.push('');
  L.push(`_Generated ${report.generatedAtISO}_`);
  L.push('');
  if (s.failedReviewers.length > 0) {
    L.push(`> ⚠️ **INCOMPLETE RUN** — ${s.failedReviewers.length} reviewer(s) failed (${s.failedReviewers.join(', ')}). `
      + 'Findings below are partial; an empty or low count **does not mean the repo is clean.**');
    L.push('');
  }
  if (report.synthesisStatus !== 'ok') {
    L.push(`> Synthesis ${report.synthesisStatus} — showing raw findings only.`);
    L.push('');
  }
  if (report.executiveSummary) {
    L.push(report.executiveSummary);
    L.push('');
  }
  L.push('## Summary');
  L.push('');
  L.push('| Severity | Count |');
  L.push('|---|---|');
  L.push(`| 🔴 High | ${s.bySeverity.high} |`);
  L.push(`| 🟠 Medium | ${s.bySeverity.medium} |`);
  L.push(`| 🟡 Low | ${s.bySeverity.low} |`);
  L.push(`| **Total** | **${s.total}** |`);
  L.push('');
  if (report.themes.length > 0) {
    L.push('## Themes');
    L.push('');
    for (const t of report.themes) {
      L.push(`### ${t.priority.toUpperCase()} — ${cell(t.title)}`);
      L.push(cell(t.narrative));
      if (t.related_files.length > 0) {
        L.push(`Files: ${t.related_files.map((f) => `\`${f}\``).join(', ')}`);
      }
      L.push('');
    }
  }
  L.push('## Findings');
  L.push('');
  L.push('| Severity | Conf | File | Category | Reviewers | Problem |');
  L.push('|---|---|---|---|---|---|');
  for (const f of findings) {
    L.push(`| ${f.severity} | ${f.confidence} | \`${cell(f.file)}\` | ${f.category} | ${f.reviewers.join(', ')} | ${cell(f.problem)} |`);
  }
  L.push('');
  L.push(footer(report, opts));
  return L.join('\n');
}
