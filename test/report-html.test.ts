// test/report-html.test.ts
import { describe, it, expect } from 'vitest';
import { renderHtml } from '../src/report-html.js';
import type { ConsolidatedReport } from '../src/types.js';

const report: ConsolidatedReport = {
  generatedAtISO: '2026-06-04T00:00:00Z',
  findings: [
    { file: 'README.md', related: [], reviewer: 'docs_staleness', reviewers: ['docs_staleness'],
      category: 'staleness', problem: 'has <script>alert(1)</script>', evidence: 'e', suggestion: 's',
      severity: 'high', confidence: 'high', ssot_direction: 'stale_a' },
  ],
  themes: [{ title: 'Drift', narrative: 'why', related_files: ['README.md'], priority: 'high' }],
  executiveSummary: 'overall ok',
  synthesisStatus: 'ok',
  stats: { total: 1, bySeverity: { high: 1, medium: 0, low: 0 }, byReviewer: { docs_staleness: 1 }, failedReviewers: [] },
};

describe('renderHtml', () => {
  it('is a self-contained html document', () => {
    const html = renderHtml(report);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
  });
  it('references no external resources (offline self-contained)', () => {
    const html = renderHtml(report);
    expect(/(src|href)\s*=\s*["']https?:/i.test(html)).toBe(false);
  });
  it('includes exec summary, theme, and finding file', () => {
    const html = renderHtml(report);
    expect(html).toContain('overall ok');
    expect(html).toContain('Drift');
    expect(html).toContain('README.md');
  });
  it('HTML-escapes dynamic text to prevent injection', () => {
    const html = renderHtml(report);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
  it('embeds a severity filter control', () => {
    expect(renderHtml(report)).toMatch(/data-f="high"/);
  });
});
