// test/config.test.ts
import { describe, it, expect } from 'vitest';
import { defaultConfig, mergeConfig, loadConfig } from '../src/config.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('config', () => {
  it('default enables 6 reviewers and disables i18n', () => {
    const c = defaultConfig();
    expect(c.reviewers.docs_staleness.enabled).toBe(true);
    expect(c.reviewers.i18n.enabled).toBe(false);
    expect(c.report.issueLabel).toBe('audit');
    expect(c.report.minSeverity).toBe('low');
  });

  it('partial yaml overrides only specified fields', () => {
    const merged = mergeConfig(defaultConfig(), {
      reviewers: { visual_icon: { enabled: false }, i18n: { enabled: true } },
      report: { issueLabel: 'health' },
    });
    expect(merged.reviewers.visual_icon.enabled).toBe(false);
    expect(merged.reviewers.i18n.enabled).toBe(true);
    expect(merged.reviewers.code_hygiene.enabled).toBe(true);
    expect(merged.report.issueLabel).toBe('health');
    expect(merged.report.minSeverity).toBe('low');
  });

  it('loadConfig returns defaults when file absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    expect(loadConfig(dir)).toEqual(defaultConfig());
  });

  it('loadConfig parses .claude/audit.yml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude/audit.yml'),
      'version: 1\nreviewers:\n  i18n:\n    enabled: true\n');
    expect(loadConfig(dir).reviewers.i18n.enabled).toBe(true);
  });
});
