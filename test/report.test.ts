// test/report.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReviewerOutputs, loadSynthesis } from '../src/report.js';
import { consolidate } from '../src/consolidate.js';
import { renderHtml } from '../src/report-html.js';
import { renderIssueMarkdown } from '../src/report-issue.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rep-'));
  const fdir = join(dir, 'findings');
  mkdirSync(fdir);
  writeFileSync(join(fdir, 'docs_staleness.json'), JSON.stringify({
    reviewer: 'docs_staleness', status: 'ok',
    findings: [{ file: 'README.md', related: [], reviewer: 'docs_staleness', category: 'staleness',
      problem: 'p', evidence: 'e', suggestion: 's', severity: 'high', confidence: 'high', ssot_direction: 'stale_a' }],
  }));
  writeFileSync(join(fdir, 'i18n.json'), JSON.stringify({ reviewer: 'i18n', status: 'failed', findings: [] }));
  writeFileSync(join(dir, 'synthesis.json'), JSON.stringify({
    themes: [{ title: 'Drift', narrative: 'n', related_files: ['README.md'], priority: 'high' }],
    semantic_duplicates: [], executive_summary: 'sum', status: 'ok',
  }));
  return { dir, fdir };
}

describe('report pipeline', () => {
  it('loads reviewer outputs from a directory (sorted, json only)', () => {
    const { fdir } = fixture();
    const outs = loadReviewerOutputs(fdir);
    expect(outs.map((o) => o.reviewer)).toEqual(['docs_staleness', 'i18n']);
  });

  it('a corrupt findings file becomes a failed reviewer instead of crashing the load', () => {
    const { fdir } = fixture();
    writeFileSync(join(fdir, 'convention.json'), '{ this is not json');
    const outs = loadReviewerOutputs(fdir);
    expect(outs.map((o) => o.reviewer)).toEqual(['convention', 'docs_staleness', 'i18n']);
    expect(outs[0]).toEqual({ reviewer: 'convention', status: 'failed', findings: [] });
  });

  it('loadSynthesis returns null when file absent', () => {
    expect(loadSynthesis(join(tmpdir(), 'no-such-synthesis.json'))).toBeNull();
  });

  it('a corrupt synthesis file degrades to a failed synthesis instead of crashing', () => {
    const { dir } = fixture();
    writeFileSync(join(dir, 'synthesis.json'), '{ this is not json');
    expect(loadSynthesis(join(dir, 'synthesis.json')))
      .toEqual({ themes: [], semantic_duplicates: [], executive_summary: '', status: 'failed' });
  });

  it('a synthesis file with an invalid shape degrades to a failed synthesis', () => {
    const { dir } = fixture();
    writeFileSync(join(dir, 'synthesis.json'), JSON.stringify({ themes: 'nope' }));
    expect(loadSynthesis(join(dir, 'synthesis.json')))
      .toEqual({ themes: [], semantic_duplicates: [], executive_summary: '', status: 'failed' });
  });

  it('end-to-end: load → consolidate → render produces report with theme and finding', () => {
    const { dir, fdir } = fixture();
    const outs = loadReviewerOutputs(fdir);
    const syn = loadSynthesis(join(dir, 'synthesis.json'));
    const report = consolidate(outs, syn, { generatedAtISO: 't' });

    expect(report.stats.failedReviewers).toEqual(['i18n']);
    expect(report.findings.length).toBe(1);
    expect(report.themes.length).toBe(1);

    const html = renderHtml(report);
    const md = renderIssueMarkdown(report);
    expect(html).toContain('README.md');
    expect(md).toContain('Drift');
  });
});
