// test/consolidate.test.ts
import { describe, it, expect } from 'vitest';
import { consolidate } from '../src/consolidate.js';
import type { ReviewerOutput, Finding, SynthesisOutput } from '../src/types.js';

function f(over: Partial<Finding>): Finding {
  return {
    file: 'README.md', related: [], reviewer: 'docs_staleness', category: 'staleness',
    problem: 'p', evidence: 'e', suggestion: 's', severity: 'low', confidence: 'low',
    ssot_direction: 'n/a', ...over,
  };
}
const OPTS = { generatedAtISO: '2026-06-04T00:00:00Z' };

describe('consolidate', () => {
  it('merges same file+category across reviewers, union reviewers, keeps higher severity', () => {
    const outputs: ReviewerOutput[] = [
      { reviewer: 'docs_staleness', status: 'ok', findings: [f({ severity: 'low', confidence: 'low' })] },
      { reviewer: 'convention', status: 'ok', findings: [f({ reviewer: 'convention', severity: 'high', confidence: 'medium' })] },
    ];
    const r = consolidate(outputs, null, OPTS);
    expect(r.findings.length).toBe(1);
    expect(r.findings[0].severity).toBe('high');
    expect(r.findings[0].reviewers.sort()).toEqual(['convention', 'docs_staleness']);
  });

  it('breaks representative ties by REVIEWER_NAMES order, not input/file order (design §4)', () => {
    // convention (rank 5) is first in input; on an exact severity×confidence tie,
    // code_hygiene (rank 1) must win the representative slot.
    const outputs: ReviewerOutput[] = [
      { reviewer: 'convention', status: 'ok', findings: [f({ file: 'x.ts', category: 'inconsistency', reviewer: 'convention', problem: 'from-convention', severity: 'high', confidence: 'high' })] },
      { reviewer: 'code_hygiene', status: 'ok', findings: [f({ file: 'x.ts', category: 'inconsistency', reviewer: 'code_hygiene', problem: 'from-code_hygiene', severity: 'high', confidence: 'high' })] },
    ];
    const r = consolidate(outputs, null, OPTS);
    expect(r.findings.length).toBe(1);
    expect(r.findings[0].reviewer).toBe('code_hygiene');
    expect(r.findings[0].problem).toBe('from-code_hygiene');
  });

  it('does not merge different categories on the same file', () => {
    const outputs: ReviewerOutput[] = [
      { reviewer: 'docs_staleness', status: 'ok', findings: [f({ category: 'staleness' })] },
      { reviewer: 'duplicate_orphan', status: 'ok', findings: [f({ reviewer: 'duplicate_orphan', category: 'orphan' })] },
    ];
    expect(consolidate(outputs, null, OPTS).findings.length).toBe(2);
  });

  it('sorts by severity desc, then confidence desc, then file asc', () => {
    const outputs: ReviewerOutput[] = [{
      reviewer: 'docs_staleness', status: 'ok', findings: [
        f({ file: 'b.md', severity: 'low', confidence: 'high' }),
        f({ file: 'a.md', category: 'orphan', severity: 'high', confidence: 'low' }),
        f({ file: 'c.md', category: 'duplicate', severity: 'high', confidence: 'high' }),
      ],
    }];
    const order = consolidate(outputs, null, OPTS).findings.map((x) => x.file);
    expect(order).toEqual(['c.md', 'a.md', 'b.md']);
  });

  it('records failed reviewers and excludes them from findings', () => {
    const outputs: ReviewerOutput[] = [
      { reviewer: 'docs_staleness', status: 'ok', findings: [f({})] },
      { reviewer: 'i18n', status: 'failed', findings: [] },
    ];
    const r = consolidate(outputs, null, OPTS);
    expect(r.stats.failedReviewers).toEqual(['i18n']);
    expect(r.findings.length).toBe(1);
  });

  it('computes severity and reviewer stats', () => {
    const outputs: ReviewerOutput[] = [{
      reviewer: 'docs_staleness', status: 'ok', findings: [
        f({ file: 'a.md', severity: 'high' }), f({ file: 'b.md', category: 'orphan', severity: 'low' }),
      ],
    }];
    const s = consolidate(outputs, null, OPTS).stats;
    expect(s.total).toBe(2);
    expect(s.bySeverity).toEqual({ high: 1, medium: 0, low: 1 });
    expect(s.byReviewer.docs_staleness).toBe(2);
  });

  it('carries synthesis when status ok; marks absent when null', () => {
    const syn: SynthesisOutput = {
      themes: [{ title: 'T', narrative: 'N', related_files: ['a.md'], priority: 'high' }],
      semantic_duplicates: [], executive_summary: 'sum', status: 'ok',
    };
    const ok = consolidate([], syn, OPTS);
    expect(ok.themes.length).toBe(1);
    expect(ok.executiveSummary).toBe('sum');
    expect(ok.synthesisStatus).toBe('ok');

    const none = consolidate([], null, OPTS);
    expect(none.synthesisStatus).toBe('absent');
    expect(none.themes).toEqual([]);
  });

  it('drops synthesis content when synthesis failed', () => {
    const syn: SynthesisOutput = { themes: [], semantic_duplicates: [], executive_summary: '', status: 'failed' };
    const r = consolidate([], syn, OPTS);
    expect(r.synthesisStatus).toBe('failed');
    expect(r.themes).toEqual([]);
  });
});
