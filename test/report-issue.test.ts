// test/report-issue.test.ts
import { describe, it, expect } from 'vitest';
import { renderIssueMarkdown, ISSUE_MARKER } from '../src/report-issue.js';
import type { ConsolidatedReport } from '../src/types.js';

const report: ConsolidatedReport = {
  generatedAtISO: '2026-06-04T00:00:00Z',
  findings: [
    { file: 'README.md', related: [], reviewer: 'docs_staleness', reviewers: ['docs_staleness'],
      category: 'staleness', problem: 'pipe | in text', evidence: 'e', suggestion: 's',
      severity: 'high', confidence: 'high', ssot_direction: 'stale_a' },
  ],
  themes: [{ title: 'Drift', narrative: 'why', related_files: ['README.md'], priority: 'high' }],
  executiveSummary: 'overall ok',
  synthesisStatus: 'ok',
  stats: { total: 1, bySeverity: { high: 1, medium: 0, low: 0 }, byReviewer: { docs_staleness: 1 }, failedReviewers: ['i18n'] },
};

describe('renderIssueMarkdown', () => {
  it('includes the upsert marker', () => {
    expect(renderIssueMarkdown(report)).toContain(ISSUE_MARKER);
  });
  it('shows severity counts and total', () => {
    const md = renderIssueMarkdown(report);
    expect(md).toMatch(/High.*1/);
    expect(md).toMatch(/Total.*1/);
  });
  it('lists themes and the finding file', () => {
    const md = renderIssueMarkdown(report);
    expect(md).toContain('Drift');
    expect(md).toContain('README.md');
  });
  it('escapes pipes in table cells so the markdown table is not broken', () => {
    expect(renderIssueMarkdown(report)).toContain('pipe \\| in text');
  });
  it('warns about failed reviewers', () => {
    expect(renderIssueMarkdown(report)).toMatch(/i18n/);
  });
  it('flags the run INCOMPLETE when reviewers failed, so an empty result is not read as clean', () => {
    const md = renderIssueMarkdown(report);
    expect(md).toContain('INCOMPLETE');
    // the warning must come before the Summary table, not buried under it
    expect(md.indexOf('INCOMPLETE')).toBeLessThan(md.indexOf('## Summary'));
    expect(md).toMatch(/does not mean/i);
  });
  it('does not flag INCOMPLETE when every reviewer ran', () => {
    const r: ConsolidatedReport = {
      ...report,
      stats: { ...report.stats, failedReviewers: [] },
    };
    expect(renderIssueMarkdown(r)).not.toContain('INCOMPLETE');
  });
  it('escapes pipes in a file path so the table is not broken', () => {
    const r = { ...report, findings: [{ ...report.findings[0], file: 'src/a|b.ts' }] };
    expect(renderIssueMarkdown(r)).toContain('src/a\\|b.ts');
  });

  it('minSeverity filters lower-severity findings out of the issue and recomputes the summary', () => {
    const r: ConsolidatedReport = {
      ...report,
      findings: [
        { ...report.findings[0], file: 'hi.md', severity: 'high' },
        { ...report.findings[0], file: 'lo.md', severity: 'low' },
      ],
    };
    const md = renderIssueMarkdown(r, 'medium');
    expect(md).toContain('hi.md');
    expect(md).not.toContain('lo.md');
    expect(md).toMatch(/🟡 Low \| 0/);
    expect(md).toMatch(/\*\*Total\*\* \| \*\*1\*\*/);
  });

  it('default minSeverity (low) keeps every finding', () => {
    const r: ConsolidatedReport = {
      ...report,
      findings: [
        { ...report.findings[0], file: 'hi.md', severity: 'high' },
        { ...report.findings[0], file: 'lo.md', severity: 'low' },
      ],
    };
    const md = renderIssueMarkdown(r);
    expect(md).toContain('hi.md');
    expect(md).toContain('lo.md');
  });
});
