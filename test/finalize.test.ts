// test/finalize.test.ts
import { describe, it, expect } from 'vitest';
import { finalizeReviewerOutput, finalizeSynthesis } from '../src/finalize.js';

const goodReviewer = {
  reviewer: 'docs_staleness', status: 'ok',
  findings: [{ file: 'README.md', related: [], reviewer: 'docs_staleness', category: 'staleness',
    problem: 'p', evidence: 'e', suggestion: 's', severity: 'low', confidence: 'low', ssot_direction: 'n/a' }],
};

describe('finalizeReviewerOutput', () => {
  it('passes a valid matching output through', () => {
    expect(finalizeReviewerOutput(goodReviewer, 'docs_staleness')).toEqual(goodReviewer);
  });
  it('falls back to failed when raw is null', () => {
    expect(finalizeReviewerOutput(null, 'i18n')).toEqual({ reviewer: 'i18n', status: 'failed', findings: [] });
  });
  it('falls back when raw is invalid', () => {
    expect(finalizeReviewerOutput({ reviewer: 'docs_staleness', status: 'nope', findings: [] }, 'docs_staleness').status).toBe('failed');
  });
  it('falls back when reviewer name mismatches', () => {
    expect(finalizeReviewerOutput(goodReviewer, 'convention')).toEqual({ reviewer: 'convention', status: 'failed', findings: [] });
  });
});

describe('finalizeSynthesis', () => {
  const goodSyn = { themes: [], semantic_duplicates: [], executive_summary: 'ok', status: 'ok' };
  it('passes a valid synthesis through', () => {
    expect(finalizeSynthesis(goodSyn)).toEqual(goodSyn);
  });
  it('falls back to failed when invalid/null', () => {
    expect(finalizeSynthesis(null)).toEqual({ themes: [], semantic_duplicates: [], executive_summary: '', status: 'failed' });
    expect(finalizeSynthesis({ themes: 'x' }).status).toBe('failed');
  });
});
