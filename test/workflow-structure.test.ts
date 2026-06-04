// test/workflow-structure.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const wf = parse(readFileSync(join(ROOT, '.github/workflows/audit.yml'), 'utf8'));

describe('audit reusable workflow structure', () => {
  it('is a reusable workflow requiring the anthropic secret', () => {
    expect(wf.on.workflow_call).toBeDefined();
    expect(wf.on.workflow_call.secrets.anthropic_api_key.required).toBe(true);
  });
  it('declares issues:write + contents:read permissions', () => {
    expect(wf.permissions.contents).toBe('read');
    expect(wf.permissions.issues).toBe('write');
  });
  it('wires discovery -> review(matrix) -> synthesis -> report', () => {
    expect(Object.keys(wf.jobs).sort()).toEqual(['discovery', 'report', 'review', 'synthesis']);
    expect(wf.jobs.review.needs).toContain('discovery');
    expect(wf.jobs.review.strategy['fail-fast']).toBe(false);
    expect(wf.jobs.review.strategy.matrix.reviewer).toContain('fromJSON');
    expect(wf.jobs.synthesis.needs).toContain('review');
    expect(wf.jobs.report.needs).toContain('synthesis');
    expect(String(wf.jobs.report.if)).toContain('always');
    expect(String(wf.jobs.synthesis.if)).toContain('always');
  });
});
